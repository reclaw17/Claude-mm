# 开发工具

这里的东西不随程序打包，只在改拓展运行时（`page-runtime.js`）和锚点表（`page-anchors.js`）时用。

| 文件 | 作用 |
| --- | --- |
| `real-shell.mjs` | 在隔离的 Chrome 里打开录制版 Claude 界面，带上运行时和指定的拓展包。本地服务从本仓库的 `runtime/` 起一份，状态都在临时目录里；录制模板、证书、词表读已安装的目录（默认 `~/.claude-mom/claude-local`），上游是一个回固定文字的假模型。不碰正在用的 Claude Desktop |
| `cdp.mjs` | 连到上面那个 Chrome：求值、截图、换地址、刷新并收集控制台报错 |
| `export-dom.js` | 把当前页面的结构导出成锚点测试的样本（`fixtures/dom/*.json`）：只有标签、类名、`data-testid` 等，不带文字 |
| `dom-probe/` | 一个拓展包，装进真正的 Claude Desktop 里量结构（Cowork、Code 页签只能这样量），见它的 README |
| `preview-server.mjs` + `preview.html` | 不启动 Claude，在普通浏览器里对着一张假外壳跑运行时和拓展包，改界面时看效果用 |
| `build-plan.mjs` | 上面几个工具用的注入计划拼装（正式的计划由 Rust 渲染，这里只读清单里用得上的字段） |

## Claude 改版后重新对锚点

1. `node dev/real-shell.mjs dev/dom-probe`，等它打印出端口。
2. `node dev/cdp.mjs shot /tmp/a.png` 看一眼页面；`node dev/cdp.mjs eval '<表达式>'` 查结构。要对话页就在页面里发一条消息（假上游会回一段固定文字）。
3. 改 `page-anchors.js`。改完给 `real-shell.mjs` 的进程发 `SIGHUP`（重新生成注入计划），再 `node dev/cdp.mjs reload`。
4. 导出新样本：`node dev/cdp.mjs file dev/export-dom.js > fixtures/dom/hub-conversation.json`（新对话页是 `hub-new.json`），跑 `node --test page-runtime.test.mjs`。哪条断言挂了，就是哪个锚点还没对上。

录制模板的账号在界面实验里，有两种布局，两种都要量、都有样本：

- **合并式主页（B 版，`hub-*.json`）**：`real-shell.mjs` 默认打开的就是它。对话页的加号、麦克风、模型选择器在输入框下面单独一条里。
- **经典主页（A 版，`classic-*.json`）**：加 `--classic`。有「Chat | Cowork | Code」切换，加号在输入框里面的工具行左边。设置里没开「合并式主页」时用户看到的是这一种。

现有的锚点和样本是 2026-11-24 对着录制版界面（build `a4ced7f85b`）的对话页签量的。Cowork、Code 页签依赖桌面端的宿主接口，在 Chrome 里起不来，还没量过；本机版界面（`app://localhost`）也没量过。
