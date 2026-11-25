// 一个 codexpp.json 拓展包在 Claude 页面里的包装（模板，由 src/extensions/plan.rs 填好再下发）。
// 每个包单独一段脚本：语法错误只坏它自己。运行时（page-runtime.js）没起来时什么都不做，不影响 Claude 页面。
(() => {
  if (window.top !== window) return;
  const runtime = window.__codexPlusUserScripts;
  if (!runtime || typeof runtime.beginPackage !== "function") return;
  const meta = /*CODEXPP_META*/null;
  // 同一页面只跑一次（补丁副本会在已加载的页面上补跑）。
  if (!runtime.beginPackage(meta)) return;
  try {
/*CODEXPP_STYLES*/
/*CODEXPP_SOURCE*/
    runtime.endPackage(meta.key);
  } catch (error) {
    runtime.endPackage(meta.key, error);
  }
})();
