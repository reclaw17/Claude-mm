// Claude 页面的锚点表：每个挂载点在 Claude 的 DOM 里挂在哪。
//
// 单独放一个文件，是因为这部分跟着 Claude 的前端改版走，和运行时本身的逻辑分开改、分开测
// （样本在 fixtures/dom/，测试在 page-runtime.test.mjs 里）。每个锚点给一组候选选择器，按顺序试，
// 第一个找得到的生效；全都找不到时用到它的挂载点不出现，拓展的其余部分照常工作。
//
// 选择器优先用 data-testid：它们是 Claude 前端自己的测试标识，比类名稳定。只写简单的形式
//（标签、.类、[属性="值"]、逗号分隔），位置关系（公共祖先、兄弟）由运行时按结构推出来，不写在这里。
// 2026-11-24 对着录制版界面（build a4ced7f85b）量的，合并式主页（B 版）和经典主页（A 版）两种布局都量过；量法见 dev/README.md。
window.__codexPlusClaudeAnchors = {
  version: 2,
  // 侧栏
  sidebar: ['[data-testid="sidebar"]'],
  /** 「项目 / Artifacts / 插件」那一组导航行：拓展的页面入口接在它后面，样子照里面的行。 */
  navRows: ['[data-testid="nav-pin-rows"]'],
  /** 最近对话列表：每一行是一个带「更多选项」的会话链接。 */
  recents: ['[data-testid="sidebar-recents"]'],
  /** 侧栏底部的用户菜单：它所在的那一条之上是 sidebar.bottom。 */
  sidebarFooter: ['[data-testid="user-menu-button"]'],
  // 输入区
  composerEditor: ['[data-testid="chat-input"]', '[data-testid="code-prompt-input"]'],
  /** 工具行左边的原生按钮（加号）：拓展的输入框按钮挨着它放，样子照它。 */
  composerLeading: ['[data-testid="chat-input-attach"]'],
  /** 输入区里别的原生控件：拓展的按钮只和加号一组，不混进它们那一组。 */
  composerTrailing: ['[data-testid="chat-input-send"]', '[data-testid="composer-dictate"]', '[data-testid="chin-mic"]', '[data-testid="model-selector-dropdown"]'],
  /** 整个输入框的外框（从工具行往上找）：composer.above / below 放在它的前后。 */
  composerBox: [".font-sans.flex-col", "fieldset", "form"],
  // 对话
  transcript: ['[data-testid="transcript-list"]'],
  transcriptEnd: ['[data-testid="last-message-sentinel"]', '[data-testid="transcript-end"]'],
  userMessage: ['[data-testid="user-message"]'],
  assistantMessage: ['[data-testid="assistant-message"]'],
  /** 回复正文（不含读屏标题和操作行）。 */
  assistantContent: [".standard-markdown", ".prose"],
  userActions: ['[data-testid="user-message-actions"]'],
  assistantActions: ['[data-testid="message-actions"]'],
  /** 消息所在的那一轮：这个属性的值当消息 id 用。 */
  turnAttribute: "data-turn-key",
  // 对话页头部和主区域
  header: ['[data-testid="chat-header"]'],
  headerActions: ['[data-testid="wiggle-controls-actions-group"]'],
  pane: ['[data-testid="primary-pane"]'],
};
