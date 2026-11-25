// 开发用：在隔离的 Chrome 里打开录制版 Claude 界面，带上拓展运行时和指定的拓展包。
//
//   node dev/real-shell.mjs [拓展包目录...] [--installed <已安装的 claude-local 目录>] [--cdp 9377] [--headful] [--classic]
//
// 录制模板的账号在「合并式主页」的实验组里（对话和 Cowork 合在一个输入框，B 版）；默认就按 B 版打开，
// 加 --classic 是有「Chat | Cowork | Code」切换的经典主页（A 版，设置里没开合并式主页时用户看到的）。两种都要量。
//
// 用来在真实的 Claude 前端上量 DOM、验证注入（CSP、执行时机），不碰正在用的 Claude Desktop 和它的配置：
// - 本地服务从本仓库的 runtime/ 起一份新的，状态文件、扩展目录、注入计划都在临时目录里；
// - 录制模板、证书、中文词表从已安装的目录里读（默认 ~/.claude-mom/claude-local），资源缓存克隆一份再用；
// - Chrome 用单独的用户数据目录，经本地服务代理，开着调试端口。之后用 dev/cdp.mjs 连上去看页面。
// 上游是一个假的模型服务：发消息会得到一段固定的回复，够量消息的结构。Code / Cowork 依赖桌面端的宿主接口，在这里起不来。
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlan } from "./build-plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.dirname(here);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const valued = new Set(["installed", "cdp", "url"]);
const dirs = args.filter((arg, index) => !arg.startsWith("--") && !(args[index - 1]?.startsWith("--") && valued.has(args[index - 1].slice(2))));
const installed = path.resolve(option("installed", path.join(os.homedir(), ".claude-mom", "claude-local")));
const cdpPort = Number(option("cdp", "9377"));
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

for (const needed of ["mock", "ca", ".cache"]) {
  if (!fs.existsSync(path.join(installed, needed))) {
    console.error(`${installed} 里没有 ${needed}：先用 ClaudeMom（或 Codex++）启动过一次完整功能模式，或用 --installed 指到装好的目录`);
    process.exit(2);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-real-shell-"));
const service = path.join(root, "service");
fs.mkdirSync(path.join(service, "scripts"), { recursive: true });
for (const name of fs.readdirSync(runtimeDir)) {
  if (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) fs.copyFileSync(path.join(runtimeDir, name), path.join(service, name));
}
for (const name of fs.readdirSync(path.join(runtimeDir, "scripts"))) {
  if (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) fs.copyFileSync(path.join(runtimeDir, "scripts", name), path.join(service, "scripts", name));
}
fs.copyFileSync(path.join(runtimeDir, "..", "assets", "localization", "page-shim.js"), path.join(service, "page-shim.js"));
fs.cpSync(path.join(installed, "mock"), path.join(service, "mock"), { recursive: true });
fs.cpSync(path.join(installed, ".cache"), path.join(root, "cache"), { recursive: true });

const planFile = path.join(root, "page-plan.json");
const writePlan = () => fs.writeFileSync(planFile, JSON.stringify(buildPlan(dirs, { dataRoot: path.join(root, "extension-data") })), { mode: 0o600 });
if (dirs.length) writePlan();
// 改了运行时、锚点表、拓展的清单之后：给本进程发 SIGHUP 重新生成计划，再刷新页面。
process.on("SIGHUP", () => {
  try {
    if (dirs.length) writePlan();
    console.log("注入计划已重新生成");
  } catch (error) {
    console.error(`生成注入计划失败：${error.message}`);
  }
});

// 假的上游：每次回一段固定的文字（两段话加一个列表），按 Anthropic 的流式格式。
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const delta = (text) => `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${delta("这是实测用的固定回复。\n\n")}${delta("- 第一项\n- 第二项\n\n第二段话。")}data: {"type":"message_stop"}\n\n`);
  });
});
upstream.listen(0, "127.0.0.1");
await new Promise((resolve) => upstream.once("listening", resolve));

const ready = path.join(root, "ready.json");
const proxy = spawn(process.execPath, [path.join(service, "proxy.mjs"), "--port", "0", "--mode", "mock", "--log", "1", "--ca", path.join(installed, "ca")], {
  cwd: service,
  env: {
    ...process.env,
    CLAUDE_LOCAL_MANAGED: "1",
    CODEX_PLUS_STATE_DIR: root,
    CLAUDE_LOCAL_CACHE_DIR: path.join(root, "cache"),
    CLAUDE_LOCAL_WEB_I18N_DIR: path.join(installed, "catalogs"),
    CLAUDE_LOCAL_DESKTOP_RESOURCES: "/Applications/Claude.app/Contents/Resources",
    CLAUDE_LOCAL_GATEWAY_URL: `http://127.0.0.1:${upstream.address().port}`,
    CLAUDE_LOCAL_GATEWAY_KEY: "real-shell-no-upstream",
    CLAUDE_LOCAL_GATEWAY_MODEL: "preview/model",
    CLAUDE_LOCAL_GATEWAY_MODELS: JSON.stringify(["preview/model"]),
    CLAUDE_LOCAL_STATE_FILE: path.join(root, "conversations.json"),
    CLAUDE_LOCAL_READY_FILE: ready,
    CLAUDE_LOCAL_INSTANCE_ID: "real-shell",
    CLAUDE_LOCAL_LOCALIZATION: "1",
    CLAUDE_LOCAL_VOICE_INPUT: "0",
    CLAUDE_LOCAL_COMPUTER_USE: "0",
    CLAUDE_LOCAL_BACKGROUND_MODE: "0",
    CLAUDE_LOCAL_COWORK: "1",
    CLAUDE_LOCAL_HUB_HOME: args.includes("--classic") ? "0" : "1",
    CLAUDE_LOCAL_EXTENSIONS_DIR: path.join(root, "extensions"),
    CLAUDE_LOCAL_EXTENSIONS_STATE: path.join(root, "extensions.json"),
    CLAUDE_LOCAL_PAGE_PLAN: planFile,
    CLAUDE_LOCAL_PAGE_STATUS: path.join(root, "page-status.json"),
  },
  stdio: ["pipe", fs.openSync(path.join(root, "proxy.log"), "a"), fs.openSync(path.join(root, "proxy.log"), "a")],
});

let browser = null;
const stop = () => {
  try { browser?.kill(); } catch {}
  try { proxy.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 800).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
proxy.on("exit", (code) => {
  console.error(`本地服务退出了（${code}），日志在 ${path.join(root, "proxy.log")}`);
  stop();
});

for (let tries = 0; tries < 300 && !fs.existsSync(ready); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
const port = JSON.parse(fs.readFileSync(ready, "utf8")).port;
browser = spawn(chrome, [
  ...(args.includes("--headful") ? [] : ["--headless=new"]),
  `--user-data-dir=${path.join(root, "chrome")}`,
  `--proxy-server=http://127.0.0.1:${port}`,
  "--ignore-certificate-errors",
  `--remote-debugging-port=${cdpPort}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1440,900",
  `https://claude.ai${option("url", "/new")}`,
], { stdio: "ignore" });
console.log(JSON.stringify({ root, proxyPort: port, cdpPort, dumps: path.join(root, "extension-data"), log: path.join(root, "proxy.log") }));
