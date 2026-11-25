// 拓展后台的运行器：一个拓展包一个 Node 进程，跑它在 codexpp.json 里声明的 backend.script。
//
// ClaudeMom（本地服务托管，见 ext-backend.mjs）和 Codex++（它的常驻 helper 托管）用的是同一份，
// 所以后台脚本拿到的 ctx 两边一样。与托管方之间是 stdin / stdout 上的行式 JSON：
//   第一行（托管方 → 运行器）：{ script, extension, config, dataDir, host }
//   就绪（运行器 → 托管方）：  { ready: true, methods: [...] }，失败是 { fatal }
//   调用：                      { id, method, params } → { id, result } 或 { id, error }
//   事件：                      { event, payload }
//   宿主调用：                  { host: n, service, method, params } → { hostReply: n, result | error }
// 后台脚本的形式：export default function create(ctx) { return { 方法名(params) {...} } }
import { pathToFileURL } from "node:url";
import readline from "node:readline";

const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const lines = readline.createInterface({ input: process.stdin });
let methods = null;
let ready = null;
const provided = new Map();

// 向托管方发起宿主调用，回复按 hostReply 对应。Claude Desktop 下会话读写、界面、模型调用都还没开放，
// 托管方一律回错误；接口形状留着，和 Codex 那边一致。
const hostPending = new Map();
let hostSeq = 0;
const host = (service, method, params) => new Promise((resolve, reject) => {
  const id = ++hostSeq;
  hostPending.set(id, { resolve, reject });
  write({ host: id, service, method, params: params ?? null });
});
function handleHostReply(message) {
  if (!message || typeof message.hostReply !== "number") return false;
  const pending = hostPending.get(message.hostReply);
  if (pending) {
    hostPending.delete(message.hostReply);
    if (message.error !== undefined) pending.reject(new Error(String(message.error)));
    else pending.resolve(message.result ?? null);
  }
  return true;
}
const hostService = (name) => new Proxy({}, {
  get: (_, method) => (typeof method !== "string" || method === "then") ? undefined
    : (params) => host(name, method, params),
});
// 调用任一拓展后台提供的服务：service("名字").方法(...参数)。
const service = (name) => new Proxy({}, {
  get: (_, method) => (typeof method !== "string" || method === "then") ? undefined
    : (...args) => host("services", "call", { name: String(name), method, args }),
});

lines.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (handleHostReply(message)) return;
  if (!ready) {
    ready = (async () => {
      try {
        const module = await import(pathToFileURL(message.script).href);
        const create = typeof module.default === "function" ? module.default : null;
        if (!create) throw new Error(`${message.script} 没有默认导出函数`);
        methods = await create({
          extension: message.extension,
          host: message.host || "claudeDesktop",
          config: message.config ?? {},
          dataDir: message.dataDir,
          emit: (event, payload) => write({ event: String(event), payload: payload ?? null }),
          sessionQuery: hostService("sessionQuery"),
          sessions: hostService("sessions"),
          llm: hostService("llm"),
          ui: hostService("ui"),
          provide: (name, impl) => { provided.set(String(name), impl); },
          service,
          log: (...args) => process.stderr.write(args.map(String).join(" ") + "\n"),
        });
        write({ ready: true, methods: Object.keys(methods ?? {}).filter((name) => typeof methods[name] === "function") });
      } catch (error) {
        write({ fatal: String(error?.stack || error?.message || error) });
        process.exit(1);
      }
    })();
    return;
  }
  await ready;
  const { id, method, params } = message;
  try {
    // 别处按服务名调来的方法：{ name, method, args }，分派到 ctx.provide 登记的实现。
    if (method === "__service") {
      const impl = provided.get(params?.name);
      if (!impl) throw new Error(`后台没有提供服务 ${params?.name}（请在默认导出里调用 ctx.provide）`);
      const target = impl[params?.method];
      if (typeof target !== "function") throw new Error(`服务 ${params?.name} 没有方法 ${params?.method}`);
      const result = await target.apply(impl, Array.isArray(params?.args) ? params.args : []);
      write({ id, result: result === undefined ? null : result });
      return;
    }
    const fn = Object.prototype.hasOwnProperty.call(methods ?? {}, method) ? methods[method] : undefined;
    if (typeof fn !== "function") throw new Error(`后台没有方法 ${method}`);
    const result = await fn(params ?? null);
    write({ id, result: result === undefined ? null : result });
  } catch (error) {
    write({ id, error: String(error?.stack || error?.message || error) });
  }
});
lines.on("close", () => process.exit(0));
