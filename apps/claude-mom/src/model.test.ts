import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SECRET_MASK, claudeState, compareVersions, configInputText, configValues, emptyProfile, extensionRuntimeNote, formatWindow, hostOf, localizedText, normalizeModels, parseConfigInput, profileProblem, setupSteps, templateLabel, type ClaudeStatus, type ExtensionConfigField, type ExtensionInfo } from "./model.ts";

const status = (patch: Partial<ClaudeStatus> = {}): ClaudeStatus => ({
  supported: true, sourceApp: "", version: "1.0", claudeRunning: false, running: false, connected: false,
  caReady: true, caTrusted: true, caMachineSupported: true, caMachineTrusted: false, nodeAvailable: true, dictationReady: true, models: [], needsRestart: false,
  config: { enabled: true, model: "", localization: true, voiceInput: false, computerUse: false, backgroundMode: false },
  ...patch,
});

test("上游表单：要有效的 Base URL 和默认模型，不能写到 /v1/messages", () => {
  const profile = { ...emptyProfile(), baseUrl: "https://api.example.com", model: "glm-5" };
  assert.equal(profileProblem(profile), null);
  assert.equal(profileProblem({ ...profile, baseUrl: "" }), "填一个 Base URL");
  assert.equal(profileProblem({ ...profile, baseUrl: "api.example.com" }), "Base URL 不是有效地址");
  assert.equal(profileProblem({ ...profile, baseUrl: "ftp://x" }), "Base URL 要以 http:// 或 https:// 开头");
  assert.match(profileProblem({ ...profile, baseUrl: "https://x/v1/messages" }) ?? "", /不要带/);
  assert.equal(profileProblem({ ...profile, model: " " }), "选一个默认模型");
  assert.equal(hostOf("http://127.0.0.1:3425"), "127.0.0.1:3425");
});

test("模型列表去重，默认模型排第一", () => {
  assert.deepEqual(normalizeModels(["b", " a ", "b", ""], "a"), ["a", "b"]);
});

test("状态文案：已连接、运行中、外部打开、未启动", () => {
  assert.deepEqual(claudeState(null, null), { text: "正在检测 Claude…", tone: "busy" });
  assert.equal(claudeState(status({ connected: true }), null).tone, "ok");
  assert.equal(claudeState(status({ claudeRunning: true }), null).tone, "warn");
  assert.equal(claudeState(status(), null).text, "未启动");
  assert.equal(claudeState(status(), "launch").text, "正在启动…");
  assert.equal(claudeState(status({ supported: false }), null).text, "没有找到 Claude Desktop");
});

test("启动前清单按顺序列出缺的步骤", () => {
  const ready = { ...emptyProfile(), baseUrl: "https://a.example", model: "m" };
  assert.deepEqual(setupSteps(status(), ready), []);
  assert.deepEqual(setupSteps(status({ caTrusted: false, nodeAvailable: false }), null).map((step) => step.id), ["upstream", "node", "trust"]);
  // 没认出 Claude 时缺 Node 的提示也要在（#46）。
  assert.deepEqual(setupSteps(status({ supported: false, nodeAvailable: false }), ready).map((step) => step.id), ["node"]);
  // 第三方模式不经代理：不要求信任证书。
  assert.deepEqual(setupSteps(status({ caTrusted: false, config: { ...status().config, threePMode: true } }), null).map((step) => step.id), ["upstream"]);
});

test("窗口显示", () => {
  assert.equal(formatWindow(null), "200k");
  assert.equal(formatWindow(1_000_000), "1M");
  assert.equal(formatWindow(1_100_000), "1.1M");
  assert.equal(formatWindow(400_000), "400k");
});

test("前端调用的命令都在后端注册了", () => {
  const app = readFileSync(new URL("./ClaudeMomApp.tsx", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  // 命令名有的直接传给 invoke，有的经 bookCall 转一手：按字面量收。
  const called = new Set([...app.matchAll(/"(claude_(?:mom|local)_[a-z_]+)"/g)].map((match) => match[1]));
  assert.ok(called.size >= 9, [...called].join(","));
  for (const command of called) assert.ok(new RegExp(`::${command},`).test(lib), `${command} 没有注册`);
});

test("recorded template versions are labelled by build date and id", () => {
  const label = templateLabel({ build: "a4ced7f85b", builtAt: 1794603257 });
  assert.match(label, /^2026-11-1[34] · a4ced7f85b$/);
  assert.equal(templateLabel({ build: "x1", builtAt: null }), "x1");
});

test("扩展版本按语义化版本比较", () => {
  const ordered = ["0.9.10", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareVersions(ordered[index], ordered[index - 1]), 1, `${ordered[index]} > ${ordered[index - 1]}`);
    assert.equal(compareVersions(ordered[index - 1], ordered[index]), -1);
  }
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(compareVersions("abc", "1.0.0"), 0);
});

const field = (extra: Partial<ExtensionConfigField>): ExtensionConfigField => ({
  key: "x", type: "string", title: "X", description: "", default: "", options: [], secret: false, ...extra,
});

test("extension config inputs round-trip through text and say what is wrong", () => {
  assert.equal(localizedText({ en: "Minutes", zh: "分钟" }), "分钟");
  assert.equal(localizedText({ en: "Minutes" }), "Minutes");
  assert.equal(localizedText("T"), "T");
  assert.equal(localizedText(null), "");

  const number = field({ type: "number", title: { zh: "分钟" }, min: 1, max: 60 });
  assert.deepEqual(parseConfigInput(number, configInputText(number, 25)), { value: 25 });
  assert.deepEqual(parseConfigInput(number, ""), { error: "「分钟」要填数字" });
  assert.deepEqual(parseConfigInput(number, "0"), { error: "「分钟」不能小于 1" });
  assert.deepEqual(parseConfigInput(number, "61"), { error: "「分钟」不能大于 60" });
  assert.deepEqual(parseConfigInput(field({ type: "boolean" }), "true"), { value: true });
  const select = field({ type: "select", options: [{ value: 1, label: "一" }, { value: "b", label: "B" }] });
  assert.deepEqual(parseConfigInput(select, "1"), { value: 1 }, "选项的值保留原来的类型");
  assert.ok("error" in parseConfigInput(select, "c"));
  const list = field({ type: "array" });
  assert.equal(configInputText(list, undefined), "[]");
  assert.deepEqual(parseConfigInput(list, configInputText(list, ["a", "b"])), { value: ["a", "b"] });
  assert.ok("error" in parseConfigInput(list, "{}"));
  assert.ok("error" in parseConfigInput(field({ type: "object" }), "[1]"));
  assert.ok("error" in parseConfigInput(field({ type: "object" }), "{bad"));

  const schema = [number, field({ key: "token", secret: true }), field({ key: "untouched" })];
  assert.deepEqual(configValues(schema, { x: "5", token: SECRET_MASK }), { values: { x: 5, token: SECRET_MASK } });
  assert.deepEqual(configValues(schema, { x: "abc", token: "" }), { error: "「分钟」要填数字" });
});

test("the extension row says how a codexpp package is doing in the Claude page", () => {
  const item = (extra: Partial<ExtensionInfo>): ExtensionInfo => ({
    id: "demo", name: "Demo", version: "1.0.0", author: "", description: "", builtin: false, enabled: true, error: null,
    format: "codexpp", capabilities: ["page"], notes: [], configSchema: [], config: {}, runtime: null, ...extra,
  });
  const runtime = (extra: object) => ({ status: "loaded" as const, error: "", unsupported: [], loadedAt: "", ...extra });
  assert.equal(extensionRuntimeNote(item({ format: "manifest" })), null);
  assert.equal(extensionRuntimeNote(item({ enabled: false })), null);
  assert.equal(extensionRuntimeNote(item({ error: "bad" })), null);
  assert.equal(extensionRuntimeNote(item({}))?.tone, "muted");
  assert.deepEqual(extensionRuntimeNote(item({ runtime: runtime({}) })), { tone: "ok", text: "已加载" });
  assert.deepEqual(extensionRuntimeNote(item({ runtime: runtime({ status: "failed", error: "SyntaxError: x\n    at y" }) })), { tone: "error", text: "加载失败：SyntaxError: x" });
  assert.deepEqual(extensionRuntimeNote(item({ runtime: runtime({ error: "page: boom" }) })), { tone: "error", text: "已加载，运行中出错：page: boom" });
  assert.match(extensionRuntimeNote(item({ runtime: runtime({ unsupported: ["registerComposerAction"] }) }))!.text, /registerComposerAction/);
});
