# 更新日志

**[English](CHANGELOG.md) · [简体中文](CHANGELOG.zh-CN.md) · [Русский](CHANGELOG.ru.md)**


## 0.1.3 - 2026-11-15

- Windows：新版 Claude 桌面版主页没有「对话 | Cowork」切换的问题修好了，Cowork 默认打开；不想要可以在 设置 → 高级 → Cowork 关掉。
- 部分 Claude 版本没有 `ion-dist.asar`、而是把界面解包成目录，本地服务会启动失败、一直显示「本地服务未运行」；现在两种形式都支持。

## 0.1.2 - 2026-11-13

- 从 cc-switch 导入：也读取给 Claude 桌面版单独配的供应商（cc-switch 新版的「Claude Desktop」页），同一组地址和 Key 只导入一次。
- 从 cc-switch 导入：按 cc-switch 自己的规则找数据库，设置里改过配置目录的也能找到。
- cc-switch 里只有 OpenAI 格式的供应商时，说明原因，不再只提示「没有找到」。

## 0.1.1 - 2026-11-12

- macOS：改由系统（LaunchServices）启动 Claude，屏幕录制、辅助功能等隐私权限按 Claude 自己计算，不再显示「未请求」。
- 设置 → 高级 新增「新系统也开后台模式」（默认关）：Claude 在较新的 macOS 上提示「暂不支持后台模式」时，可打开它解除系统版本限制；未经 Claude 验证，可能不稳定。

## 0.1.0 - 2026-11-12

首个版本：从 CodexPlusPlus 拆出的独立程序。

- 用原版 Claude Desktop 的完整功能模式（Chat / Code / Cowork、界面汉化），直连自己的上游（Base URL + Key）。
- 多组上游随时切换；可从 cc-switch 导入 Claude 供应商，或把 Magpie / Codex++ 的本机网关当上游。
- 本地听写（SenseVoice，离线转写）。
- 自动更新。
