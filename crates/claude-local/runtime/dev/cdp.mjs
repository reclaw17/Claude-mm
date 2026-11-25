// 开发用：连到 real-shell.mjs 起的 Chrome，对 Claude 页面做一件事。
//
//   node dev/cdp.mjs eval '<表达式>'      # 在页面里求值（Promise 会等它），打印 JSON
//   node dev/cdp.mjs file <脚本文件>      # 同上，表达式从文件读
//   node dev/cdp.mjs shot <输出.png>      # 截图
//   node dev/cdp.mjs goto <地址或路径>    # 打开一个地址
//   node dev/cdp.mjs reload | console     # 刷新 / 刷新并收集 8 秒内的控制台输出和报错
// 端口用环境变量 CDP_PORT 改（默认 9377）。
import fs from "node:fs";

const port = Number(process.env.CDP_PORT || 9377);
const [action, value] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((item) => item.type === "page" && /claude\.(ai|com)/.test(item.url)) ?? targets.find((item) => item.type === "page");
if (!target) {
  console.error("没有找到页面");
  process.exit(1);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve);
  socket.addEventListener("error", reject);
});
let seq = 0;
const pending = new Map();
const events = [];
socket.addEventListener("message", (message) => {
  const data = JSON.parse(message.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message));
    else resolve(data.result);
  } else if (data.method) {
    events.push(data);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};

try {
  if (action === "eval" || action === "file") {
    const output = await evaluate(action === "file" ? fs.readFileSync(value, "utf8") : value);
    console.log(typeof output === "string" ? output : JSON.stringify(output, null, 1));
  } else if (action === "shot") {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(value, Buffer.from(data, "base64"));
    console.log(value);
  } else if (action === "goto") {
    await send("Page.navigate", { url: value.startsWith("/") ? `https://claude.ai${value}` : value });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    console.log(await evaluate("location.href"));
  } else if (action === "reload" || action === "console") {
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.reload", { ignoreCache: true });
    await new Promise((resolve) => setTimeout(resolve, action === "console" ? 8000 : 5000));
    if (action === "console") {
      for (const event of events) {
        if (event.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(event.params.type)) {
          console.log(`[${event.params.type}] ${event.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 300)}`);
        } else if (event.method === "Runtime.exceptionThrown") {
          console.log(`[exception] ${(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text).slice(0, 400)}`);
        } else if (event.method === "Log.entryAdded" && ["error", "warning"].includes(event.params.entry.level)) {
          console.log(`[log:${event.params.entry.level}] ${event.params.entry.text.slice(0, 300)} ${event.params.entry.url || ""}`);
        }
      }
    }
    console.log(await evaluate("location.href"));
  } else {
    console.error("用法见文件开头");
    process.exitCode = 2;
  }
} finally {
  socket.close();
}
