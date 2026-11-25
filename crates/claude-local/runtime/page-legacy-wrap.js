// manifest.json 页面扩展的一个文件在补丁副本里的包装（模板，由 src/extensions/plan.rs 填好）。
// 完整功能模式下本地服务把扩展插在页面 <head> 里、官方脚本之前；副本在新文档创建时注入，那时还没有 <head>，
// 所以等 <head> 出现再执行，效果与那边一致。只进顶层页面，同一页面只跑一次；出错只坏它自己。
(() => {
  if (window.top !== window) return;
  const tag = /*CODEXPP_TAG*/"";
  const done = (window.__codexPlusPageExtensions = window.__codexPlusPageExtensions || {});
  if (done[tag]) return;
  done[tag] = true;
  const run = () => {
    try {
/*CODEXPP_BODY*/
    } catch (error) {
      console.error("[页面扩展] " + tag, error);
    }
  };
  if (document.head) return run();
  const observer = new MutationObserver(() => {
    if (!document.head) return;
    observer.disconnect();
    run();
  });
  observer.observe(document, { childList: true, subtree: true });
})();
