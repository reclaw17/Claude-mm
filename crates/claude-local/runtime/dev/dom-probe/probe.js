// DOM 探针（开发用）：量 Claude 页面的结构，给拓展的挂载点定锚点（runtime/page-anchors.js）。
//
// 只记结构和样式：标签、data-testid、role、aria-label、类名、属性名、位置大小、原生控件的计算样式。
// 不记文字内容；属性值只记「形状」（uuid / 数字 / 短标识），地址里的会话 id 换成占位符。
// 用法见同目录的 README.md。
codexPlus.extension((ctx) => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const OWN = "[data-codex-plus-claude], [data-codex-plus-ext]";
  const STYLE_PROPS = [
    "display", "position", "width", "height", "padding", "margin", "gap", "borderRadius", "border", "color", "backgroundColor",
    "fontSize", "fontWeight", "lineHeight", "fontFamily", "boxShadow", "opacity", "cursor", "flexDirection", "alignItems", "justifyContent", "overflow",
  ];
  const VARS = [
    "--bg-000", "--bg-100", "--bg-200", "--bg-300", "--bg-400", "--bg-500", "--text-000", "--text-100", "--text-200", "--text-300", "--text-400", "--text-500",
    "--border-100", "--border-200", "--border-300", "--border-400", "--accent-brand", "--accent-100", "--danger-100", "--oncolor-100",
    "--font-anthropic-sans", "--font-sans", "--font-mono", "--radius-md", "--radius-lg", "--radius-xl", "--cds-radius", "--cds-radius-composer", "--cds-shadow-md", "--cds-shadow-lg",
  ];

  /** 属性值的形状：能看出它是什么，但不带出内容。 */
  const shape = (value) => {
    const text = String(value ?? "");
    if (!text) return "";
    if (new RegExp(`^${UUID.source}$`, "i").test(text)) return "<uuid>";
    if (/^\d+$/.test(text)) return "<number>";
    if (/^(true|false)$/.test(text)) return text;
    if (text.length <= 32 && /^[A-Za-z0-9_.:-]+$/.test(text)) return text;
    return `<text:${text.length}>`;
  };
  const rectOf = (el) => {
    const rect = el.getBoundingClientRect();
    return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)];
  };
  /** 一个节点的要点（不含文字）。 */
  const brief = (el) => {
    const out = { tag: el.tagName.toLowerCase() };
    const testid = el.getAttribute("data-testid");
    if (testid) out.testid = testid;
    if (el.id) out.id = shape(el.id);
    for (const name of ["role", "type", "contenteditable", "aria-expanded", "aria-selected", "aria-haspopup", "data-state", "data-mode"]) {
      const value = el.getAttribute(name);
      if (value !== null) out[name] = shape(value);
    }
    const aria = el.getAttribute("aria-label");
    if (aria) out.aria = aria.length <= 60 ? aria : `<text:${aria.length}>`;
    const cls = typeof el.className === "string" ? el.className.trim() : "";
    if (cls) out.cls = cls.slice(0, 200);
    const data = [...el.attributes].filter((attr) => attr.name.startsWith("data-") && attr.name !== "data-testid" && attr.name !== "data-state" && attr.name !== "data-mode");
    if (data.length) out.data = Object.fromEntries(data.slice(0, 12).map((attr) => [attr.name, shape(attr.value)]));
    if (el.tagName === "A" && el.getAttribute("href")) out.href = el.getAttribute("href").replace(UUID, ":uuid").slice(0, 80);
    out.rect = rectOf(el);
    return out;
  };
  /** 结构树：到 depth 层、最多 budget.left 个节点；跳过拓展运行时自己的节点和 svg 的内部。 */
  const tree = (el, depth, budget) => {
    const out = brief(el);
    const children = [...el.children].filter((child) => !child.matches(OWN) && !["SCRIPT", "STYLE", "LINK", "META"].includes(child.tagName));
    if (!children.length) return out;
    if (depth <= 0 || el.tagName.toLowerCase() === "svg" || budget.left <= 0) {
      out.childCount = children.length;
      return out;
    }
    out.children = [];
    // 重复的兄弟（列表项）只展开前 4 个，其余记个数。
    const seen = new Map();
    for (const child of children) {
      const key = `${child.tagName}|${child.getAttribute("data-testid") || ""}|${typeof child.className === "string" ? child.className : ""}`;
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      if (count > 4) continue;
      if (budget.left <= 0) break;
      budget.left -= 1;
      out.children.push(tree(child, depth - 1, budget));
    }
    const skipped = children.length - out.children.length;
    if (skipped > 0) out.more = skipped;
    return out;
  };
  const styleOf = (el) => {
    const computed = getComputedStyle(el);
    const out = {};
    for (const name of STYLE_PROPS) out[name] = computed[name];
    return out;
  };
  /** 从 el 往上到 stop 的路径（每层的要点），用来看一个节点挂在什么容器里。 */
  const chain = (el, levels = 8) => {
    const out = [];
    for (let cursor = el.parentElement; cursor && cursor !== document.documentElement && out.length < levels; cursor = cursor.parentElement) out.push(brief(cursor));
    return out;
  };
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter((el) => !el.closest(OWN));
  const controls = (root, limit = 24) => all("button, a[href], [role=button], [role=menuitem], [role=tab]", root).slice(0, limit).map((el) => ({ ...brief(el), style: styleOf(el) }));

  function composers() {
    return all('[data-testid="chat-input"], [data-testid="code-prompt-input"], [contenteditable="true"], textarea').slice(0, 4).map((input) => {
      // 往上找到「输入区」：第一个同时装着输入框和至少两个按钮的祖先。
      let root = input.parentElement;
      for (let hops = 0; root && hops < 10 && all("button", root).length < 2; hops += 1) root = root.parentElement;
      return {
        input: { ...brief(input), style: styleOf(input), editorClasses: (typeof input.className === "string" ? input.className : "").slice(0, 200) },
        chain: chain(input, 12),
        root: root ? tree(root, 7, { left: 220 }) : null,
        buttons: root ? controls(root) : [],
      };
    });
  }
  function messages() {
    const pick = (selector) => all(selector).slice(0, 2).map((el) => ({
      node: tree(el, 5, { left: 90 }),
      chain: chain(el, 10),
      // 这条消息附近的操作行：先在它里面找，再在往上三层里找。
      actions: (() => {
        for (let scope = el, hops = 0; scope && hops < 4; scope = scope.parentElement, hops += 1) {
          const bar = all('[data-testid*="message-actions"], [data-testid*="action-bar"], [role="toolbar"]', scope)[0];
          if (bar) return { hops, bar: tree(bar, 4, { left: 60 }), chain: chain(bar, 6), buttons: controls(bar, 12) };
        }
        return null;
      })(),
    }));
    return {
      user: pick('[data-testid="user-message"]'),
      assistant: pick('[data-testid="assistant-message"], [data-is-streaming], .font-claude-response, .font-claude-message'),
      list: all('[data-testid="virtual-message-list"], [data-testid="chat-column-body"], [data-testid="chat-column"]').slice(0, 3).map((el) => ({ ...brief(el), chain: chain(el, 6), childCount: el.children.length })),
      tools: all('[data-testid^="tool-"]').slice(0, 3).map((el) => ({ node: tree(el, 4, { left: 50 }), chain: chain(el, 6) })),
    };
  }
  function sidebar() {
    const roots = all('[data-testid="sidebar"], nav, aside').filter((el) => el.getBoundingClientRect().width > 0).slice(0, 3);
    return roots.map((el) => ({ node: tree(el, 7, { left: 260 }), chain: chain(el, 5), items: controls(el, 14) }));
  }
  function header() {
    return all('[data-testid="chat-header"], header, [data-testid^="topbar"]').slice(0, 3).map((el) => ({ node: tree(el, 6, { left: 120 }), chain: chain(el, 5), buttons: controls(el, 14) }));
  }
  function settings() {
    const items = all('[data-testid^="settings-nav"]');
    if (!items.length) return null;
    const container = items[0].parentElement?.parentElement || items[0].parentElement;
    return { container: container ? tree(container, 5, { left: 120 }) : null, chain: chain(items[0], 8), items: items.slice(0, 6).map((el) => ({ ...brief(el), style: styleOf(el) })) };
  }
  function menus() {
    // 打开着的菜单 / 弹出层（先点开会话行的「更多」或模型选择器再保存，就能量到它们）。
    return all('[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper]').slice(0, 4).map((el) => ({ node: tree(el, 5, { left: 90 }), chain: chain(el, 4), items: controls(el, 10) }));
  }

  /** 当前是哪个页签：给文件名用，只是个粗略的猜测，真正的判断靠存下来的结构。 */
  function surface() {
    const pathname = location.pathname.replace(UUID, ":uuid");
    if (document.querySelector('[data-testid="code-prompt-input"]')) return "code";
    if (/settings/.test(pathname)) return "settings";
    if (/cowork|task/.test(pathname)) return "cowork";
    if (document.querySelector('[data-testid="chat-input"]')) return "chat";
    return "other";
  }

  /** 锚点测试用的样本（与 dev/export-dom.js 同一格式）：只有标签、类名前 6 个、data-testid 等，不带文字。 */
  function fixture() {
    const turns = new Map();
    const node = (el) => {
      const attrs = {};
      const cls = (typeof el.className === "string" ? el.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
      if (cls) attrs.class = cls;
      for (const name of ["data-testid", "role", "type", "contenteditable"]) {
        const value = el.getAttribute(name);
        if (value !== null) attrs[name] = value;
      }
      if (el.hasAttribute("href")) attrs.href = el.getAttribute("href").replace(UUID, "00000000-0000-4000-8000-000000000001");
      if (el.hasAttribute("data-turn-key")) {
        const key = el.getAttribute("data-turn-key");
        if (!turns.has(key)) turns.set(key, `turn-${turns.size + 1}`);
        attrs["data-turn-key"] = turns.get(key);
      }
      const tag = el.tagName.toLowerCase();
      const skipInside = tag === "svg" || /standard-markdown/.test(cls);
      const children = skipInside ? [] : [...el.children]
        .filter((child) => !child.matches("[data-codex-plus-claude], [data-codex-plus-ext], script, style, link, [aria-hidden=true][data-cds=Icon]"))
        .map(node);
      return [tag, attrs, children];
    };
    return { origin: location.origin, pathname: location.pathname.replace(UUID, ":uuid"), build: document.documentElement.getAttribute("data-build-id"), body: node(document.body) };
  }

  function collect() {
    const root = getComputedStyle(document.documentElement);
    const testids = {};
    for (const el of all("[data-testid]")) {
      const id = el.getAttribute("data-testid");
      testids[id] = (testids[id] || 0) + 1;
    }
    return {
      probe: 1,
      at: new Date().toISOString(),
      location: { origin: location.origin, pathname: location.pathname.replace(UUID, ":uuid") },
      build: document.documentElement.getAttribute("data-build-id") || null,
      html: brief(document.documentElement),
      body: brief(document.body),
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      userAgent: navigator.userAgent,
      vars: Object.fromEntries(VARS.map((name) => [name, root.getPropertyValue(name).trim()])),
      bodyStyle: styleOf(document.body),
      testids,
      composers: composers(),
      messages: messages(),
      sidebar: sidebar(),
      header: header(),
      settings: settings(),
      menus: menus(),
      skeleton: tree(document.body, 9, { left: 900 }),
      fixture: fixture(),
    };
  }

  let busy = false;
  async function save(reason) {
    if (busy) return null;
    busy = true;
    try {
      const data = collect();
      const result = await ctx.backend.call("save", { surface: surface(), reason, data });
      ctx.toast(`页面结构已保存（${surface()}，${Math.round(result.bytes / 1024)} KB）`, { type: "success" });
      return result;
    } catch (error) {
      ctx.toast(`保存失败：${error.message}`, { type: "error" });
      return null;
    } finally {
      busy = false;
    }
  }

  // 自动巡览：依次打开各页签，每页加载好后存一份。换页用整页跳转，进度记在 sessionStorage 里，
  // 下一页加载时由新的探针实例接着走。「第一个会话」一步在当前页面找不到对应链接时跳过。
  const TOUR_KEY = "codexpp-dom-probe-tour";
  const TOUR = [
    { label: "chat-new", go: "/new" },
    { label: "chat-conversation", link: /^\/chat\/[0-9a-f-]{36}/ },
    { label: "cowork-new", go: "/cowork" },
    { label: "cowork-session", link: /^\/(task|local_sessions|cowork)\/[^/]+/ },
    { label: "code-new", go: "/epitaxy" },
    { label: "code-session", link: /^\/(epitaxy|claude-code-desktop|code)\/[^/]+/ },
    { label: "settings", go: "/settings" },
  ];
  const tourState = () => {
    try { return JSON.parse(sessionStorage.getItem(TOUR_KEY) || "null"); } catch { return null; }
  };
  const findLink = (pattern) => all("a[href]").find((el) => {
    try { return pattern.test(new URL(el.getAttribute("href"), location.href).pathname); } catch { return false; }
  });
  /** 从第 index 步起找第一个走得通的，跳过去；走完了收尾。 */
  function tourGo(index) {
    for (let step = index; step < TOUR.length; step += 1) {
      const target = TOUR[step].go || findLink(TOUR[step].link)?.getAttribute("href");
      if (!target) continue;
      sessionStorage.setItem(TOUR_KEY, JSON.stringify({ index: step, done: false }));
      location.assign(new URL(target, location.href).href);
      return;
    }
    sessionStorage.setItem(TOUR_KEY, JSON.stringify({ index: TOUR.length, done: true }));
    ctx.toast("DOM 探针：巡览完成", { type: "success" });
  }
  function tourResume() {
    const state = tourState();
    if (!state || state.done) return false;
    ctx.setTimeout(async () => {
      await save(`tour-${TOUR[state.index]?.label || "step"}`);
      tourGo(state.index + 1);
    }, 9000);
    return true;
  }
  const startTour = () => tourGo(0);

  ctx.registerShortcut({ key: "Mod+Alt+Shift+D", description: "保存当前页面结构", run: () => save("shortcut") });
  ctx.registerFloatingTab({
    title: "DOM 探针",
    icon: "⌖",
    render({ container }) {
      container.textContent = "";
      const note = document.createElement("div");
      note.textContent = "切到要量的页面（Chat、Cowork、Code、设置；需要量菜单时先把菜单点开），再点下面的按钮或按 ⌘⌥⇧D / Ctrl+Alt+Shift+D。只记结构和样式，不记对话内容。";
      note.style.cssText = "line-height:1.5;margin-bottom:10px";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "保存当前页面结构";
      button.style.cssText = "padding:6px 12px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;font:inherit";
      const list = document.createElement("pre");
      list.style.cssText = "margin:10px 0 0;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere";
      const refresh = () => ctx.backend.call("list").then((files) => { list.textContent = files.length ? files.join("\n") : "还没有保存过"; }, () => {});
      button.addEventListener("click", () => save("button").then(refresh));
      const tour = button.cloneNode(true);
      tour.textContent = "自动巡览（Chat → Cowork → Code → 设置）";
      tour.style.marginLeft = "8px";
      tour.addEventListener("click", startTour);
      container.append(note, button, tour, list);
      refresh();
    },
  });
  // 巡览中就接着走；否则页面加载好之后自动存一份，省得忘。配置里开了「启动后自动巡览」时，每个窗口第一次加载时开始巡览。
  if (!tourResume()) {
    if (ctx.config?.autoTour && !tourState()) ctx.setTimeout(startTour, 9000);
    else ctx.setTimeout(() => save("auto"), 6000);
  }
});
