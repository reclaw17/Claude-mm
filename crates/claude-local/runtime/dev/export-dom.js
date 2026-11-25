// 开发用：把当前页面的结构导出成锚点测试的样本（fixtures/dom/*.json）。在 real-shell.mjs 起的页面上跑：
//   node dev/cdp.mjs file dev/export-dom.js > fixtures/dom/<名字>.json
// 只留结构：标签、类名（前 6 个）、data-testid、role、type、href（会话 id 换成占位符）、消息的轮次标记（重新编号）。
// 不带文字、不带 aria-label；svg、正文内容、拓展运行时自己的节点都略去。
// 节点写成 [标签, 属性, 子节点]。
(() => {
  const turns = new Map();
  const node = (el) => {
    const attrs = {};
    const cls = (typeof el.className === "string" ? el.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
    if (cls) attrs.class = cls;
    for (const name of ["data-testid", "role", "type", "contenteditable"]) {
      const value = el.getAttribute(name);
      if (value !== null) attrs[name] = value;
    }
    if (el.hasAttribute("href")) attrs.href = el.getAttribute("href").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "00000000-0000-4000-8000-000000000001");
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
  return JSON.stringify({ origin: location.origin, pathname: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":uuid"), build: document.documentElement.getAttribute("data-build-id"), body: node(document.body) });
})()
