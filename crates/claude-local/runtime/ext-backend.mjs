// 拓展后台的托管器：按需起 Node 进程跑拓展包的 backend.script（运行器见 ext-backend-runner.mjs），
// 之后常驻；脚本或配置变了就重起，空闲久了、本地服务退出时停掉。
//
// 只在没有外部托管方时用（单独的 ClaudeMom）。Codex++ 自己托管后台，本地服务把调用转给它（见 page-api.mjs），
// 这样同一个拓展在页面、Code 会话里用到的是同一个后台实例。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const EVENT_QUEUE_LIMIT = 200;
const READY_TIMEOUT_MS = 15000;
const IDLE_STOP_MS = 30 * 60 * 1000;
export const DEFAULT_CALL_TIMEOUT_MS = 20000;
export const MAX_CALL_TIMEOUT_MS = 24000;
export const MAX_EVENT_WAIT_MS = 20000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** 后台进程的环境：去掉本地服务自己的变量（里面有上游的 Key）。 */
export function backendEnv(env = process.env) {
  const clean = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^(CLAUDE_LOCAL_|CODEX_PLUS_|ANTHROPIC_)/i.test(name)) continue;
    clean[name] = value;
  }
  return clean;
}

function fingerprint(spec) {
  let modified = 0;
  try { modified = fs.statSync(spec.backend).mtimeMs; } catch {}
  return `${spec.backend}|${modified}|${JSON.stringify(spec.config ?? {})}`;
}

/**
 * spec：{ key, id, backend（脚本绝对路径）, config, dataDir }，来自注入计划里的包。
 * runner 是运行器脚本的路径，node 默认用跑本地服务的这个 Node。
 */
export function createBackendHost({ runner, node = process.execPath, log = () => {}, idleStopMs = IDLE_STOP_MS } = {}) {
  const slots = new Map();
  let eventSeq = 0;

  function drop(key, reason) {
    const slot = slots.get(key);
    if (!slot) return;
    slots.delete(key);
    clearTimeout(slot.idleTimer);
    for (const pending of slot.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason || "拓展后台已退出"));
    }
    slot.pending.clear();
    for (const wake of slot.waiters.splice(0)) wake();
    try { slot.child.kill(); } catch {}
  }

  function touch(slot) {
    clearTimeout(slot.idleTimer);
    if (idleStopMs > 0) {
      slot.idleTimer = setTimeout(() => {
        if (!slot.pending.size) drop(slot.key, "拓展后台空闲已停止");
        else touch(slot);
      }, idleStopMs);
      slot.idleTimer.unref?.();
    }
  }

  function start(spec, wanted) {
    return new Promise((resolve, reject) => {
      try {
        fs.mkdirSync(spec.dataDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        reject(new Error(`无法创建拓展数据目录 ${spec.dataDir}：${error.message}`));
        return;
      }
      let child;
      try {
        child = spawn(node, [runner], { cwd: spec.dataDir, env: backendEnv(), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      } catch (error) {
        reject(new Error(`无法启动拓展后台：${error.message}`));
        return;
      }
      const slot = { key: spec.key, child, fingerprint: wanted, pending: new Map(), events: [], waiters: [], nextId: 1, idleTimer: null };
      let settled = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        if (error) {
          try { child.kill(); } catch {}
          reject(error);
        } else {
          slots.set(spec.key, slot);
          touch(slot);
          resolve(slot);
        }
      };
      const readyTimer = setTimeout(() => settle(new Error("拓展后台 15 秒内没有就绪")), READY_TIMEOUT_MS);
      child.on("error", (error) => settle(new Error(`无法启动拓展后台：${error.message}`)));
      child.on("exit", () => {
        settle(new Error("拓展后台启动后立即退出"));
        if (slots.get(spec.key) === slot) drop(spec.key);
      });
      child.stdin.on("error", () => {});
      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (line.length > MAX_LINE_BYTES) return;
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (!message || typeof message !== "object") return;
        if (typeof message.host === "number") {
          // 后台的宿主调用（会话、界面、模型、别的后台的服务）在这里都没有对应物。
          child.stdin.write(JSON.stringify({ hostReply: message.host, error: `${message.service || "宿主"}.${message.method || ""} 在 Claude Desktop 里不可用` }) + "\n");
        } else if (typeof message.id === "number") {
          const pending = slot.pending.get(message.id);
          if (!pending) return;
          slot.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (typeof message.error === "string") pending.reject(new Error(message.error));
          else pending.resolve(message.result ?? null);
        } else if (typeof message.event === "string") {
          const seq = ++eventSeq;
          slot.events.push({ seq, event: message.event, payload: message.payload ?? null });
          while (slot.events.length > EVENT_QUEUE_LIMIT) slot.events.shift();
          for (const wake of slot.waiters.splice(0)) wake();
        } else if (message.ready) {
          settle();
        } else if (typeof message.fatal === "string") {
          settle(new Error(`拓展后台启动失败：${message.fatal}`));
        }
      });
      child.stdin.write(JSON.stringify({ script: spec.backend, extension: spec.id, config: spec.config ?? {}, dataDir: spec.dataDir, host: "claudeDesktop" }) + "\n");
    });
  }

  const starting = new Map();
  async function ensure(spec) {
    const wanted = fingerprint(spec);
    const existing = slots.get(spec.key);
    if (existing && existing.fingerprint === wanted) return existing;
    if (existing) drop(spec.key, "拓展后台已按新的脚本或配置重启");
    // 同时来的几次调用共用一次启动。
    if (!starting.has(spec.key)) {
      const attempt = start(spec, wanted).finally(() => starting.delete(spec.key));
      starting.set(spec.key, attempt);
      attempt.catch((error) => log(`拓展后台 ${spec.key} 没起来：${error.message}`));
    }
    return starting.get(spec.key);
  }

  return {
    async call(spec, method, params, timeoutMs) {
      const slot = await ensure(spec);
      // 等它起来的这一会儿里后台可能已经被停掉了（拓展停用、本地服务退出）：别往一个死进程里写。
      if (slots.get(spec.key) !== slot) throw new Error("拓展后台已退出，请重试");
      const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_CALL_TIMEOUT_MS, 1), MAX_CALL_TIMEOUT_MS);
      touch(slot);
      return new Promise((resolve, reject) => {
        const id = slot.nextId++;
        const timer = setTimeout(() => {
          slot.pending.delete(id);
          reject(new Error(`调用 ${method} 超时`));
        }, timeout);
        slot.pending.set(id, { resolve, reject, timer });
        slot.child.stdin.write(JSON.stringify({ id, method, params: params ?? null }) + "\n", (error) => {
          if (!error) return;
          drop(spec.key);
        });
      });
    },
    /** 取走 since 之后的事件；没有就最多等 waitMs。后台没起时直接返回空（不为取事件而启动后台）。 */
    async events(key, since, waitMs) {
      const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), MAX_EVENT_WAIT_MS);
      for (;;) {
        const slot = slots.get(key);
        if (!slot) return { events: [], next: since === "latest" ? 0 : since, running: false };
        if (since === "latest") return { events: [], next: slot.events.length ? slot.events[slot.events.length - 1].seq : eventSeq, running: true };
        const ready = slot.events.filter((item) => item.seq > since);
        if (ready.length) return { events: ready, next: ready[ready.length - 1].seq, running: true };
        const left = deadline - Date.now();
        if (left <= 0) return { events: [], next: since, running: true };
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, left);
          slot.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    running: (key) => slots.has(key),
    stop: (key) => drop(key, "拓展已停用"),
    /** 只留 keep 里的后台（拓展停用、删除后调）。 */
    retain(keep) {
      for (const key of [...slots.keys()]) if (!keep.has(key)) drop(key, "拓展已停用");
    },
    stopAll() {
      for (const key of [...slots.keys()]) drop(key, "本地服务已停止");
    },
  };
}

/** 运行器脚本和本文件装在同一个目录。 */
export function defaultRunnerPath(here) {
  return path.join(here, "ext-backend-runner.mjs");
}
