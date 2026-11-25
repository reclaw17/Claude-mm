// 开发用预览：不启动 Claude，在普通浏览器里跑拓展运行时和拓展包，看界面、调后台。
//
//   node dev/preview-server.mjs <拓展包目录>... [--port 8799]
//
// 它用的是和本地服务同一套模块（extensions.mjs 的注入计划、page-api.mjs 的页面接口、ext-backend.mjs 的后台托管），
// 只是页面换成一张假的 Claude 外壳（preview.html），来源换成 http://127.0.0.1:<端口>。
// 注入计划本来由 Rust 渲染；这里用 build-plan.mjs 按同样的模板拼一份，只供开发用。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_PACKAGE_PREFIX, PAGE_RUNTIME_PATH, createPagePlan } from "../extensions.mjs";
import { createBackendHost, defaultRunnerPath } from "../ext-backend.mjs";
import { PAGE_API_PREFIX, createPageApi } from "../page-api.mjs";
import { buildPlan as renderPlan } from "./build-plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.dirname(here);
const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const port = portAt === -1 ? 8799 : Number(args[portAt + 1]);
const dirs = args.filter((arg, index) => !arg.startsWith("--") && index !== portAt + 1 || (portAt === -1 && !arg.startsWith("--")));
if (!dirs.length) {
  console.error("用法：node dev/preview-server.mjs <拓展包目录>... [--port 8799]");
  process.exit(2);
}

const state = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ext-preview-"));
const planFile = path.join(state, "page-plan.json");

// 每次请求页面都重新生成计划：改了运行时、锚点表、清单，刷新浏览器就看到。
const writePlan = () => fs.writeFileSync(planFile, JSON.stringify(renderPlan(dirs, { dataRoot: path.join(state, "extension-data") })), { mode: 0o600 });
writePlan();

const token = crypto.randomBytes(32).toString("hex");
const origin = `http://127.0.0.1:${port}`;
const plan = createPagePlan({ planFile });
const backends = createBackendHost({ runner: defaultRunnerPath(runtimeDir), log: console.log });
const api = createPageApi({ plan, backends, token, origins: new Set([origin]), statusFile: path.join(state, "page-status.json"), log: console.log });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname.startsWith(PAGE_API_PREFIX)) return api.handle(req, res, url.pathname);
  if (url.pathname === PAGE_RUNTIME_PATH || url.pathname.startsWith(PAGE_PACKAGE_PREFIX)) {
    const script = plan.script(url.pathname, token);
    if (script === null) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    return res.end(script);
  }
  if (url.pathname === "/" || url.pathname === "/new" || url.pathname.startsWith("/chat/")) {
    try {
      writePlan();
    } catch (error) {
      console.error(`生成注入计划失败：${error.message}`);
    }
    const tags = plan.scripts().map((src) => `<script src="${src}" defer></script>`).join("");
    const html = fs.readFileSync(path.join(here, "preview.html"), "utf8").replace("<!--EXTENSIONS-->", tags);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html);
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1", () => {
  console.log(`预览：${origin}/new    （深色：${origin}/new?dark）`);
  console.log(`后台数据和加载状态在 ${state}`);
});
const stop = () => {
  backends.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
