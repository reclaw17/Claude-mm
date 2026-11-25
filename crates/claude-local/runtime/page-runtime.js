// Claude 页面里的拓展运行时：window.codexPlus。
//
// Codex++「万物皆拓展」的页面接口在 Claude Desktop 里的实现，成员名与 Codex++ 的
// types/codex-plus-extensions.d.ts 一致（契约清单见 page-api.json），所以一份拓展代码两边都能跑；
// 用 codexPlus.host / codexPlus.supports() 判断当前宿主和某个挂载点可不可用。
//
// 这个文件由注入计划（src/extensions/plan.rs）连同启动参数 window.__codexPlusClaudeBoot 一起下发，
// 在每个拓展包之前执行。约定：
//   - 注册表持久、DOM 瞬态：register* 只存数据，界面由各宿主函数按注册表重画。
//   - 失败隔离：拓展的回调一律经 runCallback，抛错只记到那个拓展的状态里。
//   - 不伤页面：不改页面的全局对象；自己插的节点带 data-codex-plus-claude，交给拓展画的容器带
//     data-codex-plus-ext，扫描调度靠这两个属性认出自己的写入。
//   - 不用 eval、new Function、内联事件属性；样式走 adoptedStyleSheets，不受页面 CSP 的 style-src 限制。
(() => {
  "use strict";
  if (typeof window === "undefined" || window.top !== window) return;
  const boot = window.__codexPlusClaudeBoot;
  if (!boot || typeof boot !== "object") return;
  // 同一页面只起一次（补丁副本会在已加载的页面上补跑）。
  if (window.__codexPlusClaudeRuntime) return;

  const HOST = "claudeDesktop";
  const API_VERSION = Number(boot.apiVersion) || 1;
  const ADAPTER_VERSION = "1.0.0";
  const OWN_ATTR = "data-codex-plus-claude";
  const EXT_ATTR = "data-codex-plus-ext";
  const anchors = window.__codexPlusClaudeAnchors && typeof window.__codexPlusClaudeAnchors === "object" ? window.__codexPlusClaudeAnchors : {};

  /** 类名与属性契约：键名与 Codex++ 相同。rail 两项指向运行时自己的入口容器。 */
  const constants = Object.freeze({
    pageClass: "codex-plus-page-overlay",
    pageNavAttribute: "data-codex-plus-page-nav",
    railSelector: `[${OWN_ATTR}="rail"]`,
    railDestinationSelector: `[${OWN_ATTR}="rail-entry"]`,
    actionGroupClass: "codex-session-actions",
    moreMenuClass: "codex-session-more-menu",
    toastClass: "codex-delete-toast",
    extensionAttribute: EXT_ATTR,
  });

  /** Claude 页面里开放的后端路由（拓展包还得在清单 permissions.routes 里声明）。 */
  const pageRoutes = new Set(["/diagnostics/log", "/backend/status"]);
  const CALL_TIMEOUT_MS = 26000;

  // ------------------------------------------------------------------ 状态记录
  // 形状与 Codex++ 的 window.__codexPlusUserScripts.scripts[key] 一致：管理界面读的是同一种记录。
  const state = (window.__codexPlusUserScripts = window.__codexPlusUserScripts || { scripts: {} });
  state.scripts = state.scripts || {};
  state.host = HOST;
  state.currentKey = null;
  const slugOf = new Map();
  for (const item of Array.isArray(boot.packages) ? boot.packages : []) {
    if (!item || typeof item.key !== "string") continue;
    if (item.slug) slugOf.set(String(item.slug), item.key);
    state.scripts[item.key] = state.scripts[item.key] || {
      key: item.key, name: String(item.name || item.key), source: "", manifest: null, status: "pending", error: "", loadedAt: "", unsupported: [],
    };
  }

  function errorText(error) {
    return String((error && (error.stack || error.message)) || error);
  }

  function markFailure(scriptKey, message) {
    const record = scriptKey ? state.scripts[scriptKey] : null;
    if (record) {
      record.error = message;
      // 不动 status：脚本本身可能已经加载成功，失败的只是它注册的某一项。
      record.extensionError = message;
    }
    window.__codexPlusExtensionFailures = window.__codexPlusExtensionFailures || [];
    window.__codexPlusExtensionFailures.push({ script_key: scriptKey || "", message, at: Date.now() });
    if (window.__codexPlusExtensionFailures.length > 100) window.__codexPlusExtensionFailures.shift();
    scheduleReport();
  }

  /** 带着归属执行拓展的回调：成功 { ok: true, value }，失败 { ok: false, error }。 */
  function runCallback(scriptKey, label, callback) {
    try {
      return { ok: true, value: callback() };
    } catch (error) {
      const message = errorText(error);
      markFailure(scriptKey, `${label}: ${message}`);
      return { ok: false, error: message };
    }
  }

  state.beginPackage = (meta) => {
    if (!meta || typeof meta.key !== "string") return false;
    const existing = state.scripts[meta.key];
    if (existing && existing.status !== "pending") return false;
    state.scripts[meta.key] = {
      key: meta.key, name: String(meta.name || meta.key), source: String(meta.source || ""), manifest: meta.manifest || null,
      status: "loading", error: "", loadedAt: new Date().toISOString(), cleanups: [], unsupported: [],
    };
    state.currentKey = meta.key;
    return true;
  };
  state.endPackage = (key, error) => {
    const record = state.scripts[key];
    if (record) {
      if (error === undefined) {
        record.status = "loaded";
        record.loadedAt = new Date().toISOString();
      } else {
        record.status = "failed";
        record.error = errorText(error);
      }
    }
    if (state.currentKey === key) state.currentKey = null;
    scheduleReport();
  };
  /** 注入方发现某一段没能执行（语法错误）时调。 */
  state.markFailed = (key, message) => {
    const record = state.scripts[key];
    if (!record || record.status === "loaded") return;
    record.status = "failed";
    record.error = String(message || "脚本没有执行");
    if (state.currentKey === key) state.currentKey = null;
    scheduleReport();
  };
  state.registerCleanup = (cleanup) => {
    const record = state.scripts[state.currentKey];
    if (!record || typeof cleanup !== "function") return false;
    record.cleanups = record.cleanups || [];
    record.cleanups.push(cleanup);
    return true;
  };

  // 完整功能模式下每个包是一个 <script>：语法错误不会进包装里的 try/catch，只能从 error 事件按地址认出来。
  window.addEventListener("error", (event) => {
    const match = /\/__codex_plus\/pkg\/([\w-]+)\.js(?:$|\?)/.exec(String(event?.filename || ""));
    const key = match ? slugOf.get(match[1]) : null;
    if (key) state.markFailed(key, `${event.message || "脚本出错"}（第 ${event.lineno || 0} 行）`);
  });

  /** 页面解析完后还停在 pending 的包没有执行过。 */
  function settlePending() {
    for (const record of Object.values(state.scripts)) {
      if (record.status === "pending") state.markFailed(record.key, "脚本没有执行，多半是语法错误");
    }
    scheduleReport();
  }
  if (boot.transport === "http" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(settlePending, 0), { once: true });
  } else {
    setTimeout(settlePending, 3000);
  }

  // ------------------------------------------------------------------ 不支持的能力
  class CodexPlusUnsupportedError extends Error {
    constructor(feature, detail) {
      super(detail || `${feature} 在 Claude Desktop 里不可用`);
      this.name = "CodexPlusUnsupportedError";
      this.code = "unsupported";
      this.feature = feature;
      this.host = HOST;
    }
  }

  /** 这个宿主里已经有实现的挂载点；值是「当前页面上挂不挂得上」。没列的一律不支持。 */
  const mountSupport = new Map();
  const warned = new Set();
  /** 拓展用了这里还没有的挂载点：不报错（其余功能照常），记进它的状态，控制台每个方法只提醒一次。 */
  function noteUnsupported(scriptKey, feature) {
    const record = state.scripts[scriptKey];
    if (record) {
      record.unsupported = record.unsupported || [];
      if (!record.unsupported.includes(feature)) record.unsupported.push(feature);
    }
    if (!warned.has(feature)) {
      warned.add(feature);
      console.warn(`[codexPlus] ${feature} 在 Claude Desktop 里还不可用，已忽略`);
    }
    scheduleReport();
  }

  function supports(name) {
    const feature = String(name || "");
    // 带细分的问法（registerSlot:composer.above）只认登记过的那一项，不拿「registerSlot 总体可用」充数。
    const check = mountSupport.get(feature);
    if (!check) return false;
    try {
      return check(feature) !== false;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ 与后台的通道
  const nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  const bindingCalls = new Map();
  let bindingSeq = 0;

  function replyError(reply, fallback) {
    const error = reply?.code === "unsupported" ? new CodexPlusUnsupportedError(String(reply.feature || ""), reply.error) : new Error(String(reply?.error || fallback));
    if (reply?.code && error.code === undefined) error.code = reply.code;
    return error;
  }

  if (boot.transport === "binding" && boot.binding?.deliver) {
    window[boot.binding.deliver] = (id, reply) => {
      const call = bindingCalls.get(id);
      if (!call) return;
      bindingCalls.delete(id);
      clearTimeout(call.timer);
      if (reply && reply.ok) call.resolve(reply.result);
      else call.reject(replyError(reply, "调用失败"));
    };
  }

  /** 调一次后台通道。op：call / events / stop / route / status / config。回应统一是 { ok, result } 或 { ok: false, error, code }。 */
  function request(op, body, options = {}) {
    const timeout = Number.isFinite(options.timeout) ? Number(options.timeout) : CALL_TIMEOUT_MS;
    if (boot.transport === "binding") {
      return new Promise((resolve, reject) => {
        const send = window[boot.binding?.name];
        if (typeof send !== "function") {
          reject(new Error("拓展通道还没连上：这个 Claude 需要由 Codex++ 启动"));
          return;
        }
        const id = `${Date.now().toString(36)}-${(bindingSeq += 1)}`;
        const timer = setTimeout(() => {
          bindingCalls.delete(id);
          reject(new Error(`调用 ${op} 超时`));
        }, timeout);
        bindingCalls.set(id, { resolve, reject, timer });
        try {
          send(JSON.stringify({ id, op, body: body ?? {} }));
        } catch (error) {
          bindingCalls.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    }
    if (!nativeFetch || !boot.api) return Promise.reject(new Error("拓展通道不可用"));
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeout);
    return nativeFetch(`${boot.api}${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-plus-ext": String(boot.token || "") },
      body: JSON.stringify(body ?? {}),
      credentials: "same-origin",
      cache: "no-store",
      signal: controller?.signal,
    }).then(async (response) => {
      let reply = null;
      try {
        reply = await response.json();
      } catch {}
      if (!response.ok || !reply || reply.ok !== true) throw replyError(reply, `本地服务返回 ${response.status}`);
      return reply.result;
    }, (error) => {
      throw error?.name === "AbortError" ? new Error(`调用 ${op} 超时`) : error;
    }).finally(() => clearTimeout(timer));
  }

  /** 把各拓展的加载结果、没挂上的位置回报给托管方，管理界面的列表读的就是它。合并成两秒一次。 */
  let reportTimer = null;
  let reportedText = "";
  const mounts = {};
  function scheduleReport() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      const scripts = {};
      for (const record of Object.values(state.scripts)) {
        scripts[record.key] = {
          status: record.status, error: String(record.error || "").slice(0, 4000), unsupported: record.unsupported || [], loadedAt: record.loadedAt || "",
        };
      }
      const payload = { scripts, mounts };
      const text = JSON.stringify(payload);
      if (text === reportedText) return;
      reportedText = text;
      request("status", payload, { timeout: 8000 }).catch(() => {
        reportedText = "";
      });
    }, 2000);
  }

  // ------------------------------------------------------------------ 注册中心
  const registry = {
    rowActions: new Map(), navEntries: new Map(), pages: new Map(), menuItems: new Map(), composerActions: new Map(),
    commands: new Map(), messageActions: new Map(), messageDecorations: new Map(), sidePanels: new Map(), slots: new Map(),
    inputTriggers: new Map(), shortcuts: new Map(), themes: new Map(), floatingTabs: new Map(), settingsPanels: new Map(),
    settingsSections: new Map(), toolViews: new Map(),
  };
  const PER_SCRIPT_LIMIT = 16;
  const GLOBAL_LIMIT = 64;
  let idCounter = 0;

  function currentScriptKey(options) {
    return options?.scriptKey || state.currentKey || "";
  }

  function registerInto(kind, map, id, definition, scriptKey) {
    if (typeof id !== "string" || !id.trim()) throw new Error("拓展项 id 不能为空");
    if (map.has(id)) throw new Error(`拓展项 id 已被占用：${id}`);
    const owned = [...map.values()].filter((item) => item.scriptKey === scriptKey).length;
    if (owned >= PER_SCRIPT_LIMIT) throw new Error(`每个脚本最多注册 ${PER_SCRIPT_LIMIT} 项`);
    if (map.size >= GLOBAL_LIMIT) throw new Error(`拓展项总数已达上限 ${GLOBAL_LIMIT}`);
    const callbacks = ["render", "onActivate", "onChange", "onCleanup", "run", "items"];
    if (definition && kind !== "theme" && !callbacks.some((name) => typeof definition[name] === "function")) {
      throw new Error(`拓展项 ${id} 必须提供 ${callbacks.join(" / ")} 之一`);
    }
    const order = Number.isFinite(definition?.order) ? Number(definition.order) : 0;
    const minOrder = String(scriptKey || "").startsWith("builtin:") ? 0 : 1000;
    const normalized = { ...definition, kind, id, order: Math.max(minOrder, order), scriptKey };
    map.set(id, normalized);
    return () => {
      if (map.get(id) === normalized) map.delete(id);
    };
  }

  function itemsOf(map) {
    return [...map.values()].sort((left, right) => left.order - right.order);
  }

  /** 各宿主的重画函数：注册 / 撤销后立刻跑一遍，再在 0.5、2、5 秒补跑（拓展常常先于 Claude 的界面注册）。 */
  const hostRefreshers = new Set();
  let catchUpTimers = [];
  function refreshHostsNow() {
    for (const refresh of hostRefreshers) {
      try {
        refresh();
      } catch {}
    }
  }
  function refreshHosts() {
    refreshHostsNow();
    for (const timer of catchUpTimers) clearTimeout(timer);
    catchUpTimers = [500, 2000, 5000].map((delay) => setTimeout(refreshHostsNow, delay));
  }

  /** 注册一项。mount 是它的挂载点名（给 supports 和「不支持」提示用）。 */
  function registerItem(kind, map, mount, definition, options = {}) {
    const scriptKey = currentScriptKey(options);
    if (!mountSupport.has(mount)) noteUnsupported(scriptKey, mount);
    const id = `${scriptKey}:${kind}:${options.id || `item-${(idCounter += 1)}`}`;
    const dispose = registerInto(kind, map, id, definition, scriptKey);
    refreshHosts();
    return () => {
      dispose();
      refreshHosts();
    };
  }

  // ------------------------------------------------------------------ 小工具
  function el(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === undefined || value === null || value === false) continue;
      if (name === "class") node.className = String(value);
      else if (name === "text") node.textContent = String(value);
      else node.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of [].concat(children)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function own(node, name) {
    node.setAttribute(OWN_ATTR, name);
    return node;
  }

  let htmlPolicy;
  /** 图标：单个字形直接当文字；SVG 字符串解析成节点（页面要求 Trusted Types 又不让建策略时退成一个点）。 */
  function setIcon(node, icon, fallback = "◆") {
    const text = String(icon || "").trim();
    node.textContent = "";
    if (!/^<svg[\s>]/i.test(text)) {
      node.textContent = text || fallback;
      return;
    }
    try {
      if (htmlPolicy === undefined) {
        htmlPolicy = window.trustedTypes?.createPolicy ? window.trustedTypes.createPolicy("codex-plus-icons", { createHTML: (value) => value }) : null;
      }
      const parsed = new DOMParser().parseFromString(htmlPolicy ? htmlPolicy.createHTML(text) : text, "image/svg+xml");
      const svg = parsed.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== "svg") throw new Error("not svg");
      svg.querySelectorAll("script, foreignObject").forEach((bad) => bad.remove());
      node.append(document.importNode(svg, true));
    } catch {
      htmlPolicy = htmlPolicy || null;
      node.textContent = fallback;
    }
  }

  function isThenable(value) {
    return !!value && typeof value.then === "function";
  }

  // ------------------------------------------------------------------ 样式
  const sheets = new Map();
  /** 装一份样式（同 id 的换掉）。返回撤销函数。 */
  function installStyle(id, css, owner) {
    removeStyle(id);
    const text = String(css ?? "");
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      sheets.set(id, { sheet });
    } catch {
      // 老内核没有可构造样式表：退回 <style>（页面 CSP 不放行时它不生效，但也不出错）。
      const node = own(el("style", { text }), "style");
      if (owner) node.setAttribute(EXT_ATTR, owner);
      (document.head || document.documentElement).append(node);
      sheets.set(id, { node });
    }
    return () => removeStyle(id);
  }
  function removeStyle(id) {
    const entry = sheets.get(id);
    if (!entry) return;
    sheets.delete(id);
    if (entry.sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== entry.sheet);
    entry.node?.remove();
  }
  state.addStyle = (key, file, css) => installStyle(`package:${key}:${file}`, css, key);

  // 颜色、字体引用 Claude 自己的变量（--bg-000、--text-100、--border-300 是「H S% L%」三元组），都给了兜底值。
  installStyle("runtime", `
    [${OWN_ATTR}]{font-family:var(--font-anthropic-sans,var(--font-sans,system-ui,sans-serif));-webkit-app-region:no-drag}
    [${OWN_ATTR}="toasts"]{position:fixed;right:20px;bottom:20px;z-index:2147483646;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}
    .codex-delete-toast{pointer-events:auto;max-width:min(420px,calc(100vw - 40px));padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;
      background:hsl(var(--bg-000,0 0% 100%));color:hsl(var(--text-100,60 2.6% 7.6%));border:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.15);box-shadow:0 4px 16px hsl(0 0% 0%/.12)}
    .codex-delete-toast[data-toast-type="success"]{border-left:3px solid hsl(140 45% 42%)}
    .codex-delete-toast[data-toast-type="warn"]{border-left:3px solid hsl(38 90% 50%)}
    .codex-delete-toast[data-toast-type="error"]{border-left:3px solid hsl(var(--danger-100,0 56.2% 45.4%))}
    .codex-plus-ask-overlay{position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;justify-content:center;background:hsl(0 0% 0%/.35)}
    .codex-plus-ask{width:min(440px,calc(100vw - 48px));display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:14px;font-size:13px;
      background:hsl(var(--bg-000,0 0% 100%));color:hsl(var(--text-100,60 2.6% 7.6%));border:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.15);box-shadow:0 16px 48px hsl(0 0% 0%/.25)}
    .codex-plus-ask-title{font-size:15px;font-weight:600}
    .codex-plus-ask-message{white-space:pre-wrap;line-height:1.5;color:hsl(var(--text-300,60 2.5% 23.3%))}
    .codex-plus-ask-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.25);background:transparent;color:inherit;font:inherit;resize:vertical}
    .codex-plus-ask-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
    .codex-plus-ask-actions button{padding:6px 14px;border-radius:8px;border:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.25);background:transparent;color:inherit;cursor:pointer;font:inherit}
    .codex-plus-ask-actions button:hover{background:hsl(var(--bg-300,48 25% 92.2%))}
    .codex-plus-ask-actions .codex-plus-ask-option:last-child{background:hsl(var(--text-100,60 2.6% 7.6%));color:hsl(var(--bg-000,0 0% 100%));border-color:transparent}
    .codex-plus-page-overlay{position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;background:hsl(var(--bg-100,48 33.3% 97.1%));color:hsl(var(--text-100,60 2.6% 7.6%));font-size:14px}
    .codex-plus-page-head{flex:none;display:flex;align-items:center;gap:10px;height:48px;padding:0 16px;border-bottom:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.12)}
    .codex-plus-page-title{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .codex-plus-page-close{width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1}
    .codex-plus-page-close:hover{background:hsl(var(--bg-300,48 25% 92.2%))}
    .codex-plus-page-body{flex:1;min-height:0;overflow:auto}
    [${OWN_ATTR}="ball"]{position:fixed;right:20px;bottom:88px;z-index:2147483590;width:36px;height:36px;border-radius:999px;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;
      background:hsl(var(--bg-000,0 0% 100%));color:hsl(var(--text-200,60 2.5% 23.3%));border:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.15);box-shadow:0 4px 14px hsl(0 0% 0%/.14)}
    [${OWN_ATTR}="ball"]:hover{background:hsl(var(--bg-200,53 28.6% 94.5%))}
    [${OWN_ATTR}="ball-panel"]{position:fixed;right:20px;bottom:132px;z-index:2147483591;width:min(360px,calc(100vw - 40px));max-height:min(520px,calc(100vh - 180px));display:flex;flex-direction:column;border-radius:12px;overflow:hidden;font-size:13px;
      background:hsl(var(--bg-000,0 0% 100%));color:hsl(var(--text-100,60 2.6% 7.6%));border:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.15);box-shadow:0 12px 36px hsl(0 0% 0%/.2)}
    .codex-plus-ball-tabs{flex:none;display:flex;gap:2px;padding:6px;overflow-x:auto;border-bottom:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.12)}
    .codex-plus-ball-tab{flex:none;display:flex;align-items:center;gap:6px;padding:5px 10px;border:0;border-radius:6px;background:transparent;color:hsl(var(--text-300,60 2.5% 23.3%));cursor:pointer;font:inherit;white-space:nowrap}
    .codex-plus-ball-tab[aria-selected="true"],.codex-plus-ball-tab:hover{background:hsl(var(--bg-300,48 25% 92.2%));color:hsl(var(--text-100,60 2.6% 7.6%))}
    .codex-plus-ball-body{flex:1;min-height:0;overflow:auto;padding:8px}
    .codex-plus-ball-row{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left}
    .codex-plus-ball-row:hover{background:hsl(var(--bg-300,48 25% 92.2%))}
    .codex-plus-icon{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1}
    .codex-plus-icon svg{width:16px;height:16px}
    .codex-plus-empty{padding:12px 8px;color:hsl(var(--text-400,51 3.1% 43.7%))}
  `);

  // ------------------------------------------------------------------ 语言
  const localeEntries = new Map();
  const FALLBACK_LOCALE = "en";
  function currentLocale() {
    return String(document.documentElement?.lang || navigator.language || FALLBACK_LOCALE).trim() || FALLBACK_LOCALE;
  }
  function localeChain(locale = currentLocale()) {
    const exact = String(locale);
    return [...new Set([exact, exact.toLowerCase(), exact.split(/[-_]/)[0].toLowerCase(), FALLBACK_LOCALE])];
  }
  function registerLocale(ns, lang, dict) {
    if (!dict || typeof dict !== "object") throw new Error(`词条必须是对象：${ns}/${lang}`);
    const entry = { lang: String(lang), dict };
    if (!localeEntries.has(ns)) localeEntries.set(ns, []);
    localeEntries.get(ns).unshift(entry);
    return () => {
      const list = localeEntries.get(ns) || [];
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
      if (!list.length) localeEntries.delete(ns);
    };
  }
  function localeLookup(dict, key) {
    if (typeof dict[key] === "string") return dict[key];
    let node = dict;
    for (const part of String(key).split(".")) {
      if (!node || typeof node !== "object") return undefined;
      node = node[part];
    }
    return typeof node === "string" ? node : undefined;
  }
  function translate(ns, key, params) {
    let text;
    search: for (const space of [ns, "common"]) {
      const list = localeEntries.get(space);
      if (!list) continue;
      for (const lang of localeChain()) {
        for (const entry of list) {
          if (entry.lang.toLowerCase() !== lang.toLowerCase()) continue;
          text = localeLookup(entry.dict, key);
          if (text !== undefined) break search;
        }
      }
    }
    if (text === undefined) text = String(key);
    if (!params || typeof params !== "object") return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
  }
  function resolveText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "object") return String(value);
    for (const lang of localeChain()) {
      const hit = Object.keys(value).find((key) => key.toLowerCase() === lang.toLowerCase());
      if (hit && typeof value[hit] === "string") return value[hit];
    }
    return Object.values(value).find((item) => typeof item === "string") ?? "";
  }
  /** 运行时自己的界面文字：页面是中文就用中文，否则英文。 */
  function ui(zh, en) {
    return /^zh/i.test(currentLocale()) ? zh : en;
  }

  // ------------------------------------------------------------------ 事件、中间件、服务
  const listeners = new Map();
  const interceptors = new Map();
  let interceptorSeq = 0;
  const instances = new Set();
  const services = new Map();
  let serviceSeq = 0;
  const serviceFibers = new Set();
  const SERVICE_NAME = /^[A-Za-z][\w.-]{0,63}$/;

  function emitEvent(event, args = []) {
    const set = listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) runCallback(listener.scriptKey, `on:${event}`, () => listener.handler(...args));
  }

  function runWaterfall(name, value) {
    const chain = [...(interceptors.get(name) || [])];
    const step = (index, current) => {
      if (index >= chain.length) return current;
      const item = chain[index];
      let called = false;
      let downstream;
      const next = (nextValue = current) => {
        called = true;
        downstream = step(index + 1, nextValue);
        return downstream;
      };
      const recover = () => (called ? downstream : step(index + 1, current));
      const outcome = runCallback(item.scriptKey, `intercept:${name}`, () => item.handler(current, next));
      if (!outcome.ok) return recover();
      if (isThenable(outcome.value)) {
        return Promise.resolve(outcome.value).catch((error) => {
          markFailure(item.scriptKey, `intercept:${name}: ${errorText(error)}`);
          return recover();
        });
      }
      return outcome.value;
    };
    return step(0, value);
  }

  function normalizeInject(inject) {
    if (!inject) return [];
    const names = Array.isArray(inject) ? inject : typeof inject === "object" ? Object.keys(inject) : [inject];
    return [...new Set(names.map(String).filter((name) => SERVICE_NAME.test(name)))];
  }
  function requiredInject(inject) {
    if (!inject || Array.isArray(inject) || typeof inject !== "object") return normalizeInject(inject);
    return normalizeInject(Object.keys(inject).filter((name) => inject[name]?.required !== false));
  }
  function serviceChanged() {
    for (const fiber of [...serviceFibers]) {
      try {
        fiber.check();
      } catch {}
    }
  }
  function provideService(name, value, owner) {
    if (!SERVICE_NAME.test(String(name))) throw new Error(`服务名不合法：${name}`);
    const existing = services.get(name);
    if (existing) throw new Error(`服务 ${name} 已由 ${existing.owner || "其它拓展"} 提供`);
    const entry = { value, owner, token: (serviceSeq += 1) };
    services.set(name, entry);
    serviceChanged();
    return () => {
      if (services.get(name) !== entry) return;
      services.delete(name);
      serviceChanged();
    };
  }

  let changedTimer = null;
  function scheduleExtensionsChanged() {
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => {
      const extensions = [...instances].map((instance) => ({ id: instance.id, scriptKey: instance.scriptKey, version: instance.manifest?.version ?? null }));
      emitEvent("extensions/changed", [{ extensions }]);
    }, 300);
  }

  let localeWatcher = false;
  function watchLocale() {
    if (localeWatcher || typeof MutationObserver !== "function") return;
    localeWatcher = true;
    let last = currentLocale();
    new MutationObserver(() => {
      const next = currentLocale();
      if (next === last) return;
      last = next;
      emitEvent("locale/change", [{ locale: next }]);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }

  // ------------------------------------------------------------------ 扫描调度
  // Claude 的界面变了（切会话、侧栏重建、输入框重建）时跑登记的步骤：light 每帧合并一次，deferred 停顿 200ms 后跑。
  // 变更落在运行时或拓展自己的节点里的一律不算，否则会「写入 → 看到自己的写入 → 再扫 → 再写入」。
  const scanSteps = { light: new Set(), deferred: new Set() };
  let scanObserver = null;
  let scanFrame = 0;
  let scanTimer = 0;
  let scanDeadline = 0;
  let scanMissed = false;

  function isOwnNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return !!element?.closest?.(`[${OWN_ATTR}], [${EXT_ATTR}]`);
  }
  function mutationMatters(record) {
    if (isOwnNode(record.target)) return false;
    const touched = [...record.addedNodes, ...record.removedNodes];
    return !touched.length || touched.some((node) => !(node.nodeType === 1 && (node.hasAttribute(OWN_ATTR) || node.hasAttribute(EXT_ATTR))) && !isOwnNode(node));
  }
  function runScanSteps(phase) {
    for (const step of [...scanSteps[phase]]) {
      try {
        step();
      } catch {}
    }
  }
  function scheduleScan() {
    if (document.hidden) {
      scanMissed = true;
      return;
    }
    if (!scanFrame && scanSteps.light.size) {
      scanFrame = requestAnimationFrame(() => {
        scanFrame = 0;
        runScanSteps("light");
      });
    }
    if (!scanSteps.deferred.size) return;
    const now = Date.now();
    if (!scanDeadline) scanDeadline = now + 1000;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanDeadline = 0;
      runScanSteps("deferred");
    }, Math.max(0, Math.min(200, scanDeadline - now)));
  }
  function ensureScanObserver() {
    if (scanObserver || typeof MutationObserver !== "function") return;
    scanObserver = new MutationObserver((records) => {
      if (records.some(mutationMatters)) scheduleScan();
    });
    scanObserver.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && scanMissed) {
        scanMissed = false;
        scheduleScan();
      }
    });
    // 单页应用切会话不一定动得到我们看的节点，地址变了也扫一遍。
    for (const type of ["popstate", "hashchange"]) window.addEventListener(type, scheduleScan);
  }
  function registerScanStep(step, phase) {
    const set = scanSteps[phase === "light" ? "light" : "deferred"];
    set.add(step);
    ensureScanObserver();
    return () => set.delete(step);
  }

  // ------------------------------------------------------------------ 当前会话
  /** 会话 id 取地址里最后一段 UUID（/chat/<id>、/code/<id> 这类）；首页、新对话没有时为空串。 */
  function currentSessionId() {
    const matches = String(location.pathname || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    return matches ? matches[matches.length - 1] : "";
  }
  function currentSession() {
    return Object.freeze({ id: currentSessionId(), title: String(document.title || ""), hostId: "local", remote: false });
  }

  // ------------------------------------------------------------------ 提示
  const TOAST_LIMIT = 3;
  function toastHost() {
    let host = document.querySelector(`[${OWN_ATTR}="toasts"]`);
    if (!host) {
      host = own(el("div"), "toasts");
      (document.body || document.documentElement).append(host);
    }
    return host;
  }
  function showToast(message, options = {}) {
    const host = toastHost();
    while (host.children.length >= TOAST_LIMIT) host.firstElementChild.remove();
    const type = typeof options.type === "string" ? options.type : "";
    const toast = el("div", { class: constants.toastClass, role: "status", "data-toast-type": type || undefined, text: message });
    host.append(toast);
    const timer = setTimeout(() => toast.remove(), type === "error" ? 7000 : 4000);
    return () => {
      clearTimeout(timer);
      toast.remove();
    };
  }

  // ------------------------------------------------------------------ 向用户提问
  let askQueue = Promise.resolve();
  function ask(question = {}) {
    const run = () => new Promise((resolve) => {
      const options = (Array.isArray(question.options) && question.options.length ? question.options : [{ value: "ok", label: ui("确定", "OK") }])
        .slice(0, 6)
        .map((option) => (typeof option === "object" && option ? { value: option.value ?? option.label, label: String(option.label ?? option.value) } : { value: option, label: String(option) }));
      const field = question.input
        ? el(question.input.multiline ? "textarea" : "input", { class: "codex-plus-ask-input", rows: question.input.multiline ? 4 : undefined, type: question.input.multiline ? undefined : "text" })
        : null;
      if (field) {
        field.value = String(question.input.default ?? "");
        field.placeholder = String(question.input.placeholder ?? "");
      }
      const cancel = el("button", { type: "button", class: "codex-plus-ask-cancel", text: ui("取消", "Cancel") });
      const buttons = options.map((option) => el("button", { type: "button", class: "codex-plus-ask-option", text: option.label }));
      const overlay = own(el("div", { class: "codex-plus-ask-overlay" }, [
        el("div", { class: "codex-plus-ask", role: "dialog", "aria-modal": "true" }, [
          el("div", { class: "codex-plus-ask-title", text: resolveText(question.title) || ui("拓展想问你", "An extension is asking") }),
          question.message ? el("div", { class: "codex-plus-ask-message", text: resolveText(question.message) }) : null,
          field,
          el("div", { class: "codex-plus-ask-actions" }, [cancel, ...buttons]),
        ]),
      ]), "ask");
      let timer = null;
      const finish = (answer) => {
        clearTimeout(timer);
        overlay.remove();
        window.removeEventListener("keydown", onKey, true);
        resolve(answer);
      };
      const answerOf = (index) => ({ value: options[index].value, text: field ? field.value : null });
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          finish(null);
        } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing && (!field || field.tagName === "INPUT")) {
          event.preventDefault();
          event.stopImmediatePropagation();
          finish(answerOf(options.length - 1));
        }
      };
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish(null);
      });
      cancel.addEventListener("click", () => finish(null));
      buttons.forEach((button, index) => button.addEventListener("click", () => finish(answerOf(index))));
      // 在 window 的捕获阶段接：页面自己会在 document 上把按键截走。
      window.addEventListener("keydown", onKey, true);
      document.body.append(overlay);
      (field || buttons[buttons.length - 1])?.focus();
      const timeoutMs = Number(question.timeoutMs);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => finish(null), timeoutMs);
    });
    const answer = askQueue.then(run, run);
    askQueue = answer.catch(() => null);
    return answer;
  }

  // ------------------------------------------------------------------ 整页页面
  let openPage = null;
  function closePage() {
    const page = openPage;
    if (!page) return;
    openPage = null;
    window.removeEventListener("keydown", page.onKey, true);
    if (typeof page.cleanup === "function") runCallback(page.scriptKey, "page.cleanup", page.cleanup);
    page.overlay.remove();
    refreshHosts();
  }
  function showPage(pageId) {
    const definition = registry.pages.get(pageId);
    if (!definition) return false;
    closePage();
    closeBallPanel();
    const body = el("div", { class: "codex-plus-page-body", [EXT_ATTR]: definition.scriptKey || "runtime" });
    const close = el("button", { type: "button", class: "codex-plus-page-close", "aria-label": ui("关闭", "Close"), text: "✕" });
    const overlay = own(el("div", { class: constants.pageClass, role: "dialog", "aria-label": resolveText(definition.title) }, [
      el("div", { class: "codex-plus-page-head" }, [el("div", { class: "codex-plus-page-title", text: resolveText(definition.title) }), close]),
      body,
    ]), "page");
    overlay.setAttribute(constants.pageNavAttribute, pageId);
    const onKey = (event) => {
      if (event.key !== "Escape" || document.querySelector(".codex-plus-ask-overlay")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closePage();
    };
    close.addEventListener("click", closePage);
    window.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    openPage = { pageId, overlay, onKey, scriptKey: definition.scriptKey, cleanup: null };
    const result = runCallback(definition.scriptKey, `page:${pageId}`, () => definition.render({ container: body, close: closePage, script: definition.scriptKey }));
    if (!result.ok) body.append(el("div", { class: "codex-plus-empty", text: ui("这个页面出错了，详情见拓展列表。", "This page failed to render.") }));
    else if (typeof result.value === "function" && openPage) openPage.cleanup = result.value;
    refreshHosts();
    return true;
  }
  function activateNavEntry(entry) {
    if (entry.pageId) return showPage(entry.pageId);
    if (typeof entry.onActivate === "function") runCallback(entry.scriptKey, `navEntry:${entry.id}`, () => entry.onActivate());
    return true;
  }
  /** 页面被撤销（拓展卸载）时把开着的那一页关掉。 */
  hostRefreshers.add(() => {
    if (openPage && !registry.pages.has(openPage.pageId)) closePage();
  });

  function registerPage(definition, options = {}) {
    const scriptKey = currentScriptKey(options);
    const pageId = `${scriptKey}:page:${options.id || `item-${(idCounter += 1)}`}`;
    const disposePage = registerInto("page", registry.pages, pageId, definition, scriptKey);
    let disposeNav = null;
    if (options.nav !== false) {
      const entry = {
        ...definition,
        label: options.navLabel || definition.navLabel || definition.title || pageId,
        icon: options.icon || definition.icon,
        pageId,
        order: Number.isFinite(options.order) ? Number(options.order) : 0,
      };
      try {
        disposeNav = registerInto("navEntry", registry.navEntries, `${scriptKey}:navEntry:${pageId}`, entry, scriptKey);
      } catch {
        // 入口配额满了页面本身还能用（从快捷键、别的入口打开）。
      }
    }
    refreshHosts();
    return () => {
      try {
        disposeNav?.();
      } catch {}
      disposePage();
      refreshHosts();
    };
  }

  // ------------------------------------------------------------------ 悬浮球
  // 不依赖 Claude 的 DOM：放 registerFloatingTab 的页签，也是侧栏入口挂不上时页面入口的去处。
  let ballPanel = null;
  let ballTab = "";
  let ballCleanup = null;
  /** 侧栏入口有没有挂上；挂上了页面入口就不进悬浮球。由侧栏宿主（见锚点一节）维护。 */
  let railMounted = false;

  function ballEntries() {
    return railMounted ? [] : itemsOf(registry.navEntries);
  }
  function closeBallPanel() {
    if (!ballPanel) return;
    if (typeof ballCleanup === "function") runCallback("", "floatingTab.cleanup", ballCleanup);
    ballCleanup = null;
    ballPanel.remove();
    ballPanel = null;
  }
  function renderBallPanel() {
    if (!ballPanel) return;
    if (typeof ballCleanup === "function") runCallback("", "floatingTab.cleanup", ballCleanup);
    ballCleanup = null;
    const tabs = itemsOf(registry.floatingTabs);
    const entries = ballEntries();
    const choices = [...(entries.length ? [{ id: "", title: ui("页面", "Pages"), icon: "☰" }] : []), ...tabs];
    if (!choices.length) return closeBallPanel();
    if (!choices.some((choice) => choice.id === ballTab)) ballTab = choices[0].id;
    const body = el("div", { class: "codex-plus-ball-body" });
    const bar = el("div", { class: "codex-plus-ball-tabs", role: "tablist" }, choices.map((choice) => {
      const icon = el("span", { class: "codex-plus-icon" });
      setIcon(icon, choice.icon, "•");
      const button = el("button", { type: "button", class: "codex-plus-ball-tab", role: "tab", "aria-selected": String(choice.id === ballTab) }, [icon, resolveText(choice.title)]);
      button.addEventListener("click", () => {
        ballTab = choice.id;
        renderBallPanel();
      });
      return button;
    }));
    ballPanel.replaceChildren(...(choices.length > 1 ? [bar, body] : [body]));
    if (!ballTab) {
      for (const entry of entries) {
        const icon = el("span", { class: "codex-plus-icon" });
        setIcon(icon, entry.icon, "▫");
        const row = el("button", { type: "button", class: "codex-plus-ball-row" }, [icon, resolveText(entry.label)]);
        row.addEventListener("click", () => {
          closeBallPanel();
          activateNavEntry(entry);
        });
        body.append(row);
      }
      return;
    }
    const tab = registry.floatingTabs.get(ballTab);
    body.setAttribute(EXT_ATTR, tab.scriptKey || "runtime");
    const result = runCallback(tab.scriptKey, `floatingTab:${tab.id}`, () => tab.render({ container: body, close: closeBallPanel }));
    if (result.ok && typeof result.value === "function") ballCleanup = result.value;
  }
  function refreshBall() {
    const wanted = registry.floatingTabs.size > 0 || ballEntries().length > 0;
    let ball = document.querySelector(`[${OWN_ATTR}="ball"]`);
    if (!wanted) {
      ball?.remove();
      closeBallPanel();
      return;
    }
    if (!document.body) return;
    if (!ball) {
      ball = own(el("button", { type: "button", "aria-label": ui("拓展", "Extensions"), title: ui("拓展", "Extensions"), text: "✦" }), "ball");
      ball.addEventListener("click", () => {
        if (ballPanel) return closeBallPanel();
        ballPanel = own(el("div", { role: "dialog", "aria-label": ui("拓展", "Extensions") }), "ball-panel");
        document.body.append(ballPanel);
        renderBallPanel();
      });
      document.body.append(ball);
    }
    if (ballPanel) renderBallPanel();
  }
  hostRefreshers.add(refreshBall);
  window.addEventListener("pointerdown", (event) => {
    if (ballPanel && !event.target?.closest?.(`[${OWN_ATTR}="ball"], [${OWN_ATTR}="ball-panel"]`)) closeBallPanel();
  }, true);

  // ------------------------------------------------------------------ 快捷键
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  function parseShortcut(text) {
    const spec = { ctrl: false, meta: false, shift: false, alt: false, key: "" };
    for (const part of String(text || "").split("+").map((item) => item.trim()).filter(Boolean)) {
      const lower = part.toLowerCase();
      if (lower === "mod") spec[IS_MAC ? "meta" : "ctrl"] = true;
      else if (lower === "ctrl" || lower === "control") spec.ctrl = true;
      else if (lower === "cmd" || lower === "meta" || lower === "command") spec.meta = true;
      else if (lower === "shift") spec.shift = true;
      else if (lower === "alt" || lower === "option") spec.alt = true;
      else if (spec.key) throw new Error(`快捷键 ${text} 只能有一个主键`);
      else spec.key = lower === "space" ? " " : lower;
    }
    if (!spec.key) throw new Error(`快捷键 ${text} 缺少主键`);
    if (!spec.ctrl && !spec.meta && !spec.alt && !/^f\d{1,2}$/.test(spec.key)) throw new Error(`快捷键 ${text} 需要带 Mod / Ctrl / Alt（或用 F1~F12），免得吞掉普通输入`);
    return spec;
  }
  function shortcutMatches(spec, event) {
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "").toLowerCase();
    const sameKey = key === spec.key || code === `key${spec.key}` || code === `digit${spec.key}`;
    return sameKey && event.ctrlKey === spec.ctrl && event.metaKey === spec.meta && event.shiftKey === spec.shift && event.altKey === spec.alt;
  }
  let shortcutHandler = false;
  function registerShortcut(definition, options = {}) {
    if (typeof definition?.run !== "function") throw new Error("快捷键需要 run()");
    const spec = parseShortcut(definition.key);
    const dispose = registerItem("shortcut", registry.shortcuts, "registerShortcut", { ...definition, spec }, options);
    if (!shortcutHandler) {
      shortcutHandler = true;
      // window 的捕获阶段：只对匹配的组合 preventDefault，别的按键原样放过。
      window.addEventListener("keydown", (event) => {
        if (event.isComposing || !registry.shortcuts.size) return;
        const inInput = !!event.target?.closest?.("input, textarea, [contenteditable=true]");
        const item = itemsOf(registry.shortcuts).find((candidate) => shortcutMatches(candidate.spec, event) && (!inInput || candidate.allowInInput !== false));
        if (!item) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const result = runCallback(item.scriptKey, `shortcut:${item.key}`, () => item.run({ event }));
        if (result.ok && isThenable(result.value)) result.value.catch((error) => markFailure(item.scriptKey, `shortcut:${item.key}: ${errorText(error)}`));
      }, true);
    }
    return dispose;
  }

  // ------------------------------------------------------------------ 主题
  const THEME_STORAGE_KEY = "codexPlusExtensionTheme";
  function currentThemeId() {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }
  function themeCss(theme) {
    const variables = Object.entries(theme.variables || {})
      .filter(([name]) => /^--[\w-]+$/.test(name))
      .map(([name, value]) => `${name}:${String(value).replace(/[;{}]/g, "")}`)
      .join(";");
    return `${variables ? `:root{${variables}}\n` : ""}${typeof theme.css === "string" ? theme.css : ""}`;
  }
  /** 把记住的主题画上去；主题没注册（拓展停用）时撤掉样式但保留选择，拓展回来后自动恢复。 */
  function applyTheme() {
    const id = currentThemeId();
    const theme = id ? itemsOf(registry.themes).find((item) => item.themeId === id) : null;
    if (!theme) {
      removeStyle("theme");
      document.documentElement.removeAttribute("data-codex-plus-theme");
      return;
    }
    installStyle("theme", themeCss(theme), theme.scriptKey);
    document.documentElement.setAttribute("data-codex-plus-theme", id);
  }
  function registerTheme(definition, options = {}) {
    const themeId = String(definition?.id || "").trim();
    if (!/^[\w-]{1,48}$/.test(themeId)) throw new Error("主题 id 只能是字母、数字、_、-");
    if (!definition.variables && typeof definition.css !== "string") throw new Error(`主题 ${themeId} 需要 variables 或 css`);
    const dispose = registerItem("theme", registry.themes, "registerTheme", { ...definition, themeId, name: definition.name || themeId }, { ...options, id: options.id || `theme-${themeId}` });
    applyTheme();
    return () => {
      dispose();
      applyTheme();
    };
  }
  const themesService = Object.freeze({
    list: () => itemsOf(registry.themes).map((item) => ({ id: item.themeId, name: resolveText(item.name), extension: item.scriptKey })),
    get current() {
      return currentThemeId() || null;
    },
    apply(id) {
      const next = id ? String(id) : "";
      if (next && !itemsOf(registry.themes).some((item) => item.themeId === next)) throw new Error(`没有主题 ${next}`);
      try {
        if (next) localStorage.setItem(THEME_STORAGE_KEY, next);
        else localStorage.removeItem(THEME_STORAGE_KEY);
      } catch {}
      applyTheme();
      emitEvent("theme/change", [{ id: next || null }]);
      return next || null;
    },
  });
  services.set("themes", { value: themesService, owner: "builtin", token: (serviceSeq += 1) });

  for (const name of ["toast", "ask", "registerPage", "registerNavEntry", "registerFloatingTab", "registerShortcut", "registerTheme"]) {
    mountSupport.set(name, () => true);
  }

  // ------------------------------------------------------------------ 挂在 Claude 界面上的位置
  // 下面这些挂载点要挂在 Claude 自己的 DOM 上，位置来自锚点表（page-anchors.js）。约定：
  //   - 每个宿主函数都幂等：按「登记了哪些项」算一个指纹写在容器上，指纹没变就不动 DOM；
  //   - 样子照原生控件：按钮、侧栏行直接克隆旁边的原生控件再换图标和文字，Claude 改了样式自动跟着变；
  //   - 锚点找不到就什么都不做（并回报「没挂上」），不抛错。
  const anchorList = (name) => (Array.isArray(anchors[name]) ? anchors[name] : []);
  const find = (name, root = document) => {
    for (const selector of anchorList(name)) {
      const node = root.querySelector(selector);
      if (node && !node.closest(`[${OWN_ATTR}]`)) return node;
    }
    return null;
  };
  const findAll = (name, root = document) => {
    for (const selector of anchorList(name)) {
      const nodes = [...root.querySelectorAll(selector)].filter((node) => !node.closest(`[${OWN_ATTR}]`));
      if (nodes.length) return nodes;
    }
    return [];
  };
  const lca = (a, b) => {
    for (let node = a; node; node = node.parentElement) if (node.contains(b)) return node;
    return null;
  };
  const childOf = (parent, node) => {
    let cursor = node;
    while (cursor && cursor.parentElement !== parent) cursor = cursor.parentElement;
    return cursor;
  };
  const ownChild = (parent, name) => [...parent.children].find((child) => child.getAttribute(OWN_ATTR) === name) || null;
  const insertAfter = (reference, node) => reference.parentElement.insertBefore(node, reference.nextElementSibling);
  /** 记下某个挂载点现在挂上了没有（只在有东西要挂的时候记）。 */
  const setMount = (name, ok) => {
    const value = ok ? "ok" : "missing";
    if (mounts[name] === value) return;
    mounts[name] = value;
    scheduleReport();
  };
  const fingerprint = (items, extra = "") => (items.length ? `${items.map((item) => item.id).join("|")}#${extra}` : "");

  /**
   * 取（或重建）parent 下名为 name 的宿主容器。指纹没变返回 null（不用重画）；指纹为空表示没有东西要放，只清掉旧的。
   * 容器里交给拓展画过的内容有清理函数时，换掉容器前先调。
   */
  const hostCleanups = new WeakMap();
  function dropHost(node) {
    for (const cleanup of hostCleanups.get(node) || []) runCallback(cleanup.scriptKey, "cleanup", cleanup.run);
    hostCleanups.delete(node);
    node.remove();
  }
  function ensureHost(parent, name, print, tag, place) {
    const existing = ownChild(parent, name);
    if (existing && existing.getAttribute("data-fp") === print) return null;
    if (existing) dropHost(existing);
    if (!print) return null;
    const node = own(el(tag), name);
    node.setAttribute("data-fp", print);
    place(node);
    return node;
  }

  const STRIP_ATTRIBUTE = /^(id|href|target|rel|disabled|data-testid|data-state|data-selected|data-cds|aria-.+)$/;
  function stripClone(node) {
    for (const name of node.getAttributeNames()) if (STRIP_ATTRIBUTE.test(name)) node.removeAttribute(name);
    for (const child of node.children) stripClone(child);
  }
  function iconNode(icon, fallback) {
    const node = el("span", { class: "codex-plus-icon", "aria-hidden": "true" });
    setIcon(node, icon, fallback);
    return node;
  }
  /** 照原生图标按钮（输入框的加号、消息操作行的复制）克隆一个，换上自己的图标。 */
  function cloneIconButton(sample, label, icon) {
    const button = sample.cloneNode(true);
    stripClone(button);
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("type", "button");
    const holder = button.lastElementChild || button;
    holder.textContent = "";
    holder.append(iconNode(icon, "◆"));
    return button;
  }
  /** 照原生侧栏行克隆一个：第一个子元素是图标位，第二个里最深的那个是文字，其余（快捷键提示等）去掉。 */
  function cloneNavRow(sample, label, icon) {
    const row = sample.cloneNode(true);
    stripClone(row);
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("title", label);
    const [slot, labelWrap, ...rest] = [...row.children];
    for (const extra of rest) extra.remove();
    if (slot) {
      slot.textContent = "";
      slot.append(iconNode(icon, "✦"));
    }
    let text = labelWrap || row;
    while (text.firstElementChild) text = text.firstElementChild;
    text.textContent = label;
    return row;
  }
  /** 点击和回车 / 空格都触发（克隆出来的行不一定是 button）。 */
  function onActivate(node, handler) {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      handler(event);
    });
    node.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      handler(event);
    });
  }

  // ---- 侧栏入口：registerPage / registerNavEntry
  function refreshRail() {
    const entries = itemsOf(registry.navEntries);
    const rows = find("navRows");
    const sample = rows && [...rows.querySelectorAll("a")].find((link) => link.children.length >= 2);
    if (!rows || !sample) {
      if (entries.length) setMount("rail", false);
      if (railMounted) {
        railMounted = false;
        refreshBall();
      }
      return;
    }
    const lastRow = [...rows.children].filter((child) => !child.hasAttribute(OWN_ATTR) && (child.tagName === "A" || child.querySelector("a"))).pop();
    const host = ensureHost(rows, "rail", fingerprint(entries, openPage?.pageId || ""), "div", (node) => (lastRow ? insertAfter(lastRow, node) : rows.append(node)));
    if (host) {
      for (const entry of entries) {
        const row = cloneNavRow(sample, resolveText(entry.label), entry.icon);
        own(row, "rail-entry");
        if (entry.pageId) {
          row.setAttribute(constants.pageNavAttribute, entry.pageId);
          if (openPage?.pageId === entry.pageId) row.setAttribute("data-selected", "open");
        }
        onActivate(row, () => activateNavEntry(entry));
        host.append(row);
      }
    }
    if (entries.length) setMount("rail", true);
    const mounted = entries.length > 0;
    if (railMounted !== mounted) {
      railMounted = mounted;
      refreshBall();
    }
  }

  // ---- 输入框
  const editorSelector = () => anchorList("composerEditor").join(", ");
  const composerEditorFrom = (target) => (editorSelector() && target?.closest ? target.closest(editorSelector()) : null);
  /**
   * 输入区的几个部件：编辑器、加号按钮、加号所在的那一组、整个输入框的外框。找不全返回 null。
   * 「那一组」是加号往上、既不含编辑器也不含别的原生控件的最高一层。Claude 有两种布局都要认：
   * 首页是工具行在输入框里面（加号在左边一组、麦克风等在右边一组）；对话页（合并式主页）是输入框下面单独一条，
   * 加号、麦克风、模型选择器都在那一条里。
   */
  function composerParts() {
    const editor = find("composerEditor");
    const leading = find("composerLeading");
    if (!editor || !leading) return null;
    const others = anchorList("composerTrailing").map((selector) => document.querySelector(selector)).filter(Boolean);
    let group = null;
    for (let node = leading.parentElement; node && !node.contains(editor) && !others.some((other) => node.contains(other)); node = node.parentElement) group = node;
    if (!group) return null;
    const inner = lca(editor, group);
    let box = null;
    for (const selector of anchorList("composerBox")) {
      box = inner?.closest(selector) || null;
      if (box) break;
    }
    return { editor, leading, group, box: box || inner?.parentElement || inner };
  }
  /** 往输入框光标处写字。Claude 的输入框是富文本编辑器，直接改 DOM 会被它盖掉，要走它认的输入命令。 */
  function insertIntoEditor(editor, text) {
    if (!editor) return false;
    editor.focus();
    return document.execCommand("insertText", false, String(text ?? ""));
  }
  function setEditorText(editor, text) {
    if (!editor) return false;
    editor.focus();
    const selection = window.getSelection();
    selection?.selectAllChildren(editor);
    return text ? document.execCommand("insertText", false, String(text)) : document.execCommand("delete");
  }
  function refreshComposerActions() {
    const actions = itemsOf(registry.composerActions);
    const parts = composerParts();
    if (!parts) {
      if (actions.length) setMount("composer", false);
      return;
    }
    const host = ensureHost(parts.group, "composer-actions", fingerprint(actions), "span", (node) => parts.group.append(node));
    if (host) {
      for (const action of actions) {
        const button = cloneIconButton(parts.leading, resolveText(action.label), action.icon);
        button.setAttribute(EXT_ATTR, action.scriptKey || "runtime");
        onActivate(button, () => {
          const editor = find("composerEditor");
          runCallback(action.scriptKey, `composerAction:${action.id}`, () => action.onActivate({ editor, insertText: (text) => insertIntoEditor(editor, text), close() {} }));
        });
        host.append(button);
      }
    }
    if (actions.length) setMount("composer", true);
  }

  // ---- 输入提示：斜杠命令和输入触发共用一块候选面板
  let hint = null;
  function closeHint() {
    hint = null;
    document.querySelector(`[${OWN_ATTR}="hints"]`)?.remove();
  }
  function renderHint() {
    if (!hint || !hint.items.length) {
      document.querySelector(`[${OWN_ATTR}="hints"]`)?.remove();
      return;
    }
    let panel = document.querySelector(`[${OWN_ATTR}="hints"]`);
    if (!panel) {
      panel = own(el("div", { role: "listbox" }), "hints");
      document.body.append(panel);
    }
    panel.replaceChildren(...hint.items.map((choice, index) => {
      const row = el("button", { type: "button", class: "codex-plus-hint", role: "option", "aria-selected": String(index === hint.active) }, [
        el("strong", { text: String(choice.label ?? choice.insert ?? "") }),
        choice.description ? el("span", { text: String(choice.description) }) : null,
      ]);
      row.addEventListener("pointerdown", (event) => event.preventDefault());
      row.addEventListener("click", () => acceptHint(choice));
      return row;
    }));
    const rect = hint.editor.getBoundingClientRect();
    panel.style.left = `${Math.round(rect.left)}px`;
    panel.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`;
    panel.style.minWidth = `${Math.round(Math.min(rect.width, 420))}px`;
  }
  function acceptHint(choice) {
    const current = hint;
    if (!current || !choice) return;
    closeHint();
    current.accept(choice);
  }
  /** 光标前的文字（只看光标所在的文本节点，不受富文本结构影响）。 */
  function textBeforeCaret(editor) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return null;
    const node = selection.anchorNode;
    if (!node || !editor.contains(node) || node.nodeType !== 3) return null;
    return node.textContent.slice(0, selection.anchorOffset);
  }
  function matchTrigger(before) {
    let best = null;
    for (const item of itemsOf(registry.inputTriggers)) {
      const index = before.lastIndexOf(item.trigger);
      if (index < 0 || (index > 0 && !/\s/.test(before[index - 1]))) continue;
      const query = before.slice(index + item.trigger.length);
      if (/\s/.test(query) || query.length > 64) continue;
      if (!best || index > best.index || (index === best.index && item.trigger.length > best.item.trigger.length)) best = { item, index, query };
    }
    return best;
  }
  async function updateHints(editor) {
    const whole = String(editor.textContent || "");
    // 斜杠命令：整段是「/名字」且还没打空格时，列出匹配的拓展命令。
    const command = /^\/([\w-]*)$/.exec(whole.trim());
    if (command && registry.commands.size) {
      const items = itemsOf(registry.commands)
        .filter((item) => item.name.startsWith(command[1]))
        .map((item) => ({ label: `/${item.name}`, description: resolveText(item.description), insert: `/${item.name} ` }));
      hint = { editor, items, active: 0, accept: (choice) => setEditorText(editor, choice.insert) };
      return renderHint();
    }
    const before = registry.inputTriggers.size ? textBeforeCaret(editor) : null;
    const match = before === null ? null : matchTrigger(before);
    if (!match) return closeHint();
    const token = {};
    const accept = (choice) => {
      editor.focus();
      const selection = window.getSelection();
      for (let index = 0; index < match.item.trigger.length + match.query.length; index += 1) selection.modify("extend", "backward", "character");
      document.execCommand("insertText", false, String(choice.insert ?? choice.label ?? ""));
      if (typeof choice.onSelect === "function") runCallback(match.item.scriptKey, "inputTrigger.onSelect", () => choice.onSelect());
    };
    hint = { editor, items: hint?.items || [], active: 0, accept, token };
    const result = runCallback(match.item.scriptKey, `inputTrigger.items:${match.item.trigger}`, () => match.item.items(match.query, { editor }));
    if (!result.ok) return closeHint();
    let items;
    try {
      items = await result.value;
    } catch (error) {
      markFailure(match.item.scriptKey, `inputTrigger.items: ${errorText(error)}`);
      return closeHint();
    }
    // 等候选期间又输入了：以最新一次为准。
    if (hint?.token !== token) return;
    hint.items = (Array.isArray(items) ? items : []).filter((choice) => choice && typeof choice === "object").slice(0, 12);
    renderHint();
  }
  /** 回车时整段是「/名字 参数」且名字是拓展登记的命令：拦下来交给拓展，不发给 Claude。 */
  function runCommandFrom(editor, event) {
    const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(String(editor.textContent || "").trim());
    const command = match && itemsOf(registry.commands).find((item) => item.name === match[1]);
    if (!command) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeHint();
    setEditorText(editor, "");
    const context = {
      editor,
      sessionId: currentSessionId(),
      insertText: (text) => insertIntoEditor(editor, text),
      setText: (text) => setEditorText(editor, text),
      toast: (message, options) => showToast(String(message ?? ""), options || {}),
    };
    const result = runCallback(command.scriptKey, `command:/${command.name}`, () => command.run(match[2] || "", context));
    if (result.ok && isThenable(result.value)) result.value.catch((error) => markFailure(command.scriptKey, `command:/${command.name}: ${errorText(error)}`));
    return true;
  }
  let composerHandlers = false;
  function installComposerHandlers() {
    if (composerHandlers) return;
    composerHandlers = true;
    // 都在 window 的捕获阶段接：编辑器自己在更里面处理按键，等事件到它那里就来不及拦了。
    window.addEventListener("input", (event) => {
      if (!registry.commands.size && !registry.inputTriggers.size) return;
      const editor = composerEditorFrom(event.target);
      if (editor) void updateHints(editor);
    }, true);
    window.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      const editor = composerEditorFrom(event.target);
      if (!editor) return;
      if (hint && hint.items.length) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          return closeHint();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopImmediatePropagation();
          hint.active = (hint.active + (event.key === "ArrowDown" ? 1 : -1) + hint.items.length) % hint.items.length;
          return renderHint();
        }
        if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && hint.token)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return acceptHint(hint.items[hint.active]);
        }
      }
      if (event.key === "Enter" && !event.shiftKey && registry.commands.size) runCommandFrom(editor, event);
    }, true);
    window.addEventListener("focusout", (event) => {
      if (hint && event.target === hint.editor) setTimeout(() => hint && !hint.editor.contains(document.activeElement) && closeHint(), 150);
    }, true);
  }
  function registerCommand(definition, options = {}) {
    const name = String(definition?.name || "");
    if (!/^[\w-]{1,32}$/.test(name)) throw new Error("命令名只能是字母、数字、_、-，最长 32");
    if (typeof definition.run !== "function") throw new Error(`命令 /${name} 需要 run(args, context)`);
    if (itemsOf(registry.commands).some((item) => item.name === name)) throw new Error(`命令 /${name} 已经被别的拓展登记了`);
    installComposerHandlers();
    return registerItem("command", registry.commands, "registerCommand", { ...definition, name }, { ...options, id: options.id || `command-${name}` });
  }
  function registerInputTrigger(definition, options = {}) {
    const trigger = String(definition?.trigger || "");
    if (/^[@/]/.test(trigger)) throw new Error(`触发符 ${trigger[0]} 是 Claude 自己在用的（@ 提及、/ 命令），换一个，例如 "#"`);
    if (!/^[#%&~!^:+$][\w-]{0,7}$/.test(trigger)) throw new Error('trigger 是一个符号开头的短前缀，例如 "#"、"%"、"#issue"');
    if (typeof definition.items !== "function") throw new Error(`输入触发 ${trigger} 需要 items(query) 返回候选`);
    installComposerHandlers();
    return registerItem("inputTrigger", registry.inputTriggers, "registerInputTrigger", { ...definition, trigger }, options);
  }

  // ---- 消息：操作按钮和正文下方的装饰
  const turnAttribute = () => (typeof anchors.turnAttribute === "string" ? anchors.turnAttribute : "data-turn-key");
  function messageOf(node, role) {
    const id = node.closest(`[${turnAttribute()}]`)?.getAttribute(turnAttribute()) || "";
    const content = role === "assistant" ? find("assistantContent", node) || node : node;
    return { role, id, turnId: id, conversationId: currentSessionId(), text: String(content.innerText ?? content.textContent ?? "").trim(), element: node };
  }
  const forRole = (item, role) => {
    const roles = item.roles === undefined ? [] : [].concat(item.roles);
    return !roles.length || roles.includes(role);
  };
  const visibleFor = (item, message) => {
    if (typeof item.visible !== "function") return true;
    const result = runCallback(item.scriptKey, `${item.kind}.visible`, () => item.visible(message));
    return result.ok && result.value !== false;
  };
  function refreshMessages() {
    const wanted = registry.messageActions.size + registry.messageDecorations.size + [...registry.slots.values()].filter((item) => item.slot === "turn.after").length;
    const nodes = [...findAll("userMessage").map((node) => [node, "user"]), ...findAll("assistantMessage").map((node) => [node, "assistant"])];
    if (!nodes.length) {
      // 没有消息的页面（新对话）不算没挂上。
      return;
    }
    let barFound = false;
    for (const [node, role] of nodes) {
      const message = messageOf(node, role);
      // 操作按钮：回复的操作行在消息节点里；用户消息的在它所在的那一轮里。
      const scope = role === "assistant" ? node : node.closest(`[${turnAttribute()}]`) || node.parentElement;
      const bar = scope && find(role === "assistant" ? "assistantActions" : "userActions", scope);
      const sample = bar && [...bar.children].find((child) => child.tagName === "BUTTON");
      if (bar && sample) {
        barFound = true;
        const actions = itemsOf(registry.messageActions).filter((item) => forRole(item, role) && visibleFor(item, message));
        // 插在时间戳前面，和原生按钮挨在一起。
        const before = [...bar.children].find((child) => child.tagName === "TIME") || null;
        const host = ensureHost(bar, "message-actions", fingerprint(actions), "span", (created) => bar.insertBefore(created, before));
        if (host) {
          for (const action of actions) {
            const button = cloneIconButton(sample, resolveText(action.label), action.icon);
            button.setAttribute(EXT_ATTR, action.scriptKey || "runtime");
            onActivate(button, () => runCallback(action.scriptKey, `messageAction:${action.id}`, () => action.onActivate({ message: messageOf(node, role), close() {} })));
            host.append(button);
          }
        }
      }
      // 装饰：回复的放在正文和操作行之间，用户消息的放在气泡下面。文字变了（流式输出）重画。
      const decorations = itemsOf(registry.messageDecorations).filter((item) => forRole(item, role) && visibleFor(item, message));
      const parent = role === "assistant" ? node : node.parentElement;
      if (parent) {
        const host = ensureHost(parent, "message-decorations", fingerprint(decorations, `${message.id}:${message.text.length}`), "div", (created) => {
          if (role === "assistant") parent.insertBefore(created, bar ? childOf(parent, bar) : null);
          else insertAfter(node, created);
        });
        if (host) {
          for (const item of decorations) {
            const container = el("div", { [EXT_ATTR]: item.scriptKey || "runtime" });
            host.append(container);
            runCallback(item.scriptKey, `messageDecoration:${item.id}`, () => item.render({ message, container }));
          }
        }
      }
      if (role === "assistant") renderSlot("turn.after", node, (created) => node.append(created), { turnKey: message.id }, `slot:turn.after`);
    }
    if (wanted) setMount("messages", barFound || !registry.messageActions.size);
  }

  // ---- 固定位置的插槽：registerSlot
  /** 把登记在 name 上的插槽画进 parent 下的一个容器；容器新建时各调一次 render，可返回清理函数。 */
  function renderSlot(name, parent, place, context = {}, hostName = `slot:${name}`) {
    const slots = itemsOf(registry.slots).filter((item) => item.slot === name);
    const host = ensureHost(parent, hostName, fingerprint(slots, String(context.turnKey || context.sessionId || "")), "div", place);
    if (!host) return;
    const cleanups = [];
    for (const item of slots) {
      const container = el("div", { [EXT_ATTR]: item.scriptKey || "runtime" });
      host.append(container);
      const result = runCallback(item.scriptKey, `slot:${name}`, () => item.render({ container, slot: name, ...context }));
      if (result.ok && typeof result.value === "function") cleanups.push({ scriptKey: item.scriptKey, run: result.value });
    }
    hostCleanups.set(host, cleanups);
  }
  /** 各插槽在哪：返回 [父节点, 放置函数]，这个页面上没有对应位置时返回 null。 */
  const slotPlaces = {
    "composer.above": () => {
      const box = composerParts()?.box;
      return box?.parentElement ? [box.parentElement, (node) => box.parentElement.insertBefore(node, box)] : null;
    },
    "composer.below": () => {
      const box = composerParts()?.box;
      return box?.parentElement ? [box.parentElement, (node) => insertAfter(box, node)] : null;
    },
    "thread.top": () => {
      const list = find("transcript");
      return list ? [list, (node) => list.insertBefore(node, list.firstElementChild)] : null;
    },
    "thread.bottom": () => {
      const list = find("transcript");
      const end = list && find("transcriptEnd", list);
      return list ? [end?.parentElement || list, (node) => (end ? end.parentElement.insertBefore(node, end) : list.append(node))] : null;
    },
    "sidebar.top": () => {
      const rows = find("navRows");
      return rows?.parentElement ? [rows.parentElement, (node) => rows.parentElement.insertBefore(node, rows)] : null;
    },
    "sidebar.bottom": () => {
      const sidebar = find("sidebar");
      const footer = sidebar && find("sidebarFooter", sidebar);
      const tray = footer && childOf(sidebar, footer);
      return tray ? [sidebar, (node) => sidebar.insertBefore(node, tray)] : null;
    },
    titlebar: () => {
      const group = find("headerActions");
      return group ? [group, (node) => group.insertBefore(node, group.firstElementChild)] : null;
    },
    // 盖在整个页面上的一层，不依赖 Claude 的 DOM；默认不接鼠标，拓展自己的内容要接时设 pointer-events:auto。
    overlay: () => (document.body ? [document.body, (node) => document.body.append(node)] : null),
  };
  function refreshSlots() {
    for (const [name, place] of Object.entries(slotPlaces)) {
      const used = [...registry.slots.values()].some((item) => item.slot === name);
      const target = place();
      if (!target) {
        // 新对话页没有对话区、没有头部按钮组：不算没挂上，等切到有的页面再挂。
        continue;
      }
      renderSlot(name, target[0], target[1]);
      if (used) setMount(`slot:${name}`, true);
    }
    // 会话行后缀：最近对话列表的每一行。
    const rowSlots = [...registry.slots.values()].some((item) => item.slot === "sessionRow.suffix");
    for (const row of sessionRows()) {
      renderSlot("sessionRow.suffix", row.controls, (node) => row.controls.insertBefore(node, row.controls.firstElementChild), { sessionId: row.sessionId, title: row.title });
    }
    if (rowSlots && sessionRows().length) setMount("slot:sessionRow.suffix", true);
  }

  // ---- 会话行：registerRowAction
  /** 最近对话列表里的行：{ row, link, controls（放「更多选项」的那个容器）, sample（原生按钮）, sessionId, title }。 */
  function sessionRows() {
    const recents = find("recents");
    if (!recents) return [];
    const out = [];
    for (const link of recents.querySelectorAll("a")) {
      const id = /\/chat\/([0-9a-f-]{8,})/i.exec(String(link.getAttribute("href") || ""))?.[1];
      const row = link.parentElement;
      const sample = id && row ? [...row.querySelectorAll("button")].find((button) => !button.closest(`[${OWN_ATTR}]`)) : null;
      if (!id || !sample) continue;
      out.push({ row, link, controls: sample.parentElement, sample, sessionId: id, title: String(link.textContent || "").trim() });
    }
    return out;
  }
  function refreshRowActions() {
    const actions = itemsOf(registry.rowActions).filter((item) => !item.surfaces || [].concat(item.surfaces).includes("sidebar"));
    const rows = sessionRows();
    for (const info of rows) {
      const host = ensureHost(info.controls, "row-actions", fingerprint(actions, info.sessionId), "span", (node) => info.controls.insertBefore(node, info.controls.firstElementChild));
      if (!host) continue;
      for (const action of actions) {
        const button = cloneIconButton(info.sample, resolveText(action.label), action.icon);
        button.setAttribute(EXT_ATTR, action.scriptKey || "runtime");
        if (action.className) button.className += ` ${action.className}`;
        if (typeof action.onMount === "function") runCallback(action.scriptKey, `rowAction.onMount:${action.id}`, () => action.onMount({ button, row: info.row, session_id: info.sessionId }));
        onActivate(button, (event) => {
          event.stopPropagation();
          const context = {
            row: info.row, session_id: info.sessionId, title: info.title, archived: false, button, event, close() {},
            resolve: () => Promise.resolve({ session_id: info.sessionId, title: info.title }),
          };
          if (typeof action.onActivate === "function") runCallback(action.scriptKey, `rowAction:${action.id}`, () => action.onActivate(context));
        });
        host.append(button);
      }
    }
    if (actions.length && rows.length) setMount("rows", true);
  }

  // ---- 右侧面板：registerSidePanel
  let openPanel = null;
  function closeSidePanel() {
    const panel = openPanel;
    if (!panel) return false;
    openPanel = null;
    if (typeof panel.cleanup === "function") runCallback(panel.scriptKey, "sidePanel.cleanup", panel.cleanup);
    panel.node.remove();
    const pane = find("pane");
    if (pane) pane.style.marginInlineEnd = "";
    refreshHosts();
    return true;
  }
  function openSidePanel(id) {
    const definition = registry.sidePanels.get(id);
    if (!definition) return false;
    closeSidePanel();
    const width = Math.min(720, Math.max(240, Number(definition.width) || 360));
    const body = el("div", { class: "codex-plus-panel-body", [EXT_ATTR]: definition.scriptKey || "runtime" });
    const close = el("button", { type: "button", class: "codex-plus-page-close", "aria-label": ui("关闭", "Close"), text: "✕" });
    const node = own(el("aside", { "aria-label": resolveText(definition.title) }, [
      el("div", { class: "codex-plus-page-head" }, [el("div", { class: "codex-plus-page-title", text: resolveText(definition.title) }), close]),
      body,
    ]), "side-panel");
    node.style.width = `${width}px`;
    close.addEventListener("click", closeSidePanel);
    document.body.append(node);
    // 主区域让出面板的宽度（面板自己是固定定位，不进 Claude 的布局）。
    const pane = find("pane");
    if (pane) pane.style.marginInlineEnd = `${width}px`;
    openPanel = { id, node, scriptKey: definition.scriptKey, cleanup: null };
    const result = runCallback(definition.scriptKey, `sidePanel:${id}`, () => definition.render({ container: body, close: closeSidePanel }));
    if (result.ok && typeof result.value === "function" && openPanel) openPanel.cleanup = result.value;
    refreshHosts();
    return true;
  }
  function registerSidePanel(definition, options = {}) {
    const scriptKey = currentScriptKey(options);
    const id = `${scriptKey}:sidePanel:${options.id || `item-${(idCounter += 1)}`}`;
    const dispose = registerInto("sidePanel", registry.sidePanels, id, definition, scriptKey);
    refreshHosts();
    const handle = () => {
      if (openPanel?.id === id) closeSidePanel();
      dispose();
      refreshHosts();
    };
    handle.open = () => openSidePanel(id);
    handle.close = () => (openPanel?.id === id ? closeSidePanel() : false);
    handle.toggle = () => (openPanel?.id === id ? closeSidePanel() : openSidePanel(id));
    return handle;
  }
  /** 面板的开关按钮放在对话页头部的按钮组里；没有头部的页面（新对话）上放进悬浮球的页签旁边由句柄打开。 */
  function refreshSidePanelToggles() {
    const panels = itemsOf(registry.sidePanels);
    if (openPanel && !registry.sidePanels.has(openPanel.id)) closeSidePanel();
    const group = find("headerActions");
    if (!group) return;
    const host = ensureHost(group, "side-panel-toggles", fingerprint(panels, openPanel?.id || ""), "span", (node) => group.append(node));
    if (host) {
      for (const panel of panels) {
        const icon = iconNode(panel.icon, "▤");
        const button = el("button", { type: "button", class: "codex-plus-toggle", "aria-label": resolveText(panel.title), title: resolveText(panel.title), "aria-pressed": String(openPanel?.id === panel.id), [EXT_ATTR]: panel.scriptKey || "runtime" }, [icon]);
        button.addEventListener("click", () => (openPanel?.id === panel.id ? closeSidePanel() : openSidePanel(panel.id)));
        host.append(button);
      }
    }
    if (panels.length) setMount("sidePanel", true);
  }

  // ---- 「拓展」页：设置面板、设置分区和菜单项的去处
  // Claude 里没有 Codex++ 的菜单和拓展详情页，registerSettingsPanel / registerSettingsSection / registerMenuItem
  // 登记的东西集中放在运行时自带的这一页里（有登记项时才出现入口）。
  const BUILTIN_KEY = "builtin:runtime";
  const BUILTIN_PAGE = `${BUILTIN_KEY}:page:extensions`;
  function renderExtensionsPage({ container }) {
    const cleanups = [];
    const section = (title) => {
      const body = el("div", { class: "codex-plus-ext-section-body" });
      container.append(el("section", { class: "codex-plus-ext-section" }, [el("h3", { text: title }), body]));
      return body;
    };
    const nameOf = (scriptKey) => state.scripts[scriptKey]?.name || scriptKey;
    const menuItems = itemsOf(registry.menuItems);
    if (menuItems.length) {
      const body = section(ui("开关与操作", "Switches and actions"));
      for (const item of menuItems) {
        const label = resolveText(item.label) || item.id;
        const control = typeof item.onChange === "function"
          ? el("input", { type: "checkbox", "aria-label": label })
          : el("button", { type: "button", class: "codex-plus-button", text: resolveText(item.buttonLabel) || ui("打开", "Open") });
        if (control.tagName === "INPUT") {
          const current = typeof item.toggleValue === "function" ? runCallback(item.scriptKey, "menuItem.toggleValue", () => item.toggleValue()) : { ok: false };
          control.checked = current.ok && current.value === true;
          control.addEventListener("change", () => runCallback(item.scriptKey, `menuItem:${item.id}`, () => item.onChange(control.checked)));
        } else {
          control.addEventListener("click", () => runCallback(item.scriptKey, `menuItem:${item.id}`, () => item.onActivate({ close: closePage })));
        }
        body.append(el("label", { class: "codex-plus-ext-row" }, [
          el("span", {}, [el("strong", { text: label }), item.description ? el("small", { text: resolveText(item.description) }) : null]),
          control,
        ]));
      }
    }
    const render = (item, label, context) => {
      const holder = el("div", { [EXT_ATTR]: item.scriptKey || "runtime" });
      section(label).append(holder);
      const result = runCallback(item.scriptKey, `${item.kind}:${item.id}`, () => item.render({ container: holder, ...context }));
      if (result.ok && typeof result.value === "function") cleanups.push(() => runCallback(item.scriptKey, `${item.kind}.cleanup`, result.value));
    };
    for (const item of itemsOf(registry.settingsSections)) render(item, resolveText(item.title), { close: closePage });
    for (const item of itemsOf(registry.settingsPanels)) {
      const config = extensionManifest(item.scriptKey)?.config ?? {};
      // 在页面里改配置还没接上：给出明确的原因，不假装保存成功。
      const saveConfig = (values) => request("config", { key: item.scriptKey, values: values ?? {} });
      render(item, nameOf(item.scriptKey), { config, saveConfig });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }
  function refreshExtensionsPage() {
    const wanted = registry.menuItems.size + registry.settingsPanels.size + registry.settingsSections.size > 0;
    const present = registry.pages.has(BUILTIN_PAGE);
    if (wanted === present) return;
    if (wanted) {
      const page = { title: ui("拓展", "Extensions"), icon: "✦", render: renderExtensionsPage };
      registerInto("page", registry.pages, BUILTIN_PAGE, page, BUILTIN_KEY);
      registerInto("navEntry", registry.navEntries, `${BUILTIN_KEY}:navEntry:extensions`, { ...page, label: page.title, pageId: BUILTIN_PAGE }, BUILTIN_KEY);
    } else {
      registry.pages.delete(BUILTIN_PAGE);
      registry.navEntries.delete(`${BUILTIN_KEY}:navEntry:extensions`);
    }
  }

  installStyle("runtime-hosts", `
    [${OWN_ATTR}="rail"]{display:flex;flex-direction:column}
    [${OWN_ATTR}="rail-entry"]{cursor:pointer}
    [${OWN_ATTR}="rail-entry"] .codex-plus-icon{width:20px;height:20px;font-size:15px}
    [${OWN_ATTR}="composer-actions"],[${OWN_ATTR}="message-actions"],[${OWN_ATTR}="row-actions"],[${OWN_ATTR}="side-panel-toggles"]{display:inline-flex;align-items:center;gap:2px;pointer-events:auto}
    [${OWN_ATTR}="composer-actions"] .codex-plus-icon{width:20px;height:20px;font-size:15px}
    [${OWN_ATTR}^="slot:"]:empty,[${OWN_ATTR}="message-decorations"]:empty{display:none}
    [${OWN_ATTR}="slot:overlay"]{position:fixed;inset:0;z-index:2147483500;pointer-events:none}
    [${OWN_ATTR}="hints"]{position:fixed;z-index:2147483640;display:flex;flex-direction:column;gap:2px;max-height:min(360px,50vh);overflow:auto;padding:6px;border-radius:12px;font-size:13px;
      background:hsl(var(--bg-000,0 0% 100%));color:hsl(var(--text-100,60 2.6% 7.6%));border:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.15);box-shadow:0 8px 24px hsl(0 0% 0%/.2)}
    .codex-plus-hint{display:flex;align-items:baseline;gap:10px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left}
    .codex-plus-hint span{color:hsl(var(--text-400,51 3.1% 43.7%))}
    .codex-plus-hint[aria-selected="true"],.codex-plus-hint:hover{background:var(--df-hover,hsl(var(--bg-300,48 25% 92.2%)))}
    .codex-plus-toggle{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}
    .codex-plus-toggle:hover,.codex-plus-toggle[aria-pressed="true"]{background:var(--df-hover,hsl(var(--bg-300,48 25% 92.2%)))}
    [${OWN_ATTR}="side-panel"]{position:fixed;top:0;right:0;bottom:0;z-index:2147483400;display:flex;flex-direction:column;font-size:14px;
      background:hsl(var(--bg-100,48 33.3% 97.1%));color:hsl(var(--text-100,60 2.6% 7.6%));border-left:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.12)}
    .codex-plus-panel-body{flex:1;min-height:0;overflow:auto}
    .codex-plus-ext-section{max-width:720px;margin:0 auto;padding:16px 20px 0}
    .codex-plus-ext-section h3{margin:0 0 8px;font-size:13px;font-weight:600;color:hsl(var(--text-300,60 2.5% 23.3%))}
    .codex-plus-ext-section-body{display:flex;flex-direction:column;border-radius:12px;background:hsl(var(--bg-000,0 0% 100%));border:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.12)}
    .codex-plus-ext-section-body > [${EXT_ATTR}]{padding:12px 14px}
    .codex-plus-ext-row{display:flex;align-items:center;gap:12px;padding:10px 14px}
    .codex-plus-ext-row + .codex-plus-ext-row{border-top:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.1)}
    .codex-plus-ext-row > span{flex:1;min-width:0;display:flex;flex-direction:column}
    .codex-plus-ext-row small{color:hsl(var(--text-400,51 3.1% 43.7%))}
    .codex-plus-button{padding:5px 12px;border-radius:8px;border:1px solid hsl(var(--border-300,30 3.3% 11.8%)/.25);background:transparent;color:inherit;cursor:pointer;font:inherit}
    .codex-plus-button:hover{background:var(--df-hover,hsl(var(--bg-300,48 25% 92.2%)))}
  `);

  // 重画的顺序：「拓展」页的入口先定下来，侧栏入口才画得全。
  for (const refresh of [refreshExtensionsPage, refreshRail, refreshComposerActions, refreshMessages, refreshSlots, refreshRowActions, refreshSidePanelToggles]) {
    hostRefreshers.add(refresh);
  }
  // Claude 的界面变了（切会话、侧栏重建、消息流式输出）就按注册表重画一遍；各函数按指纹幂等。
  registerScanStep(refreshHostsNow, "deferred");

  for (const name of [
    "registerComposerAction", "registerCommand", "registerInputTrigger", "registerMessageAction", "registerMessageDecoration",
    "registerRowAction", "registerSidePanel", "registerSlot", "registerMenuItem", "registerSettingsPanel", "registerSettingsSection",
  ]) {
    mountSupport.set(name, () => true);
  }
  for (const name of [...Object.keys(slotPlaces), "turn.after", "sessionRow.suffix"]) mountSupport.set(`registerSlot:${name}`, () => true);

  // ------------------------------------------------------------------ 调后端路由
  function extensionManifest(scriptKey) {
    const manifest = state.scripts[scriptKey]?.manifest;
    if (!manifest || typeof manifest !== "object") return null;
    try {
      return JSON.parse(JSON.stringify(manifest));
    } catch {
      return null;
    }
  }
  function callRoute(scriptKey, route, payload = {}, options = {}) {
    if (typeof route !== "string" || !pageRoutes.has(route)) {
      return Promise.reject(new CodexPlusUnsupportedError(`route:${route}`, `路由 ${route} 在 Claude Desktop 里没有开放`));
    }
    return request("route", { key: scriptKey, route, payload: payload ?? {} }, options);
  }

  // ------------------------------------------------------------------ 拓展实例
  function createExtension(definition, options = {}) {
    const apply = typeof definition === "function" ? definition : definition?.apply;
    if (typeof apply !== "function") throw new Error("拓展必须提供 apply(ctx) 函数");
    const scriptKey = currentScriptKey(options);
    const manifest = extensionManifest(scriptKey);
    const extensionId = String((typeof definition === "object" && definition?.id) || options.id || manifest?.id || scriptKey || "anonymous");
    const rawInject = (typeof definition === "object" && definition?.inject) || options.inject;
    const inject = normalizeInject(rawInject);
    const required = requiredInject(rawInject);
    const reloadable = !!scriptKey && state.currentKey === scriptKey;
    if (!inject.length) {
      const ctx = instantiate({ apply, scriptKey, manifest, extensionId, inject });
      if (reloadable) state.registerCleanup(() => ctx.dispose());
      return ctx;
    }
    const fiber = createFiber({ apply, scriptKey, manifest, extensionId, inject, required });
    if (reloadable) state.registerCleanup(() => fiber.dispose());
    return fiber;
  }

  /** 声明了 inject 的拓展：依赖齐全才创建实例；依赖消失或换了提供者就卸载、回到挂起，提供者回来再重新应用。 */
  function createFiber({ apply, scriptKey, manifest, extensionId, inject, required = inject }) {
    let tokens = "";
    let checking = false;
    let recheck = false;
    let failedTokens = null;
    const fiber = {
      id: extensionId,
      scriptKey,
      inject: [...inject],
      state: "pending",
      ctx: null,
      check() {
        if (fiber.state === "disposed") return;
        if (checking) {
          recheck = true;
          return;
        }
        checking = true;
        try {
          fiber.update();
        } finally {
          checking = false;
        }
        if (recheck) {
          recheck = false;
          fiber.check();
        }
      },
      update() {
        const ready = required.every((name) => services.has(name));
        const current = inject.map((name) => services.get(name)?.token ?? "").join("|");
        if (fiber.ctx && (!ready || current !== tokens)) {
          const ctx = fiber.ctx;
          fiber.ctx = null;
          fiber.state = "pending";
          ctx.dispose();
        }
        if (!fiber.ctx && ready && fiber.state !== "disposed") {
          if (fiber.state === "failed" && current === failedTokens) return;
          tokens = current;
          failedTokens = null;
          fiber.state = "active";
          try {
            fiber.ctx = instantiate({ apply, scriptKey, manifest, extensionId, inject, fiber });
          } catch (error) {
            fiber.state = "failed";
            failedTokens = tokens;
            markFailure(scriptKey, `${extensionId}: ${errorText(error)}`);
          }
        }
      },
      dispose() {
        if (fiber.state === "disposed") return;
        fiber.state = "disposed";
        serviceFibers.delete(fiber);
        const ctx = fiber.ctx;
        fiber.ctx = null;
        ctx?.dispose();
      },
    };
    serviceFibers.add(fiber);
    fiber.check();
    return fiber;
  }

  function instantiate({ apply, scriptKey, manifest, extensionId, inject = [], fiber = null }) {
    const disposers = [];
    let disposed = false;

    /** 登记一个撤销函数，返回「提前撤销」。实例已卸载时立刻执行。 */
    const track = (dispose) => {
      if (typeof dispose !== "function") return () => {};
      let active = true;
      const entry = () => {
        if (!active) return;
        active = false;
        dispose();
      };
      if (disposed) {
        runCallback(scriptKey, `${extensionId}.dispose`, entry);
        return () => {};
      }
      disposers.push(entry);
      return () => {
        const index = disposers.indexOf(entry);
        if (index >= 0) disposers.splice(index, 1);
        entry();
      };
    };
    const registerOptions = (itemOptions) => ({ ...(itemOptions || {}), scriptKey });

    // 按拓展隔离的本地存储。注意它跟着页面的源走：登录版（claude.ai）和本机版（app://localhost）各存各的。
    const storagePrefix = `codexpp:ext:${extensionId}:`;
    const storage = {
      get(key, fallback = null) {
        try {
          const raw = localStorage.getItem(storagePrefix + key);
          return raw === null ? fallback : JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      set(key, value) {
        localStorage.setItem(storagePrefix + key, JSON.stringify(value));
      },
      remove(key) {
        localStorage.removeItem(storagePrefix + key);
      },
      keys() {
        const out = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key?.startsWith(storagePrefix)) out.push(key.slice(storagePrefix.length));
        }
        return out;
      },
    };
    const info = { id: extensionId, scriptKey };
    const readyHandlers = new Set();
    let applied = false;
    const locale = Object.freeze({
      get current() {
        return currentLocale();
      },
      register(ns, langOrDicts, dict) {
        const space = String(ns || extensionId);
        if (typeof langOrDicts === "string") return track(registerLocale(space, langOrDicts, dict));
        const undo = Object.entries(langOrDicts || {}).map(([lang, value]) => registerLocale(space, lang, value));
        return track(() => undo.forEach((dispose) => dispose()));
      },
      bind(ns) {
        const space = String(ns || extensionId);
        return (key, params) => translate(space, key, params);
      },
      t(key, params) {
        return translate(extensionId, key, params);
      },
      resolve: resolveText,
    });

    let config = Object.freeze({ ...(manifest?.config && typeof manifest.config === "object" ? manifest.config : {}) });
    const configHandlers = new Set();

    // 常驻后台：页面只能调清单 claudeDesktop.methods 里列的方法（这里先挡一道，托管方还会再查一遍）。
    const declared = manifest?.claudeDesktop || {};
    const methods = new Set(Array.isArray(declared.methods) ? declared.methods : []);
    const backendHandlers = new Map();
    const backendInstance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let backendPolling = false;
    const backendRequest = (op, payload, callOptions) => request(op, { key: scriptKey, instance: backendInstance, ...payload }, callOptions);
    const pollBackendEvents = async () => {
      if (backendPolling) return;
      backendPolling = true;
      // 首次订阅从队尾开始：后台已在跑时，订阅前的旧事件不重放给这个页面实例。
      let since = "latest";
      try {
        while (!disposed && backendHandlers.size) {
          let result;
          try {
            result = await backendRequest("events", { since, waitMs: since === "latest" ? 0 : 20000 }, { timeout: 30000 });
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            continue;
          }
          for (const item of result?.events || []) {
            for (const name of [item.event, "*"]) {
              for (const handler of [...(backendHandlers.get(name) || [])]) {
                runCallback(scriptKey, `backend.on:${item.event}`, () => handler(item.payload, { event: item.event }));
              }
            }
          }
          since = Number(result?.next) || (since === "latest" ? 0 : since);
          if (!result?.running) await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      } finally {
        backendPolling = false;
      }
    };
    const backend = {
      call(method, params = null, callOptions = {}) {
        const name = String(method);
        if (!declared.backend) return Promise.reject(new CodexPlusUnsupportedError("backend.call", `拓展 ${extensionId} 没有声明后台（backend.script）`));
        if (!methods.has(name)) {
          return Promise.reject(new CodexPlusUnsupportedError(`backend.call:${name}`, `拓展 ${extensionId} 没有在 claudeDesktop.methods 里声明后台方法：${name}`));
        }
        const timeoutMs = Number.isFinite(callOptions.timeout) ? Number(callOptions.timeout) : undefined;
        return backendRequest("call", { method: name, params, timeoutMs }, { timeout: (timeoutMs || 20000) + 4000 });
      },
      on(event, handler) {
        if (typeof handler !== "function") throw new Error("后台事件处理器必须是函数");
        const name = String(event);
        if (!backendHandlers.has(name)) backendHandlers.set(name, new Set());
        backendHandlers.get(name).add(handler);
        if (declared.backend) void pollBackendEvents();
        return track(() => {
          const set = backendHandlers.get(name);
          set?.delete(handler);
          if (set && !set.size) backendHandlers.delete(name);
        });
      },
    };
    const unsupportedLlm = (name) => () => Promise.reject(new CodexPlusUnsupportedError(`llm.${name}`));
    const llm = Object.freeze({ complete: unsupportedLlm("complete"), listModels: unsupportedLlm("listModels") });

    /** 带撤销函数、撤销函数上另挂句柄方法（refresh / open / close / toggle）的注册。 */
    const trackHandle = (handle, names) => {
      const tracked = track(handle);
      for (const name of names) tracked[name] = handle[name];
      return tracked;
    };

    const ctx = {
      id: extensionId,
      scriptKey,
      manifest,
      instance: null,
      get config() {
        return config;
      },
      onConfigUpdate(handler) {
        if (typeof handler !== "function") throw new Error("onConfigUpdate 需要一个函数");
        configHandlers.add(handler);
        return track(() => configHandlers.delete(handler));
      },
      __tryConfigUpdate(next) {
        if (!configHandlers.size) return false;
        const frozen = Object.freeze({ ...(next && typeof next === "object" ? next : {}) });
        for (const handler of [...configHandlers]) {
          const result = runCallback(scriptKey, `${extensionId}.onConfigUpdate`, () => handler(frozen, config));
          if (!result.ok || result.value !== true) return false;
        }
        config = frozen;
        return true;
      },
      backend,
      llm,
      get themes() {
        return services.get("themes")?.value;
      },
      get disposed() {
        return disposed;
      },
      storage,
      locale,
      /** 包内资源在 Claude 里还取不到（页面 CSP 不一定放行 data URL），先返回空串。 */
      asset() {
        return "";
      },
      provide(name, value) {
        return track(provideService(String(name), value, scriptKey || extensionId));
      },
      get(name) {
        return services.get(String(name))?.value;
      },
      inject(deps, childApply) {
        if (typeof childApply !== "function") throw new Error("inject 需要 apply(ctx) 函数");
        const child = createFiber({ apply: childApply, scriptKey, manifest, extensionId, inject: normalizeInject(deps), required: requiredInject(deps) });
        track(() => child.dispose());
        return child;
      },
      effect(fn) {
        if (typeof fn !== "function") throw new Error("effect 需要一个函数");
        const result = fn();
        if (!isThenable(result)) return track(result);
        let cancelled = false;
        let dispose = null;
        Promise.resolve(result).then((value) => {
          if (typeof value !== "function") return;
          if (cancelled) runCallback(scriptKey, `${extensionId}.dispose`, value);
          else dispose = value;
        }, (error) => ctx.fail(error));
        return track(() => {
          cancelled = true;
          dispose?.();
        });
      },

      registerRowAction: (definition, itemOptions) => track(api.registerRowAction(definition, registerOptions(itemOptions))),
      registerNavEntry: (definition, itemOptions) => track(api.registerNavEntry(definition, registerOptions(itemOptions))),
      registerMenuItem: (definition, itemOptions) => track(api.registerMenuItem(definition, registerOptions(itemOptions))),
      registerPage: (definition, itemOptions) => track(api.registerPage(definition, registerOptions(itemOptions))),
      registerCommand: (definition, itemOptions) => track(api.registerCommand(definition, registerOptions(itemOptions))),
      registerComposerAction: (definition, itemOptions) => track(api.registerComposerAction(definition, registerOptions(itemOptions))),
      registerMessageAction: (definition, itemOptions) => track(api.registerMessageAction(definition, registerOptions(itemOptions))),
      registerMessageDecoration: (definition, itemOptions) => track(api.registerMessageDecoration(definition, registerOptions(itemOptions))),
      registerSlot: (definition, itemOptions) => trackHandle(api.registerSlot(definition, registerOptions(itemOptions)), ["refresh"]),
      registerFloatingTab: (definition, itemOptions) => track(api.registerFloatingTab(definition, registerOptions(itemOptions))),
      registerSettingsPanel: (definition, itemOptions) => track(api.registerSettingsPanel(definition, registerOptions(itemOptions))),
      registerToolView: (definition, itemOptions) => trackHandle(api.registerToolView(definition, registerOptions(itemOptions)), ["refresh"]),
      registerSettingsSection: (definition, itemOptions) => track(api.registerSettingsSection(definition, registerOptions(itemOptions))),
      registerInputTrigger: (definition, itemOptions) => track(api.registerInputTrigger(definition, registerOptions(itemOptions))),
      registerShortcut: (definition, itemOptions) => track(api.registerShortcut(definition, registerOptions(itemOptions))),
      registerTheme: (definition, itemOptions) => track(api.registerTheme(definition, registerOptions(itemOptions))),
      registerSidePanel: (definition, itemOptions) => trackHandle(api.registerSidePanel(definition, registerOptions(itemOptions)), ["open", "close", "toggle"]),
      currentSessionId,
      ask,

      on(event, handler) {
        if (typeof event !== "string" || !event) throw new Error("事件名不能为空");
        if (typeof handler !== "function") throw new Error("事件处理器必须是函数");
        if (event === "ready") {
          if (applied) {
            queueMicrotask(() => !disposed && runCallback(scriptKey, `${extensionId}.ready`, handler));
            return () => {};
          }
          readyHandlers.add(handler);
          return track(() => readyHandlers.delete(handler));
        }
        if (event === "dispose") return track(() => runCallback(scriptKey, `${extensionId}.dispose`, handler));
        const listener = { handler, scriptKey };
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
        if (event === "locale/change") watchLocale();
        return track(() => {
          const set = listeners.get(event);
          set?.delete(listener);
          if (set && !set.size) listeners.delete(event);
        });
      },
      emit(event, ...args) {
        emitEvent(event, args);
      },
      intercept(name, handler, interceptOptions = {}) {
        if (typeof name !== "string" || !name) throw new Error("中间件链名不能为空");
        if (typeof handler !== "function") throw new Error("中间件必须是函数");
        const item = { handler, scriptKey, order: Number.isFinite(interceptOptions.order) ? Number(interceptOptions.order) : 0, seq: (interceptorSeq += 1) };
        const chain = [...(interceptors.get(name) || []), item];
        chain.sort((left, right) => left.order - right.order || left.seq - right.seq);
        interceptors.set(name, chain);
        return track(() => {
          const rest = (interceptors.get(name) || []).filter((entry) => entry !== item);
          if (rest.length) interceptors.set(name, rest);
          else interceptors.delete(name);
        });
      },
      waterfall: runWaterfall,
      listen(target, type, handler, listenOptions) {
        if (!target || typeof target.addEventListener !== "function") throw new Error("listen 的目标必须支持 addEventListener");
        target.addEventListener(type, handler, listenOptions);
        return track(() => target.removeEventListener(type, handler, listenOptions));
      },
      setTimeout(handler, delay, ...args) {
        let timer = null;
        const revoke = track(() => window.clearTimeout(timer));
        timer = window.setTimeout(() => {
          revoke();
          runCallback(scriptKey, `${extensionId}.setTimeout`, () => handler(...args));
        }, delay);
        return revoke;
      },
      setInterval(handler, delay, ...args) {
        const timer = window.setInterval(() => runCallback(scriptKey, `${extensionId}.setInterval`, () => handler(...args)), delay);
        return track(() => window.clearInterval(timer));
      },
      onScan(handler, scanOptions = {}) {
        if (typeof handler !== "function") throw new Error("onScan 需要一个函数");
        const step = () => runCallback(scriptKey, `${extensionId}.onScan`, handler);
        const revoke = track(registerScanStep(step, scanOptions?.phase));
        revoke.run = () => {
          if (!disposed) step();
        };
        return revoke;
      },
      /** 调后端路由：拓展包只能调清单 permissions.routes 声明过的，且得是 Claude 里开放的。 */
      call(route, payload, callOptions) {
        if (manifest) {
          const routes = Array.isArray(manifest.permissions?.routes) ? manifest.permissions.routes : [];
          if (!routes.includes(route)) return Promise.reject(new Error(`拓展 ${extensionId} 未在 codexpp.json 声明路由权限：${route}`));
        }
        return callRoute(scriptKey, route, payload, callOptions);
      },
      toast(message, toastOptions) {
        return runCallback(scriptKey, `${extensionId}.toast`, () => showToast(String(message ?? ""), toastOptions || {}));
      },
      fail(error) {
        markFailure(scriptKey, `${extensionId}: ${errorText(error)}`);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const entry of disposers.splice(0).reverse()) runCallback(scriptKey, `${extensionId}.dispose`, entry);
        instances.delete(ctx);
        emitEvent("extension/dispose", [info]);
        scheduleExtensionsChanged();
      },
    };

    for (const name of inject) {
      if (Object.prototype.hasOwnProperty.call(ctx, name)) continue;
      Object.defineProperty(ctx, name, { enumerable: true, get: () => services.get(name)?.value });
    }
    if (fiber) Object.defineProperty(ctx, "fiber", { value: fiber });
    instances.add(ctx);

    let result;
    try {
      result = apply(ctx);
    } catch (error) {
      ctx.dispose();
      throw error;
    }
    const settle = () => {
      if (disposed) return;
      applied = true;
      emitEvent("extension/apply", [info]);
      scheduleExtensionsChanged();
      for (const handler of [...readyHandlers]) runCallback(scriptKey, `${extensionId}.ready`, handler);
      readyHandlers.clear();
    };
    if (isThenable(result)) {
      Promise.resolve(result).then(settle, (error) => {
        ctx.fail(error);
        ctx.dispose();
      });
    } else {
      settle();
    }
    return ctx;
  }

  // ------------------------------------------------------------------ 对外对象
  /** 带句柄方法的注册（界面还没接上时句柄方法是空操作）。 */
  function registerWithHandle(kind, map, mount, definition, options, methods) {
    const dispose = registerItem(kind, map, mount, definition, options);
    for (const [name, value] of Object.entries(methods)) dispose[name] = value;
    return dispose;
  }

  const api = {
    version: ADAPTER_VERSION,
    apiVersion: API_VERSION,
    /** 当前宿主。Codex 里是 "codex"。 */
    host: HOST,
    /** 某个接口 / 挂载点在当前宿主、当前页面上可不可用，例如 supports("registerComposerAction")。 */
    supports,
    constants,
    get script() {
      const key = currentScriptKey();
      return { key, manifest: extensionManifest(key) };
    },
    extension: createExtension,
    plugin: createExtension,
    services() {
      return [...services.entries()].map(([name, entry]) => ({ name, owner: entry.owner }));
    },
    currentSessionId,
    currentSession,
    /** Claude 里没有「内置拓展」这一层。 */
    builtins() {
      return [];
    },
    toast(message, options) {
      return runCallback(currentScriptKey(), "toast", () => showToast(String(message ?? ""), options || {}));
    },
    call(route, payload, options) {
      return callRoute(currentScriptKey(), route, payload, options);
    },
    ask,
    registerPage,
    registerNavEntry: (definition, options = {}) => registerItem("navEntry", registry.navEntries, "registerNavEntry", definition, options),
    registerFloatingTab: (definition, options = {}) => registerItem("floatingTab", registry.floatingTabs, "registerFloatingTab", definition, options),
    registerShortcut,
    registerTheme,
    registerMenuItem: (definition, options = {}) => registerItem("menuItem", registry.menuItems, "registerMenuItem", definition, options),
    registerSettingsPanel: (definition, options = {}) => registerItem("settingsPanel", registry.settingsPanels, "registerSettingsPanel", definition, options),
    registerSettingsSection: (definition, options = {}) => registerItem("settingsSection", registry.settingsSections, "registerSettingsSection", definition, options),
    registerCommand,
    registerComposerAction: (definition, options = {}) => registerItem("composerAction", registry.composerActions, "registerComposerAction", definition, options),
    registerInputTrigger,
    registerMessageAction: (definition, options = {}) => registerItem("messageAction", registry.messageActions, "registerMessageAction", definition, options),
    registerMessageDecoration: (definition, options = {}) => registerItem("messageDecoration", registry.messageDecorations, "registerMessageDecoration", definition, options),
    registerRowAction: (definition, options = {}) => registerItem("rowAction", registry.rowActions, "registerRowAction", definition, options),
    registerSlot: (definition, options = {}) => {
      // 强制重画：把这个位置上的容器指纹作废，下一轮按注册表重建。
      const refresh = () => {
        for (const node of document.querySelectorAll(`[${OWN_ATTR}^="slot:"]`)) node.setAttribute("data-fp", "stale");
        refreshHostsNow();
      };
      return registerWithHandle("slot", registry.slots, `registerSlot:${String(definition?.slot || "")}`, definition, options, { refresh });
    },
    registerToolView: (definition, options = {}) => registerWithHandle("toolView", registry.toolViews, "registerToolView", definition, options, { refresh: refreshHostsNow }),
    registerSidePanel,
    onCleanup(cleanup) {
      return state.registerCleanup(cleanup);
    },
    fail(error) {
      markFailure(state.currentKey, errorText(error));
    },
  };

  window.codexPlus = api;
  window.__codexPlusClaudeRuntime = Object.freeze({
    version: ADAPTER_VERSION,
    registry,
    anchors,
    mounts,
    mountSupport,
    hostRefreshers,
    registerScanStep,
    scheduleScan,
    refreshHosts,
    request,
    installStyle,
    removeStyle,
    runCallback,
    markFailure,
    showPage,
    closePage,
    itemsOf,
    el,
    own,
    setIcon,
    ui,
    resolveText,
    setRailMounted(mounted) {
      railMounted = !!mounted;
      refreshBall();
    },
    UnsupportedError: CodexPlusUnsupportedError,
  });
  refreshHosts();
})();
