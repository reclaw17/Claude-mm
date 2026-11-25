// 页面运行时（page-runtime.js）的测试：在 node:vm 里配一个够用的 DOM 桩跑真实的运行时和包装模板，不引入依赖。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name), "utf8");
const RUNTIME = read("page-runtime.js");
const ANCHORS = read("page-anchors.js");
const WRAP = read("page-wrap.js");
const CONTRACT = JSON.parse(read("page-api.json"));

// ---------------------------------------------------------------- DOM 桩
function matcher(selector) {
  const alternatives = selector.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const tag = /^[a-z][\w-]*/i.exec(part)?.[0]?.toLowerCase() ?? null;
    const attributes = [...part.matchAll(/\[([\w-]+)(?:(\^)?=["']?([^"'\]]*)["']?)?\]/g)].map((match) => [match[1], match[3], match[2] === "^"]);
    // 类名在方括号外面找（属性值里可能有点号）。
    const classes = [...part.replace(/\[[^\]]*\]/g, "").matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    return (node) => (!tag || node.tagName.toLowerCase() === tag) &&
      classes.every((name) => node.className.split(/\s+/).includes(name)) &&
      attributes.every(([name, value, prefix]) => node.attributes.has(name) &&
        (value === undefined || (prefix ? node.attributes.get(name).startsWith(value) : node.attributes.get(name) === value)));
  });
  return (node) => alternatives.some((matches) => matches(node));
}

class FakeNode {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentElement = null;
    this.className = "";
    this.style = {};
    this.listeners = new Map();
    this.value = "";
    this._text = "";
  }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  getAttributeNames() { return [...this.attributes.keys()]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; }
  insertBefore(node, reference) {
    node.remove?.();
    node.parentElement = this;
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index === -1) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }
  cloneNode(deep) {
    const copy = new FakeNode(this.tagName);
    copy.className = this.className;
    copy._text = this._text;
    for (const [name, value] of this.attributes) copy.attributes.set(name, value);
    if (deep) for (const child of this.childNodes) copy.append(child.nodeType === 1 ? child.cloneNode(true) : child.textContent);
    return copy;
  }
  get textContent() { return this._text + this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value) { for (const child of this.childNodes) child.parentElement = null; this.childNodes = []; this._text = String(value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? { nodeType: 3, textContent: node, parentElement: null } : node;
      child.parentElement?.childNodes.splice(child.parentElement.childNodes.indexOf(child), 1);
      child.parentElement = this;
      this.childNodes.push(child);
    }
  }
  replaceChildren(...nodes) { this.textContent = ""; this.append(...nodes); }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.childNodes.splice(this.parentElement.childNodes.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(node) { for (let cursor = node; cursor; cursor = cursor.parentElement) if (cursor === this) return true; return false; }
  closest(selector) { const matches = matcher(selector); for (let cursor = this; cursor; cursor = cursor.parentElement) if (matches(cursor)) return cursor; return null; }
  querySelectorAll(selector) {
    const matches = matcher(selector);
    const found = [];
    const walk = (node) => { for (const child of node.children) { if (matches(child)) found.push(child); walk(child); } };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, event = {}) { for (const handler of [...(this.listeners.get(type) ?? [])]) handler({ type, target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...event }); }
  click() { this.dispatch("click"); }
  focus() {}
}

/** 一个页面：返回 window（也是 vm 的全局对象）和一组测试用的把手。 */
/** 从 fixtures/dom/ 的样本（[标签, 属性, 子节点]）搭一棵节点树。 */
function fromFixture([tag, attributes, children]) {
  const node = new FakeNode(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") node.className = value;
    else node.setAttribute(name, value);
  }
  node.append(...children.map(fromFixture));
  return node;
}

function createPage({ transport = "http", packages = [], readyState = "complete", pathname = "/new", fixture = null } = {}) {
  const timers = new Map();
  let timerSeq = 0;
  let now = 0;
  const documentElement = new FakeNode("html");
  const head = new FakeNode("head");
  const body = new FakeNode("body");
  documentElement.append(head, body);
  documentElement.setAttribute("lang", "zh-CN");
  // 页面的结构取自真实 Claude 页面导出的样本（dev/export-dom.js）。
  if (fixture) body.append(...fromFixture(JSON.parse(read(`fixtures/dom/${fixture}.json`)).body).children);
  const executed = [];
  const listeners = new Map();
  const target = {
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
  };
  const documentListeners = new Map();
  const storage = new Map();
  const fetches = [];
  const bindingCalls = [];
  const window = {
    ...target,
    console: { warn() {}, error() {}, log() {} },
    setTimeout(handler, delay = 0, ...args) { const id = ++timerSeq; timers.set(id, { at: now + delay, handler, args }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(handler, delay = 0, ...args) { const id = ++timerSeq; timers.set(id, { at: now + delay, handler, args, every: delay }); return id; },
    clearInterval(id) { timers.delete(id); },
    requestAnimationFrame(handler) { return window.setTimeout(handler, 16); },
    queueMicrotask,
    AbortController,
    navigator: { platform: "MacIntel", language: "zh-CN", userAgent: "" },
    location: { pathname },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
      key: (index) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    },
    CSSStyleSheet: class { replaceSync(text) { this.text = text; } },
    getSelection: () => ({ rangeCount: 0, isCollapsed: true, anchorNode: null, selectAllChildren() {}, modify() {} }),
    innerHeight: 800,
    MutationObserver: class { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} },
    fetch(url, options) {
      const call = { url, options, body: JSON.parse(options.body) };
      fetches.push(call);
      // fetchReply 可以返回一个 Promise（不兑现的 Promise 用来模拟一直挂着的长轮询）。
      return Promise.resolve(window.fetchReply ? window.fetchReply(call) : { ok: true, result: null })
        .then((reply) => ({ ok: !!reply.ok, status: reply.ok ? 200 : 403, json: async () => reply }));
    },
    document: {
      documentElement, head, body, readyState, hidden: false, title: "Claude", adoptedStyleSheets: [],
      createElement: (tag) => new FakeNode(tag),
      // 富文本输入框的写入命令：这里只记下发了什么。
      execCommand: (command, _ui, value) => { executed.push([command, value ?? null]); return true; },
      createTextNode: (text) => ({ nodeType: 3, textContent: String(text), parentElement: null }),
      querySelector: (selector) => documentElement.querySelector(selector),
      querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
      addEventListener(type, handler) { if (!documentListeners.has(type)) documentListeners.set(type, new Set()); documentListeners.get(type).add(handler); },
      removeEventListener(type, handler) { documentListeners.get(type)?.delete(handler); },
    },
  };
  window.window = window.top = window.self = window;
  if (transport === "binding") window.__codexPlusClaudeCall = (payload) => bindingCalls.push(JSON.parse(payload));
  const boot = {
    version: 1, apiVersion: 1, host: "claudeDesktop", transport, packages,
    ...(transport === "http" ? { token: "t".repeat(64), api: "/__codex_plus/api/v1/" } : { binding: { name: "__codexPlusClaudeCall", deliver: "__codexPlusClaudeDeliver" } }),
  };
  vm.createContext(window);
  const run = (source, filename = "inline.js") => vm.runInContext(source, window, { filename });
  /** 推进假的时钟，按时间顺序跑到点的定时器。 */
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = Math.max(now, timer.at);
      if (timer.every) timer.at = now + Math.max(timer.every, 1);
      else timers.delete(id);
      timer.handler(...timer.args);
    }
    now = end;
  };
  const flush = async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const fire = (type, event = {}) => {
    for (const handler of [...(listeners.get(type) ?? [])]) handler({ type, target: body, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...event });
  };
  const fireDocument = (type) => { for (const handler of [...(documentListeners.get(type) ?? [])]) handler({ type }); };
  /** 按包装模板跑一个拓展包，和注入计划渲染出来的一样。 */
  const runPackage = (key, source, manifest = {}) => {
    const meta = { key, name: key, source: "local", manifest: { id: key.split(":")[1], name: key, version: "1.0.0", permissions: { routes: [] }, config: {}, claudeDesktop: { methods: [], backend: false }, ...manifest } };
    run(WRAP.replace("/*CODEXPP_META*/null", JSON.stringify(meta)).replace("/*CODEXPP_STYLES*/", "").replace("/*CODEXPP_SOURCE*/", source), `${key}.js`);
  };
  run(`window.__codexPlusClaudeBoot = ${JSON.stringify(boot)};\n${ANCHORS}\n;\n${RUNTIME}`, "runtime.js");
  return { window, run, runPackage, advance, flush, fire, fireDocument, fetches, bindingCalls, executed, body, documentElement, scripts: () => window.__codexPlusUserScripts.scripts };
}

const owned = (page, name) => page.documentElement.querySelector(`[data-codex-plus-claude="${name}"]`);

// ---------------------------------------------------------------- 契约
test("the page API has exactly the members the contract lists", () => {
  const page = createPage();
  const api = page.window.codexPlus;
  assert.deepEqual(Object.keys(api).sort(), [...CONTRACT.api].sort());
  assert.equal(api.host, CONTRACT.host);
  assert.equal(api.apiVersion, CONTRACT.apiVersion);
  assert.deepEqual(Object.keys(api.constants).sort(), [...CONTRACT.constants].sort());
  for (const [name, value] of Object.entries(CONTRACT.sharedConstants)) assert.equal(api.constants[name], value, name);
  let ctx;
  page.runPackage("local:demo", "codexPlus.extension((value) => { window.capturedCtx = value; });");
  ctx = page.window.capturedCtx;
  assert.deepEqual(Object.keys(ctx).filter((name) => !name.startsWith("__")).sort(), [...CONTRACT.ctx].sort());
  // 运行时页面里开放的路由和服务端那份一致（page-api.mjs 的 PAGE_ROUTES、Rust 的 PAGE_ROUTES 也对着契约）。
  assert.deepEqual(CONTRACT.routes, ["/diagnostics/log", "/backend/status"]);
  assert.equal(ctx.asset("assets/a.png"), "");
  assert.equal(api.builtins().length, 0);
});

test("running the runtime twice keeps the first instance", () => {
  const page = createPage();
  const api = page.window.codexPlus;
  page.run(RUNTIME, "runtime-again.js");
  assert.equal(page.window.codexPlus, api);
});

test("without boot parameters or inside a frame the runtime does nothing", () => {
  const frame = { top: {}, document: {} };
  frame.window = frame;
  vm.createContext(frame);
  vm.runInContext(`window.__codexPlusClaudeBoot = {};\n${RUNTIME}`, frame);
  assert.equal(frame.codexPlus, undefined);
  const page = { document: {} };
  page.window = page.top = page;
  vm.createContext(page);
  vm.runInContext(RUNTIME, page);
  assert.equal(page.codexPlus, undefined);
});

// ---------------------------------------------------------------- 加载状态与出错隔离
test("each package records its own outcome and one failing does not stop the others", () => {
  const page = createPage({
    readyState: "loading",
    packages: [{ key: "local:good", name: "Good", slug: "l-good" }, { key: "local:throws", name: "Throws", slug: "l-throws" }, { key: "local:syntax", name: "Syntax", slug: "l-syntax" }, { key: "local:never", name: "Never", slug: "l-never" }],
  });
  assert.equal(page.scripts()["local:never"].status, "pending");
  page.runPackage("local:good", "window.goodRan = (window.goodRan || 0) + 1;");
  page.runPackage("local:throws", "throw new Error('boom');");
  // 语法错误的包整段不执行；完整功能模式下从 error 事件按地址认出来。
  assert.throws(() => page.runPackage("local:syntax", "this is not javascript"), /SyntaxError|Unexpected/);
  page.fire("error", { filename: "https://claude.ai/__codex_plus/pkg/l-syntax.js", message: "Unexpected identifier", lineno: 12 });
  assert.equal(page.scripts()["local:good"].status, "loaded");
  assert.equal(page.scripts()["local:throws"].status, "failed");
  assert.match(page.scripts()["local:throws"].error, /boom/);
  assert.match(page.scripts()["local:syntax"].error, /Unexpected identifier（第 12 行）/);
  // 页面解析完还没执行过的包记成失败。
  page.fireDocument("DOMContentLoaded");
  page.advance(1);
  assert.equal(page.scripts()["local:never"].status, "failed");
  // 同一个包补跑不会执行第二次。
  page.runPackage("local:good", "window.goodRan = (window.goodRan || 0) + 1;");
  assert.equal(page.window.goodRan, 1);
  assert.equal(page.window.__codexPlusUserScripts.currentKey, null);
});

test("a throwing apply rolls back what it registered, and callback errors land on their own script", () => {
  const page = createPage();
  const { registry } = page.window.__codexPlusClaudeRuntime;
  page.runPackage("local:bad", `codexPlus.extension((ctx) => { ctx.registerPage({ title: "P", render() {} }); throw new Error("apply failed"); });`);
  assert.equal(page.scripts()["local:bad"].status, "failed");
  assert.equal(registry.pages.size, 0);
  assert.equal(registry.navEntries.size, 0);

  page.runPackage("local:keys", `codexPlus.extension((ctx) => { ctx.registerShortcut({ key: "Mod+K", run() { throw new Error("shortcut failed"); } }); });`);
  page.runPackage("local:fine", `codexPlus.extension((ctx) => { ctx.registerShortcut({ key: "Mod+J", run() { window.jRan = true; } }); });`);
  page.fire("keydown", { key: "k", code: "KeyK", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
  page.fire("keydown", { key: "j", code: "KeyJ", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
  assert.match(page.scripts()["local:keys"].extensionError, /shortcut failed/);
  assert.equal(page.scripts()["local:keys"].status, "loaded", "脚本本身加载成功，坏的只是它注册的一项");
  assert.equal(page.scripts()["local:fine"].error, "");
  assert.equal(page.window.jRan, true);
  assert.throws(() => page.run(`codexPlus.registerShortcut({ key: "K", run() {} })`), /Mod \/ Ctrl \/ Alt/);
});

test("registrations are capped per script and undone when the instance is disposed", () => {
  const page = createPage();
  const { registry } = page.window.__codexPlusClaudeRuntime;
  page.runPackage("local:many", `
    window.many = codexPlus.extension((ctx) => {
      for (let index = 0; index < 16; index += 1) ctx.registerFloatingTab({ title: "T" + index, render() {} });
      try { ctx.registerFloatingTab({ title: "one too many", render() {} }); } catch (error) { window.capError = String(error.message); }
      ctx.on("dispose", () => { window.disposed = true; });
    });`);
  assert.equal(registry.floatingTabs.size, 16);
  assert.match(page.window.capError, /最多注册 16 项/);
  assert.ok([...registry.floatingTabs.values()].every((item) => item.scriptKey === "local:many" && item.order >= 1000));
  page.window.many.dispose();
  assert.equal(registry.floatingTabs.size, 0);
  assert.equal(page.window.disposed, true);
  assert.throws(() => page.run(`codexPlus.registerFloatingTab({ title: "no callback" })`), /必须提供/);
});

// ---------------------------------------------------------------- 不支持的能力
test("mount points without a host here are noted, not thrown, and data calls reject with a typed error", async () => {
  const page = createPage();
  page.runPackage("local:demo", `
    codexPlus.extension((ctx) => {
      window.undo = ctx.registerToolView({ render() {} });
      window.slot = ctx.registerSlot({ slot: "approval", render() {} });
      window.ctx = ctx;
    });`);
  const { window } = page;
  assert.equal(typeof window.undo, "function");
  assert.equal(typeof window.undo.refresh, "function");
  assert.equal(typeof window.slot.refresh, "function");
  assert.deepEqual([...page.scripts()["local:demo"].unsupported], ["registerToolView", "registerSlot:approval"]);
  assert.equal(page.scripts()["local:demo"].status, "loaded");
  // supports 细到挂载点和插槽：有位置的回 true，没有的（含不认识的名字）回 false。
  for (const name of ["registerPage", "registerComposerAction", "registerMessageAction", "registerSidePanel", "registerSlot", "registerSlot:composer.above", "registerSlot:turn.after"]) {
    assert.equal(window.codexPlus.supports(name), true, name);
  }
  for (const name of ["registerToolView", "registerSlot:approval", "registerSlot:nope", "nope", ""]) {
    assert.equal(window.codexPlus.supports(name), false, name);
  }
  for (const attempt of [() => window.ctx.llm.complete("hi"), () => window.ctx.llm.listModels(), () => window.ctx.backend.call("status"), () => window.codexPlus.call("/usage/history")]) {
    const error = await attempt().then(() => null, (reason) => reason);
    assert.equal(error.name, "CodexPlusUnsupportedError");
    assert.deepEqual([error.code, error.host], ["unsupported", "claudeDesktop"]);
  }
  assert.equal(page.fetches.length, 0, "本地就能判断的不支持不发请求");
});

// ---------------------------------------------------------------- 后台通道
test("backend calls go over the same-origin API with the token, limited to declared methods", async () => {
  const page = createPage();
  page.runPackage("local:demo", "codexPlus.extension((ctx) => { window.ctx = ctx; });", {
    permissions: { routes: ["/backend/status"] }, claudeDesktop: { methods: ["status"], backend: true },
  });
  const { window } = page;
  window.fetchReply = (call) => (call.body.method === "status" ? { ok: true, result: { count: 1 } } : { ok: true, result: { status: "ok" } });
  assert.deepEqual(await window.ctx.backend.call("status", { a: 1 }), { count: 1 });
  const [call] = page.fetches;
  assert.equal(call.url, "/__codex_plus/api/v1/call");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers["x-codex-plus-ext"], "t".repeat(64));
  assert.equal(call.options.headers["content-type"], "application/json");
  assert.deepEqual([call.body.key, call.body.method, call.body.params], ["local:demo", "status", { a: 1 }]);
  assert.match(call.body.instance, /^[0-9a-z]+-[0-9a-z]+$/);
  const undeclared = await window.ctx.backend.call("other").then(() => null, (reason) => reason);
  assert.equal(undeclared.code, "unsupported");
  assert.equal(page.fetches.length, 1);

  assert.deepEqual(await window.ctx.call("/backend/status"), { status: "ok" });
  assert.deepEqual([page.fetches[1].url, page.fetches[1].body.route], ["/__codex_plus/api/v1/route", "/backend/status"]);
  await assert.rejects(window.ctx.call("/diagnostics/log"), /未在 codexpp.json 声明路由权限/);

  window.fetchReply = () => ({ ok: false, error: "后台炸了", code: "x" });
  const failed = await window.ctx.backend.call("status").then(() => null, (reason) => reason);
  assert.deepEqual([failed.message, failed.code], ["后台炸了", "x"]);
  window.fetchReply = () => ({ ok: false, error: "不支持", code: "unsupported", feature: "config" });
  assert.equal((await window.ctx.backend.call("status").then(() => null, (reason) => reason)).name, "CodexPlusUnsupportedError");
});

test("backend events are polled from the tail and delivered until the instance is disposed", async () => {
  const page = createPage();
  const { window } = page;
  let release;
  window.fetchReply = (call) => {
    if (call.body.since === "latest") return { ok: true, result: { events: [], next: 7, running: true } };
    if (call.body.since === 7) return { ok: true, result: { events: [{ seq: 8, event: "tick", payload: { n: 1 } }, { seq: 9, event: "other", payload: 0 }], next: 9, running: true } };
    // 之后没有新事件：长轮询挂着，直到测试放行。
    return new Promise((resolve) => { release = () => resolve({ ok: true, result: { events: [], next: 9, running: true } }); });
  };
  page.runPackage("local:demo", `window.instance = codexPlus.extension((ctx) => { ctx.backend.on("tick", (payload, meta) => { (window.ticks ||= []).push([payload, meta.event]); }); });`, {
    claudeDesktop: { methods: [], backend: true },
  });
  await page.flush();
  assert.deepEqual(page.fetches.map((call) => [call.url, call.body.since, call.body.waitMs]), [
    ["/__codex_plus/api/v1/events", "latest", 0], ["/__codex_plus/api/v1/events", 7, 20000], ["/__codex_plus/api/v1/events", 9, 20000],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(window.ticks)), [[{ n: 1 }, "tick"]]);
  window.instance.dispose();
  release();
  await page.flush();
  assert.equal(page.fetches.length, 3, "卸载后不再轮询");
});

test("in the patched copy the same calls go through the binding and come back by id", async () => {
  const page = createPage({ transport: "binding" });
  page.runPackage("user:demo", "codexPlus.extension((ctx) => { window.ctx = ctx; });", { claudeDesktop: { methods: ["status"], backend: true } });
  const { window } = page;
  const pending = window.ctx.backend.call("status", { a: 1 });
  const [sent] = page.bindingCalls;
  assert.equal(sent.op, "call");
  assert.deepEqual([sent.body.key, sent.body.method, sent.body.params], ["user:demo", "status", { a: 1 }]);
  window.__codexPlusClaudeDeliver("someone-else", { ok: true, result: "wrong" });
  window.__codexPlusClaudeDeliver(sent.id, { ok: true, result: { count: 2 } });
  assert.deepEqual(await pending, { count: 2 });
  const refused = window.ctx.backend.call("status");
  window.__codexPlusClaudeDeliver(page.bindingCalls[1].id, { ok: false, error: "Codex++ 没有在运行", code: "host_offline" });
  await assert.rejects(refused, /Codex\+\+ 没有在运行/);
  // 没有回音的调用到时间就放弃。
  const lost = window.ctx.backend.call("status", null, { timeout: 1000 });
  page.advance(6000);
  await assert.rejects(lost, /超时/);
  // 通道还没挂上（不是由 Codex++ 启动的）时说清楚原因。
  delete window.__codexPlusClaudeCall;
  await assert.rejects(window.ctx.backend.call("status"), /需要由 Codex\+\+ 启动/);
});

test("load results are reported once they change, with the mount state", async () => {
  const page = createPage({ packages: [{ key: "local:demo", name: "Demo", slug: "l-demo" }] });
  page.runPackage("local:demo", "codexPlus.registerToolView({ render() {} });");
  page.advance(2100);
  await page.flush();
  const report = page.fetches.find((call) => call.url.endsWith("/status"));
  assert.deepEqual(report.body.scripts["local:demo"].status, "loaded");
  assert.deepEqual(report.body.scripts["local:demo"].unsupported, ["registerToolView"]);
  const count = page.fetches.length;
  page.window.__codexPlusUserScripts.markFailed("local:demo", "late");
  page.advance(2100);
  await page.flush();
  assert.equal(page.fetches.length, count, "已经加载成功的包不会被改回失败，没有变化就不再回报");
});

// ---------------------------------------------------------------- 界面
test("toasts stack up to three and can be dismissed early", () => {
  const page = createPage();
  const { codexPlus } = page.window;
  const first = codexPlus.toast("一", { type: "error" });
  assert.equal(first.ok, true);
  for (const text of ["二", "三", "四"]) codexPlus.toast(text);
  const host = owned(page, "toasts");
  assert.deepEqual(host.children.map((node) => node.textContent), ["二", "三", "四"]);
  assert.ok(host.children.every((node) => node.className === codexPlus.constants.toastClass));
  page.advance(4100);
  assert.equal(host.children.length, 0);
  const dismiss = codexPlus.toast("五").value;
  dismiss();
  assert.equal(host.children.length, 0);
});

test("ask resolves with the chosen option and queues a second question", async () => {
  const page = createPage();
  const first = page.window.codexPlus.ask({ title: "T", message: "M", options: ["no", { value: 1, label: "yes" }], input: { default: "hello" } });
  const second = page.window.codexPlus.ask({ title: "T2" });
  await page.flush();
  const overlays = page.documentElement.querySelectorAll(".codex-plus-ask-overlay");
  assert.equal(overlays.length, 1, "同一时间只显示一个");
  overlays[0].querySelectorAll(".codex-plus-ask-option")[1].click();
  assert.deepEqual({ ...(await first) }, { value: 1, text: "hello" });
  await page.flush();
  page.fire("keydown", { key: "Escape" });
  assert.equal(await second, null);
  assert.equal(page.documentElement.querySelectorAll(".codex-plus-ask-overlay").length, 0);
});

test("pages open as an overlay from the floating entry and clean up when closed or unregistered", () => {
  const page = createPage();
  page.runPackage("local:demo", `
    window.instance = codexPlus.extension((ctx) => {
      ctx.registerPage({ title: "演示页", render({ container, close, script }) { window.rendered = { container, close, script }; return () => { window.cleaned = true; }; } }, { id: "main" });
    });`);
  const { window } = page;
  const ball = owned(page, "ball");
  assert.ok(ball, "侧栏入口没挂上时页面入口在悬浮球里");
  ball.click();
  const panel = owned(page, "ball-panel");
  const row = panel.querySelector(".codex-plus-ball-row");
  assert.equal(row.textContent, "▫演示页");
  row.click();
  assert.equal(owned(page, "ball-panel"), null);
  const overlay = owned(page, "page");
  assert.equal(overlay.className, window.codexPlus.constants.pageClass);
  assert.equal(overlay.getAttribute(window.codexPlus.constants.pageNavAttribute), "local:demo:page:main");
  assert.equal(window.rendered.script, "local:demo");
  assert.equal(window.rendered.container.getAttribute("data-codex-plus-ext"), "local:demo");
  page.fire("keydown", { key: "Escape" });
  assert.equal(owned(page, "page"), null);
  assert.equal(window.cleaned, true);

  window.__codexPlusClaudeRuntime.showPage("local:demo:page:main");
  assert.ok(owned(page, "page"));
  window.instance.dispose();
  assert.equal(owned(page, "page"), null, "拓展卸载时开着的页面跟着关");
  assert.equal(owned(page, "ball"), null);
  // 侧栏入口挂上之后页面入口不再进悬浮球。
  page.runPackage("local:other", `codexPlus.registerPage({ title: "P", render() {} });`);
  assert.ok(owned(page, "ball"));
  window.__codexPlusClaudeRuntime.setRailMounted(true);
  assert.equal(owned(page, "ball"), null);
});

test("floating tabs render in the floating panel", () => {
  const page = createPage();
  page.runPackage("local:demo", `codexPlus.registerFloatingTab({ title: "面板", render({ container }) { container.textContent = "tab body"; return () => { window.tabCleaned = true; }; } });`);
  owned(page, "ball").click();
  const panel = owned(page, "ball-panel");
  assert.equal(panel.querySelector(".codex-plus-ball-body").textContent, "tab body");
  page.fire("pointerdown", { target: page.body });
  assert.equal(owned(page, "ball-panel"), null);
  assert.equal(page.window.tabCleaned, true);
});

test("themes apply through a constructed stylesheet and survive the extension coming back", () => {
  const page = createPage();
  const sheets = () => page.window.document.adoptedStyleSheets.map((sheet) => sheet.text);
  const base = sheets().length;
  page.runPackage("local:theme", `
    window.themeInstance = codexPlus.extension((ctx) => {
      ctx.registerTheme({ id: "dusk", name: { zh: "黄昏", en: "Dusk" }, variables: { "--bg-000": "0 0% 10%", "bad name": "x", "--x": "red;} body{display:none" }, css: ".a{}" });
      window.themes = ctx.themes;
    });`);
  const { window } = page;
  assert.deepEqual(JSON.parse(JSON.stringify(window.themes.list())), [{ id: "dusk", name: "黄昏", extension: "local:theme" }]);
  assert.equal(sheets().length, base, "注册了但没选中：不改页面");
  assert.equal(window.themes.apply("dusk"), "dusk");
  assert.equal(sheets().at(-1), ":root{--bg-000:0 0% 10%;--x:red bodydisplay:none}\n.a{}");
  assert.equal(page.documentElement.getAttribute("data-codex-plus-theme"), "dusk");
  assert.throws(() => window.themes.apply("nope"), /没有主题/);
  window.themeInstance.dispose();
  assert.equal(sheets().length, base);
  assert.equal(window.themes.current, "dusk", "选择留着，拓展回来后自动恢复");
  page.window.__codexPlusUserScripts.scripts["local:theme"].status = "pending";
  page.runPackage("local:theme", `codexPlus.registerTheme({ id: "dusk", css: ".b{}" });`);
  assert.equal(sheets().at(-1), ".b{}");
});

test("package styles are installed per file and services connect extensions", () => {
  const page = createPage();
  const { window } = page;
  window.__codexPlusUserScripts.addStyle("local:demo", "a.css", "body{}");
  assert.equal(window.document.adoptedStyleSheets.at(-1).text, "body{}");
  page.runPackage("local:consumer", `codexPlus.extension({ inject: ["clock"], apply(ctx) { window.sawClock = ctx.clock.now(); ctx.on("dispose", () => { window.consumerGone = true; }); } });`);
  assert.equal(window.sawClock, undefined, "依赖没齐之前不应用");
  page.runPackage("local:provider", `window.provider = codexPlus.extension((ctx) => { ctx.provide("clock", { now: () => 42 }); });`);
  assert.equal(window.sawClock, 42);
  assert.deepEqual(JSON.parse(JSON.stringify(window.codexPlus.services())), [{ name: "themes", owner: "builtin" }, { name: "clock", owner: "local:provider" }]);
  window.provider.dispose();
  assert.equal(window.consumerGone, true, "提供方卸载，依赖它的实例跟着卸载");
});

test("the current session id comes from the address", () => {
  assert.equal(createPage({ pathname: "/new" }).window.codexPlus.currentSessionId(), "");
  const page = createPage({ pathname: "/chat/0f8fad5b-d9cb-469f-a165-70867728950e" });
  assert.equal(page.window.codexPlus.currentSessionId(), "0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.deepEqual({ ...page.window.codexPlus.currentSession() }, { id: "0f8fad5b-d9cb-469f-a165-70867728950e", title: "Claude", hostId: "local", remote: false });
});

// ---------------------------------------------------------------- 挂在 Claude 界面上的位置
// 页面结构是真实 Claude 页面导出的样本（fixtures/dom/，用 dev/export-dom.js 导出）。Claude 改版后重新导出一份，
// 这里哪条断言挂了，就是哪个锚点要改（page-anchors.js）。
// 录制模板的账号在界面实验里，两种布局都有人用，都要过：hub 是合并式主页（B 版，对话页的加号在输入框下面那一条里），
// classic 是有「Chat | Cowork | Code」切换的经典主页（A 版，加号在输入框里面的工具行左边）。
const LAYOUTS = ["hub", "classic"];

/** 每个挂载点各登记一项的拓展。 */
const TOUR = `
  window.tour = [];
  window.instance = codexPlus.extension((ctx) => {
    ctx.registerPage({ title: "全览页面", icon: "◈", render({ container }) { container.textContent = "page"; } }, { id: "tour" });
    ctx.registerComposerAction({ label: "插入时间", icon: "◷", onActivate({ editor, insertText }) { window.tour.push(["composer", !!editor, insertText("12:00")]); } });
    ctx.registerMessageAction({ label: "引用", onActivate({ message }) { window.tour.push(["message", message.role, message.id]); } });
    ctx.registerMessageAction({ label: "只给回复", roles: "assistant", onActivate() {} });
    ctx.registerMessageDecoration({ roles: ["assistant"], render({ message, container }) { container.textContent = "装饰 " + message.id; } });
    for (const slot of ["composer.above", "composer.below", "thread.top", "thread.bottom", "sidebar.top", "sidebar.bottom", "titlebar", "turn.after", "sessionRow.suffix", "overlay"]) {
      ctx.registerSlot({ slot, render({ container, turnKey, sessionId }) { container.textContent = slot + (turnKey ? ":" + turnKey : "") + (sessionId ? ":" + sessionId : ""); return () => window.tour.push(["slot-cleanup", slot]); } });
    }
    ctx.registerRowAction({ label: "行操作", onActivate({ session_id }) { window.tour.push(["row", session_id]); } });
    window.panel = ctx.registerSidePanel({ title: "面板", width: 300, render({ container }) { container.textContent = "panel"; return () => window.tour.push(["panel-cleanup"]); } });
  });`;
const host = (page, name) => page.documentElement.querySelectorAll(`[data-codex-plus-claude="${name}"]`);
const byTestId = (page, id) => page.documentElement.querySelector(`[data-testid="${id}"]`);
const before = (node, other) => node.parentElement === other.parentElement && node.parentElement.children.indexOf(node) < other.parentElement.children.indexOf(other);

for (const layout of LAYOUTS) test(`on a real chat page (${layout}) every mount point lands next to its native counterpart`, () => {
  const page = createPage({ fixture: `${layout}-conversation`, pathname: "/chat/00000000-0000-4000-8000-000000000001" });
  page.runPackage("local:tour", TOUR);
  const { window } = page;

  // 侧栏入口：接在原生导航行后面，行是照原生行克隆的（同一串类名、不带 href）。
  const rail = host(page, "rail")[0];
  const navRows = byTestId(page, "nav-pin-rows");
  assert.equal(rail.parentElement, navRows);
  const nativeRows = navRows.children.filter((child) => child !== rail && (child.tagName === "A" || child.querySelector("a")));
  assert.equal(navRows.children.indexOf(rail), navRows.children.indexOf(nativeRows.at(-1)) + 1, "在最后一个原生行之后、行尾留白之前");
  const [entry] = host(page, "rail-entry");
  const sample = navRows.querySelector("a");
  assert.equal(entry.className, sample.className);
  assert.equal(entry.hasAttribute("href"), false);
  assert.equal(entry.getAttribute(window.codexPlus.constants.pageNavAttribute), "local:tour:page:tour");
  assert.equal(entry.textContent, "◈全览页面");
  assert.equal(host(page, "ball").length, 0, "侧栏入口挂上了，页面入口不再进悬浮球");
  entry.click();
  assert.equal(host(page, "page")[0].querySelector(".codex-plus-page-body").textContent, "page");
  assert.equal(host(page, "rail-entry")[0].getAttribute("data-selected"), "open");
  window.__codexPlusClaudeRuntime.closePage();

  // 输入框按钮：在工具行左边那一组里，照原生的加号按钮克隆。
  const attach = byTestId(page, "chat-input-attach");
  const actions = host(page, "composer-actions")[0];
  assert.ok(actions.parentElement.contains(attach), "和加号同一组");
  for (const other of ["chat-input", "chat-input-send", "composer-dictate", "chin-mic", "model-selector-dropdown"]) {
    const native = byTestId(page, other);
    if (native) assert.equal(actions.parentElement.contains(native), false, `不和 ${other} 混在一组`);
  }
  const composerButton = actions.querySelector("button");
  assert.equal(composerButton.className, attach.className);
  assert.deepEqual([composerButton.getAttribute("aria-label"), composerButton.hasAttribute("data-testid")], ["插入时间", false]);
  composerButton.click();
  assert.deepEqual(JSON.parse(JSON.stringify(window.tour)), [["composer", true, true]]);
  assert.deepEqual(page.executed.at(-1), ["insertText", "12:00"]);

  // 消息：回复的操作行里两个按钮（在时间戳前面），用户消息的操作行里一个；装饰只在回复上、在正文和操作行之间。
  const assistant = byTestId(page, "assistant-message");
  const bar = byTestId(page, "message-actions");
  const assistantHost = bar.children.find((child) => child.getAttribute("data-codex-plus-claude") === "message-actions");
  assert.equal(assistantHost.children.length, 2);
  assert.ok(before(assistantHost, bar.querySelector("time")));
  assert.equal(assistantHost.querySelector("button").className, bar.querySelector("button").className);
  const userHost = byTestId(page, "user-message-actions").children.find((child) => child.getAttribute("data-codex-plus-claude") === "message-actions");
  assert.equal(userHost.children.length, 1);
  userHost.querySelector("button").click();
  assistantHost.querySelector("button").click();
  assert.deepEqual(JSON.parse(JSON.stringify(window.tour.slice(1))), [["message", "user", "turn-1"], ["message", "assistant", "turn-2"]]);
  const decorations = host(page, "message-decorations");
  assert.equal(decorations.length, 1);
  assert.equal(decorations[0].parentElement, assistant);
  assert.ok(before(decorations[0], assistant.children.find((child) => child.contains(bar))));
  assert.equal(decorations[0].textContent, "装饰 turn-2");

  // 插槽：各在各的位置。
  const slot = (name) => host(page, `slot:${name}`)[0];
  const editor = byTestId(page, "chat-input");
  const box = slot("composer.above").nextElementSibling;
  assert.ok(box.contains(editor) && box.contains(attach), "composer.above 紧挨在整个输入框外框的前面");
  assert.equal(box.nextElementSibling, slot("composer.below"));
  const transcript = byTestId(page, "transcript-list");
  assert.equal(transcript.firstElementChild, slot("thread.top"));
  assert.equal(slot("thread.bottom").nextElementSibling, byTestId(page, "last-message-sentinel"));
  assert.equal(slot("sidebar.top").nextElementSibling, navRows);
  assert.ok(slot("sidebar.bottom").nextElementSibling.contains(byTestId(page, "user-menu-button")));
  assert.equal(slot("sidebar.bottom").parentElement, byTestId(page, "sidebar"));
  assert.equal(byTestId(page, "wiggle-controls-actions-group").firstElementChild, slot("titlebar"));
  assert.equal(slot("turn.after").parentElement, assistant);
  assert.equal(slot("turn.after").textContent, "turn.after:turn-2");
  assert.equal(slot("overlay").parentElement, page.body);

  // 会话行：按钮和插槽在「更多选项」那个容器里，拿得到会话 id。
  const row = byTestId(page, "sidebar-recents").querySelector("a").parentElement;
  const rowActions = host(page, "row-actions")[0];
  assert.ok(row.contains(rowActions));
  rowActions.querySelector("button").click();
  assert.deepEqual(JSON.parse(JSON.stringify(window.tour.at(-1))), ["row", "00000000-0000-4000-8000-000000000001"]);
  assert.equal(slot("sessionRow.suffix").textContent, "sessionRow.suffix:00000000-0000-4000-8000-000000000001");

  // 右侧面板：开关在头部按钮组里，打开时主区域让出宽度，关掉还原。
  const toggle = host(page, "side-panel-toggles")[0].querySelector("button");
  assert.equal(host(page, "side-panel-toggles")[0].parentElement, byTestId(page, "wiggle-controls-actions-group"));
  toggle.click();
  const pane = byTestId(page, "primary-pane");
  assert.equal(host(page, "side-panel")[0].querySelector(".codex-plus-panel-body").textContent, "panel");
  assert.equal(pane.style.marginInlineEnd, "300px");
  assert.equal(window.panel.toggle(), true);
  assert.deepEqual([host(page, "side-panel").length, pane.style.marginInlineEnd], [0, ""]);
  assert.deepEqual(JSON.parse(JSON.stringify(window.tour.at(-1))), ["panel-cleanup"]);

  // 都挂上了，没有哪一项被记成不支持；重画一遍不重复插入。
  assert.ok(Object.values(window.__codexPlusClaudeRuntime.mounts).every((value) => value === "ok"), JSON.stringify(window.__codexPlusClaudeRuntime.mounts));
  assert.deepEqual([...page.scripts()["local:tour"].unsupported], []);
  assert.equal(page.scripts()["local:tour"].error, "");
  window.__codexPlusClaudeRuntime.refreshHosts();
  for (const name of ["rail", "composer-actions", "message-decorations", "row-actions", "slot:thread.top", "slot:turn.after"]) assert.equal(host(page, name).length, 1, name);

  // 拓展卸载：它挂上去的东西都撤掉，插槽的清理函数被调用。
  window.instance.dispose();
  for (const name of ["rail", "composer-actions", "message-actions", "message-decorations", "row-actions", "side-panel-toggles", "slot:thread.top", "slot:overlay"]) assert.equal(host(page, name).length, 0, name);
  assert.ok(window.tour.some(([kind, name]) => kind === "slot-cleanup" && name === "thread.top"));
});

for (const layout of LAYOUTS) test(`on the new-chat page (${layout}) the places that exist are used and the rest wait quietly`, () => {
  const page = createPage({ fixture: `${layout}-new` });
  page.runPackage("local:tour", TOUR);
  for (const name of ["rail", "composer-actions", "slot:composer.above", "slot:sidebar.top", "slot:sidebar.bottom"]) assert.equal(host(page, name).length, 1, name);
  // 新对话页没有对话区、没有头部按钮组：这些位置不出现，也不算「没挂上」。
  for (const name of ["message-actions", "message-decorations", "slot:thread.top", "slot:titlebar", "side-panel-toggles"]) assert.equal(host(page, name).length, 0, name);
  const { mounts } = page.window.__codexPlusClaudeRuntime;
  assert.ok(!Object.values(mounts).includes("missing"), JSON.stringify(mounts));
  // 没有头部按钮时面板仍然能用句柄打开。
  assert.equal(page.window.panel.open(), true);
  assert.equal(host(page, "side-panel").length, 1);
});

test("when Claude's markup no longer matches, nothing throws and the missing places are reported", () => {
  // 一张没有任何锚点的页面：等于 Claude 把这些地方全改了。
  const page = createPage();
  page.runPackage("local:tour", TOUR);
  assert.equal(page.scripts()["local:tour"].status, "loaded");
  assert.equal(page.scripts()["local:tour"].error, "");
  for (const name of ["rail", "composer-actions", "message-actions", "row-actions", "slot:composer.above"]) assert.equal(host(page, name).length, 0, name);
  const { mounts } = page.window.__codexPlusClaudeRuntime;
  assert.deepEqual([mounts.rail, mounts.composer], ["missing", "missing"]);
  // 页面入口退到悬浮球里，不依赖 Claude DOM 的位置照常可用。
  assert.equal(host(page, "ball").length, 1);
  assert.equal(host(page, "slot:overlay").length, 1);
  assert.equal(page.window.panel.open(), true);
});

test("slash commands run instead of being sent, and input triggers offer choices", async () => {
  const page = createPage({ fixture: "hub-new" });
  page.runPackage("local:demo", `
    codexPlus.extension((ctx) => {
      ctx.registerCommand({ name: "tour", description: "全览", run(args, { sessionId, setText, toast }) { window.ran = [args, sessionId]; toast("收到 " + args); } });
      ctx.registerInputTrigger({ trigger: "#", items: (query) => [{ label: "#bug", insert: "#bug " }, { label: "#idea" }].filter((item) => item.label.includes(query)) });
      try { ctx.registerCommand({ name: "tour", run() {} }); } catch (error) { window.duplicate = error.message; }
      try { ctx.registerCommand({ name: "bad name", run() {} }); } catch (error) { window.badName = error.message; }
      try { ctx.registerInputTrigger({ trigger: "@", items: () => [] }); } catch (error) { window.reserved = error.message; }
    });`);
  const { window } = page;
  assert.match(window.duplicate, /已经被别的拓展登记/);
  assert.match(window.badName, /命令名只能是/);
  assert.match(window.reserved, /Claude 自己在用/);
  const editor = byTestId(page, "chat-input");
  /** 按一个键，返回它有没有被拦下（preventDefault）。 */
  const press = (key, extra = {}) => {
    let prevented = false;
    page.fire("keydown", { key, target: editor, preventDefault() { prevented = true; }, ...extra });
    return prevented;
  };
  // 打「/to」时列出匹配的命令，Tab 补全。
  editor.textContent = "/to";
  page.fire("input", { target: editor });
  await page.flush();
  assert.deepEqual(host(page, "hints")[0].children.map((row) => row.textContent), ["/tour全览"]);
  assert.equal(press("Tab"), true);
  assert.deepEqual(page.executed.at(-1), ["insertText", "/tour "]);
  assert.equal(host(page, "hints").length, 0);
  // 回车：整段是登记过的命令就拦下来交给拓展，输入框清空；不是的原样放过（发给 Claude）。
  editor.textContent = "/tour abc def";
  assert.equal(press("Enter"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(window.ran)), ["abc def", ""]);
  assert.deepEqual(page.executed.at(-1), ["delete", null]);
  assert.equal(page.documentElement.querySelector(".codex-delete-toast").textContent, "收到 abc def");
  for (const text of ["/other abc", "tour", "/tour abc"]) {
    editor.textContent = text;
    assert.equal(press("Enter", text === "/tour abc" ? { shiftKey: true } : {}), false, text);
  }
  // 别处（不是输入框）按回车不管。
  editor.textContent = "/tour x";
  assert.equal(press("Enter", { target: page.body }), false);
});

test("settings panels, settings sections and menu items get a page of their own", () => {
  const page = createPage({ fixture: "hub-new" });
  assert.equal(host(page, "rail").length, 0, "没有登记项时不出现入口");
  page.runPackage("local:demo", `
    window.instance = codexPlus.extension((ctx) => {
      ctx.registerMenuItem({ label: "开关", toggleValue: () => true, onChange(next) { window.changed = next; } });
      ctx.registerMenuItem({ label: "按钮", buttonLabel: "去", onActivate({ close }) { window.activated = true; close(); } });
      ctx.registerSettingsSection({ title: "分区", render({ container }) { container.textContent = "section"; return () => { window.sectionCleaned = true; }; } });
      ctx.registerSettingsPanel({ render({ container, config, saveConfig }) { container.textContent = "minutes=" + config.minutes; window.saveConfig = saveConfig; } });
    });`, { config: { minutes: 5 } });
  const { window } = page;
  const entries = host(page, "rail-entry");
  assert.deepEqual(entries.map((entry) => entry.textContent), ["✦拓展"]);
  entries[0].click();
  const sections = host(page, "page")[0].querySelectorAll(".codex-plus-ext-section");
  assert.deepEqual(sections.map((section) => section.querySelector("h3").textContent), ["开关与操作", "分区", "local:demo"]);
  assert.equal(sections[1].textContent, "分区section");
  assert.equal(sections[2].textContent, "local:demominutes=5");
  const checkbox = sections[0].querySelector("input");
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  checkbox.dispatch("change");
  assert.equal(window.changed, false);
  sections[0].querySelector("button").click();
  assert.equal(window.activated, true);
  assert.equal(host(page, "page").length, 0, "按钮形态的菜单项可以关掉这一页");
  assert.equal(window.sectionCleaned, true);
  // 在页面里存配置走 config 接口（目前托管方会回「还不支持」，由拓展自己处理这个拒绝）。
  window.saveConfig({ minutes: 9 });
  assert.deepEqual([page.fetches.at(-1).url, page.fetches.at(-1).body], ["/__codex_plus/api/v1/config", { key: "local:demo", values: { minutes: 9 } }]);
  window.instance.dispose();
  assert.equal(host(page, "rail").length, 0, "登记项都撤了，入口跟着消失");
});
