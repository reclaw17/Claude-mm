// 页面调后台的接口：POST /__codex_plus/api/v1/<op>（页面运行时 page-runtime.js 的 request）。
//
// 鉴权分两层。第一层挡别的来源、别的进程：必须是 Claude 主域上的同源 POST，带本次启动的随机令牌。
// 第二层把页面能做的事限制到「启用中的拓展声明过的」：包要在注入计划里，后台方法要在它的
// claudeDesktop.methods 里，路由要既在它的 permissions.routes 里、又在 Claude 开放的路由里。
// 注意第二层是声明约束，不是拓展之间的隔离：页面里的官方脚本和拓展脚本同权，令牌对它们藏不住。
// 所以密钥类配置不下发页面，只给后台。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

export const PAGE_API_PREFIX = "/__codex_plus/api/v1/";
export const PAGE_ROUTES = new Set(["/diagnostics/log", "/backend/status"]);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT_PER_PACKAGE = 16;
const OPS = new Set(["call", "events", "stop", "route", "status", "config"]);
const METHOD = /^(?!__)[A-Za-z0-9_.-]{1,128}$/;
const RECEIPT_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PageApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sameToken(given, expected) {
  const left = Buffer.from(String(given ?? ""));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** 第一层：请求头。通过返回 null，否则返回拒绝的原因。 */
export function rejectRequest(req, { token, origins }) {
  if (req.method !== "POST") return new PageApiError(405, "只接受 POST");
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return new PageApiError(415, "请求体必须是 JSON");
  if (req.headers["sec-fetch-site"] !== "same-origin") return new PageApiError(403, "只接受页面自己的同源请求");
  if (!origins.has(String(req.headers.origin || ""))) return new PageApiError(403, "来源不对");
  if (!sameToken(req.headers["x-codex-plus-ext"], token)) return new PageApiError(403, "令牌不对");
  return null;
}

/** 页面回报的加载结果只留认识的字段，免得状态文件被塞大。 */
function cleanStatus(body) {
  const scripts = {};
  for (const [key, value] of Object.entries(body?.scripts && typeof body.scripts === "object" ? body.scripts : {}).slice(0, 128)) {
    if (!value || typeof value !== "object" || key.length > 160) continue;
    scripts[key] = {
      status: ["pending", "loading", "loaded", "failed"].includes(value.status) ? value.status : "pending",
      error: String(value.error || "").slice(0, 4000),
      unsupported: (Array.isArray(value.unsupported) ? value.unsupported : []).filter((item) => typeof item === "string").slice(0, 64).map((item) => item.slice(0, 120)),
      loadedAt: String(value.loadedAt || "").slice(0, 40),
    };
  }
  const mounts = {};
  for (const [name, value] of Object.entries(body?.mounts && typeof body.mounts === "object" ? body.mounts : {}).slice(0, 128)) {
    if (name.length <= 120 && ["string", "boolean", "number"].includes(typeof value)) mounts[name] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  return { scripts, mounts, at: new Date().toISOString() };
}

/**
 * plan：createPagePlan 的结果；backends：createBackendHost 的结果（没有外部托管方时用）；
 * hostReceipt：外部托管方（Codex++ 的 helper）写的凭据文件路径，给了就把后台相关的调用转过去。
 */
export function createPageApi({ plan, backends, token, origins, statusFile, hostReceipt = "", isPrivate = () => true, log = () => {} }) {
  const inFlight = new Map();

  function readReceipt() {
    try {
      if (!isPrivate(fs.lstatSync(hostReceipt))) return null;
      const receipt = JSON.parse(fs.readFileSync(hostReceipt, "utf8"));
      if (!Number.isInteger(receipt.port) || receipt.port < 1 || receipt.port > 65535 || typeof receipt.token !== "string" || !RECEIPT_TOKEN.test(receipt.token)) return null;
      return receipt;
    } catch {
      return null;
    }
  }

  /** 转给外部托管方：POST http://127.0.0.1:<port>/claude-ext/v1/<op>，回应同样是 { ok, result } / { ok: false, error, code }。 */
  function forward(op, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const receipt = readReceipt();
      if (!receipt) {
        reject(new PageApiError(503, "拓展后台由 Codex++ 托管，但它没有在运行：请先启动 Codex++", "host_offline"));
        return;
      }
      const payload = Buffer.from(JSON.stringify(body));
      // 走 node:http 直连回环：本进程可能挂着系统代理，回环请求不该被它接管。
      const request = http.request({
        host: "127.0.0.1", port: receipt.port, method: "POST", path: `/claude-ext/v1/${op}`,
        headers: { "content-type": "application/json", "content-length": payload.length, "x-codex-plus-claude-ext": receipt.token },
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESULT_BYTES) request.destroy(new Error("后台返回的内容太大"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          let reply = null;
          try { reply = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
          if (reply && reply.ok === true) resolve(reply.result ?? null);
          else reject(new PageApiError(response.statusCode >= 400 ? response.statusCode : 502, String(reply?.error || `Codex++ 返回 ${response.statusCode}`), reply?.code));
        });
      });
      request.on("error", (error) => reject(new PageApiError(502, `连不上 Codex++ 的拓展后台：${error.message}`, "host_offline")));
      request.setTimeout(timeoutMs, () => request.destroy(new Error("超时")));
      request.end(payload);
    });
  }

  function packageOf(body) {
    const key = typeof body?.key === "string" ? body.key : "";
    const item = key ? plan.package(key) : null;
    if (!item) throw new PageApiError(403, "这个拓展没有启用", "not_enabled");
    return item;
  }

  async function limited(key, run) {
    const count = inFlight.get(key) || 0;
    if (count >= MAX_CONCURRENT_PER_PACKAGE) throw new PageApiError(429, "这个拓展同时进行的调用太多", "busy");
    inFlight.set(key, count + 1);
    try {
      return await run();
    } finally {
      const left = (inFlight.get(key) || 1) - 1;
      if (left) inFlight.set(key, left);
      else inFlight.delete(key);
    }
  }

  const ops = {
    async call(body) {
      const item = packageOf(body);
      const method = String(body.method ?? "");
      if (!METHOD.test(method) || method === "constructor" || method === "prototype" || !item.methods?.includes(method)) {
        throw new PageApiError(403, `拓展 ${item.id} 没有在 claudeDesktop.methods 里声明后台方法：${method}`, "unsupported");
      }
      if (!item.backend) throw new PageApiError(403, `拓展 ${item.id} 没有声明后台`, "unsupported");
      const timeoutMs = Number.isFinite(body.timeoutMs) ? Number(body.timeoutMs) : undefined;
      return limited(item.key, () => hostReceipt
        ? forward("call", { key: item.key, method, params: body.params ?? null, timeoutMs, instance: body.instance }, 28000)
        : backends.call({ key: item.key, id: item.id, backend: item.backend, config: item.config, dataDir: item.dataDir }, method, body.params ?? null, timeoutMs));
    },
    async events(body) {
      const item = packageOf(body);
      const since = body.since === "latest" ? "latest" : Math.max(0, Number(body.since) || 0);
      const waitMs = Math.min(Math.max(Number(body.waitMs) || 0, 0), 20000);
      return hostReceipt ? forward("events", { key: item.key, since, waitMs }, waitMs + 8000) : backends.events(item.key, since, waitMs);
    },
    /** 页面实例卸载时发来的 stop 在 Claude 下不停后台：Code 会话可能还在用同一个实例。 */
    async stop(body) {
      packageOf(body);
      return { stopped: false };
    },
    async route(body) {
      const item = packageOf(body);
      const route = String(body.route ?? "");
      if (!PAGE_ROUTES.has(route)) throw new PageApiError(403, `路由 ${route} 在 Claude Desktop 里没有开放`, "unsupported");
      if (!item.routes?.includes(route)) throw new PageApiError(403, `拓展 ${item.id} 未在 codexpp.json 声明路由权限：${route}`, "unsupported");
      if (route === "/backend/status") return { status: "ok", host: "claudeDesktop", connected: true };
      log(`[拓展 ${item.id}] ${JSON.stringify(body.payload ?? null).slice(0, 2000)}`);
      return { status: "ok" };
    },
    async status(body) {
      if (statusFile) {
        try {
          fs.writeFileSync(statusFile, JSON.stringify(cleanStatus(body)), { mode: 0o600 });
        } catch (error) {
          log(`写不了拓展状态：${error.message}`);
        }
      }
      // 顺手把已经不在计划里的后台停掉（拓展被停用、删除）。
      if (!hostReceipt) backends.retain(plan.keys());
      return { saved: true };
    },
    async config(body) {
      const item = packageOf(body);
      if (hostReceipt) return forward("config", { key: item.key, values: body.values ?? {} }, 12000);
      throw new PageApiError(501, "还不能在 Claude 页面里改拓展的配置，请到扩展页里改", "unsupported");
    },
  };

  return {
    /** 处理一次请求（调用前已经确认是 Claude 主域、路径以 PAGE_API_PREFIX 开头）。 */
    handle(req, res, pathname) {
      const reply = (status, body) => {
        const payload = Buffer.from(JSON.stringify(body));
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": payload.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(payload);
      };
      const fail = (error) => reply(error.status || 500, { ok: false, error: String(error.message || error), ...(error.code ? { code: error.code } : {}) });
      const op = pathname.slice(PAGE_API_PREFIX.length);
      const rejected = OPS.has(op) ? rejectRequest(req, { token, origins }) : new PageApiError(404, "没有这个接口");
      if (rejected) {
        req.resume();
        return fail(rejected);
      }
      const chunks = [];
      let size = 0;
      let over = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) over = true;
        else chunks.push(chunk);
      });
      req.on("error", () => {});
      req.on("end", () => {
        if (over) return fail(new PageApiError(413, "请求体太大"));
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return fail(new PageApiError(400, "请求体不是合法的 JSON"));
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return fail(new PageApiError(400, "请求体必须是对象"));
        Promise.resolve()
          .then(() => ops[op](body))
          .then((result) => {
            const payload = { ok: true, result: result === undefined ? null : result };
            if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RESULT_BYTES) return fail(new PageApiError(502, "后台返回的内容太大"));
            reply(200, payload);
          }, (error) => fail(error instanceof PageApiError ? error : new PageApiError(502, String(error?.message || error))));
      });
    },
  };
}
