// 拓展后台的运行器和托管器（ext-backend-runner.mjs、ext-backend.mjs）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { backendEnv, createBackendHost, defaultRunnerPath } from "./ext-backend.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ext-backend-"));
const hosts = [];
after(() => {
  for (const host of hosts) host.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(name, source, config = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const backend = path.join(dir, "backend.mjs");
  fs.writeFileSync(backend, source);
  return { key: `local:${name}`, id: name, backend, config, dataDir: path.join(root, "data", name) };
}
function host(options = {}) {
  const created = createBackendHost({ runner: defaultRunnerPath(here), ...options });
  hosts.push(created);
  return created;
}

test("a backend starts on the first call, keeps its state, and gets the documented ctx", async () => {
  const spec = fixture("ctx", `
    export default async function create(ctx) {
      let count = 0;
      return {
        keys: () => Object.keys(ctx).sort(),
        info: () => ({ extension: ctx.extension, host: ctx.host, config: ctx.config, dataDir: ctx.dataDir, cwd: process.cwd() }),
        count: () => ++count,
        echo: (params) => params,
        nothing: () => undefined,
        notAFunction: 3,
      };
    }`, { minutes: 5 });
  const backends = host();
  assert.equal(backends.running(spec.key), false);
  // 后台脚本拿到的 ctx：两个宿主（ClaudeMom、Codex++）共用运行器，所以这份清单两边一样。
  assert.deepEqual(await backends.call(spec, "keys"), ["config", "dataDir", "emit", "extension", "host", "llm", "log", "provide", "service", "sessionQuery", "sessions", "ui"]);
  const info = await backends.call(spec, "info");
  assert.deepEqual([info.extension, info.host, info.config], ["ctx", "claudeDesktop", { minutes: 5 }]);
  assert.equal(fs.realpathSync(info.cwd), fs.realpathSync(spec.dataDir));
  assert.deepEqual([await backends.call(spec, "count"), await backends.call(spec, "count")], [1, 2]);
  assert.deepEqual(await backends.call(spec, "echo", { a: [1, 2] }), { a: [1, 2] });
  assert.equal(await backends.call(spec, "nothing"), null);
  for (const method of ["missing", "notAFunction", "constructor", "toString"]) {
    await assert.rejects(backends.call(spec, method), /后台没有方法/, method);
  }
  assert.equal(backends.running(spec.key), true);
});

test("errors come back as rejections and host services are refused in Claude", async () => {
  const spec = fixture("errors", `
    export default (ctx) => ({
      fail: () => { throw new Error("boom"); },
      llm: () => ctx.llm.complete({ input: "hi" }),
      sessions: () => ctx.sessionQuery.listSessions({}),
      other: () => ctx.service("clock").now(),
    });`);
  const backends = host();
  await assert.rejects(backends.call(spec, "fail"), /boom/);
  await assert.rejects(backends.call(spec, "llm"), /llm\.complete 在 Claude Desktop 里不可用/);
  await assert.rejects(backends.call(spec, "sessions"), /sessionQuery\.listSessions 在 Claude Desktop 里不可用/);
  await assert.rejects(backends.call(spec, "other"), /services\.call 在 Claude Desktop 里不可用/);
});

test("a backend that cannot start reports why, and a later fix is picked up", async () => {
  const spec = fixture("broken", "export const notDefault = 1;");
  const backends = host();
  await assert.rejects(backends.call(spec, "x"), /没有默认导出函数/);
  assert.equal(backends.running(spec.key), false);
  const thrown = fixture("throws", "export default () => { throw new Error('init failed'); };");
  await assert.rejects(backends.call(thrown, "x"), /init failed/);
  fs.writeFileSync(spec.backend, "export default () => ({ x: () => 'fixed' });");
  assert.equal(await backends.call(spec, "x"), "fixed");
});

test("changing the script or the config restarts the backend; concurrent first calls share one start", async () => {
  const spec = fixture("restart", "export default (ctx) => { const started = Date.now() + Math.random(); return { id: () => started, minutes: () => ctx.config.minutes }; };", { minutes: 1 });
  const backends = host();
  const [first, again] = await Promise.all([backends.call(spec, "id"), backends.call(spec, "id")]);
  assert.equal(first, again);
  assert.equal(await backends.call({ ...spec, config: { minutes: 1 } }, "id"), first, "配置没变不重启");
  assert.equal(await backends.call({ ...spec, config: { minutes: 2 } }, "minutes"), 2);
  const second = await backends.call({ ...spec, config: { minutes: 2 } }, "id");
  assert.notEqual(second, first);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(spec.backend, future, future);
  assert.notEqual(await backends.call({ ...spec, config: { minutes: 2 } }, "id"), second);
});

test("events queue up for long polling and stay bounded", async () => {
  const spec = fixture("events", `
    export default (ctx) => ({
      emit: ({ name, payload }) => { ctx.emit(name, payload); return true; },
      flood: () => { for (let index = 0; index < 250; index += 1) ctx.emit("n", index); return true; },
      later: () => { setTimeout(() => ctx.emit("late", 1), 50); return true; },
    });`);
  const backends = host();
  assert.deepEqual(await backends.events(spec.key, "latest", 0), { events: [], next: 0, running: false });
  await backends.call(spec, "emit", { name: "a", payload: { x: 1 } });
  const latest = await backends.events(spec.key, "latest", 0);
  assert.deepEqual([latest.events, latest.running], [[], true]);
  assert.deepEqual(await backends.events(spec.key, latest.next, 0), { events: [], next: latest.next, running: true });
  await backends.call(spec, "emit", { name: "b", payload: null });
  const got = await backends.events(spec.key, latest.next, 0);
  assert.deepEqual(got.events.map((item) => [item.event, item.payload]), [["b", null]]);
  await backends.call(spec, "later");
  const waited = await backends.events(spec.key, got.next, 2000);
  assert.deepEqual(waited.events.map((item) => item.event), ["late"]);
  await backends.call(spec, "flood");
  const all = await backends.events(spec.key, 0, 0);
  assert.equal(all.events.length, 200);
  assert.equal(all.events.at(-1).payload, 249);
});

test("slow calls time out, and stopped or idle backends go away", async () => {
  const spec = fixture("slow", "export default () => ({ slow: () => new Promise(() => {}), ok: () => 1 });");
  const backends = host({ idleStopMs: 150 });
  await assert.rejects(backends.call(spec, "slow", null, 100), /调用 slow 超时/);
  assert.equal(await backends.call(spec, "ok"), 1);
  const waiting = backends.events(spec.key, 0, 5000);
  backends.stop(spec.key);
  assert.deepEqual(await waiting, { events: [], next: 0, running: false });
  assert.equal(backends.running(spec.key), false);
  assert.equal(await backends.call(spec, "ok"), 1);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(backends.running(spec.key), false, "空闲超时后停掉");

  const other = fixture("other", "export default () => ({ ok: () => 2 });");
  await Promise.all([backends.call(spec, "ok"), backends.call(other, "ok")]);
  backends.retain(new Set([other.key]));
  assert.deepEqual([backends.running(spec.key), backends.running(other.key)], [false, true]);
  // 正在等回音的调用在后台被停掉时立刻失败，不用等到超时；还没发出去的那次也不会写进死进程里。
  await backends.call(spec, "ok");
  const pending = backends.call(spec, "slow");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const racing = backends.call(other, "ok");
  backends.stopAll();
  await assert.rejects(pending, /本地服务已停止/);
  await assert.rejects(racing, /已退出/);
});

test("backends do not inherit the local service's own variables", () => {
  const env = backendEnv({ PATH: "/bin", HOME: "/h", CLAUDE_LOCAL_GATEWAY_KEY: "sk", CODEX_PLUS_STATE_DIR: "/s", ANTHROPIC_API_KEY: "k", anthropic_base_url: "u" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});
