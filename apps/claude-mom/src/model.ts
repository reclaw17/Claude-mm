/**
 * ClaudeMom 界面的纯逻辑：后端数据类型、状态文案、表单校验。不依赖 React / Tauri，便于单测。
 */

export type CommandStatus = "ok" | "failed" | string;
export type CommandResult<T> = T & { status: CommandStatus; message: string };

export type UpstreamSource = "manual" | "ccswitch" | "magpie" | "codexpp";

/** 一组上游（与 core `claude_mom::UpstreamProfile` 字段一致）。 */
export type UpstreamProfile = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  smallModel: string;
  models: string[];
  contextWindow: number | null;
  /** 模型显示名（上游 `/v1/models` 的 display_name）。 */
  modelNames: Record<string, string>;
  source: UpstreamSource | string;
  sourceId: string;
};

export type UpstreamBook = { profiles: UpstreamProfile[]; activeId: string | null };

export type UpstreamModel = { id: string; displayName: string | null; contextWindow: number | null };

/** 界面上显示的模型名：有显示名用显示名，否则用 id。 */
export function modelLabel(profile: Pick<UpstreamProfile, "modelNames">, id: string): string {
  return profile.modelNames?.[id] || id;
}

/** Claude 本地服务的设置（与 core `ClaudeLocalSettings` 一致，只列界面用到的）。 */
export type ClaudeConfig = {
  enabled: boolean;
  model: string;
  localization: boolean;
  voiceInput: boolean;
  computerUse: boolean;
  backgroundMode: boolean;
  /** 无视 Claude 对后台模式的 macOS 版本上限。 */
  forceBackgroundMode?: boolean;
  /** 打开 Cowork 的总开关（默认开）。 */
  cowork?: boolean;
  /** 用 Claude 的合并式主页：对话和 Cowork 合在一起，没有「对话 | Cowork」切换（默认开）。 */
  hubHome?: boolean;
  /** 录制版用哪个录制版本（前端 build id）；空 = 最新。 */
  template?: string;
  /** 界面选「本机版」：用 Claude 自己的第三方模式启动（安装包自带的新界面，推理走本地服务；默认录制版）。 */
  threePMode?: boolean;
  displayName?: string;
  email?: string;
  plan?: string;
  sessionSync?: boolean;
  listAllModels?: boolean;
  hideUnroutedModels?: boolean;
  /** Code 页签是否和命令行共用 ~/.claude。 */
  codeShareHome?: boolean;
  /** 启动前把命令行建的会话加进 Desktop 的会话列表。 */
  importCliSessions?: boolean;
};

/** 多语言文本：字符串，或 `{ en, zh, ... }`。 */
export type LocalizedText = string | Record<string, string>;

/** 拓展包声明的一个配置项（与 core `extensions::config::ExtensionConfigField` 一致）。 */
export type ExtensionConfigField = {
  key: string;
  type: "string" | "text" | "number" | "boolean" | "select" | "array" | "object";
  title: LocalizedText;
  description: LocalizedText;
  default: unknown;
  options: Array<{ value: unknown; label: string }>;
  /** 按密码框显示；读回来的值是打码的。 */
  secret: boolean;
  min?: number;
  max?: number;
};

/** 页面上次加载一个拓展包的结果（页面运行时回报的）。 */
export type ExtensionRuntime = {
  status: "pending" | "loading" | "loaded" | "failed";
  error: string;
  /** 它用了、但在 Claude 里还没有的接口。 */
  unsupported: string[];
  loadedAt: string;
};

/** 页面扩展 / 拓展包（与 core `extensions::ExtensionInfo` 一致）。 */
export type ExtensionInfo = {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  builtin: boolean;
  enabled: boolean;
  /** 清单有问题时的原因：这样的扩展不会生效，也不能启用。 */
  error: string | null;
  /** manifest：页面扩展（js / css）；codexpp：Codex++ 拓展包（带页面接口、配置、后台）。 */
  format: "manifest" | "codexpp";
  /** page / styles / backend / mods / codexOnly */
  capabilities: string[];
  notes: string[];
  configSchema: ExtensionConfigField[];
  /** 生效配置，密钥项已打码；没有配置项时为 null。 */
  config: Record<string, unknown> | null;
  runtime: ExtensionRuntime | null;
};

/** 密钥项读回来的打码值；原样传回去表示不改。 */
export const SECRET_MASK = "******";

/** 取多语言文本：先中文，再英文，再随便一个。 */
export function localizedText(text: LocalizedText | null | undefined): string {
  if (text == null) return "";
  if (typeof text === "string") return text;
  const pick = Object.keys(text).find((key) => /^zh/i.test(key)) ?? Object.keys(text).find((key) => /^en/i.test(key)) ?? Object.keys(text)[0];
  return pick ? String(text[pick]) : "";
}

/** 一个拓展包在 Claude 页面里的运行情况，给列表里那一行用；页面扩展、没启用的不显示。 */
export function extensionRuntimeNote(item: ExtensionInfo): { tone: "ok" | "error" | "muted"; text: string } | null {
  if (item.format !== "codexpp" || !item.enabled || item.error) return null;
  const runtime = item.runtime;
  if (!runtime || runtime.status === "pending" || runtime.status === "loading") {
    return { tone: "muted", text: "还没在 Claude 页面里运行过：刷新 Claude 页面后生效" };
  }
  const firstLine = (text: string) => text.split("\n")[0].slice(0, 300);
  if (runtime.status === "failed") return { tone: "error", text: `加载失败：${firstLine(runtime.error) || "脚本没有执行"}` };
  if (runtime.error) return { tone: "error", text: `已加载，运行中出错：${firstLine(runtime.error)}` };
  if (runtime.unsupported.length) return { tone: "muted", text: `已加载；这些接口在 Claude 里还不可用：${runtime.unsupported.join("、")}` };
  return { tone: "ok", text: "已加载" };
}

/** 配置项在输入框里的文字。 */
export function configInputText(field: ExtensionConfigField, value: unknown): string {
  if (field.type === "array" || field.type === "object") return JSON.stringify(value ?? (field.type === "array" ? [] : {}), null, 2);
  return value == null ? "" : String(value);
}

/** 把输入框里的文字变回配置值；写得不对时返回原因。 */
export function parseConfigInput(field: ExtensionConfigField, text: string): { value: unknown } | { error: string } {
  const title = localizedText(field.title) || field.key;
  switch (field.type) {
    case "number": {
      const value = Number(text);
      if (text.trim() === "" || !Number.isFinite(value)) return { error: `「${title}」要填数字` };
      if (field.min != null && value < field.min) return { error: `「${title}」不能小于 ${field.min}` };
      if (field.max != null && value > field.max) return { error: `「${title}」不能大于 ${field.max}` };
      return { value };
    }
    case "boolean":
      return { value: text === "true" };
    case "select": {
      const option = field.options.find((item) => String(item.value) === text);
      return option ? { value: option.value } : { error: `「${title}」要从给出的选项里选` };
    }
    case "array":
    case "object":
      try {
        const value: unknown = JSON.parse(text);
        const isArray = Array.isArray(value);
        if (field.type === "array" ? !isArray : isArray || value === null || typeof value !== "object") {
          return { error: `「${title}」要填 JSON ${field.type === "array" ? "数组" : "对象"}` };
        }
        return { value };
      } catch {
        return { error: `「${title}」不是合法的 JSON` };
      }
    default:
      return { value: text };
  }
}

/** 整张配置表单要保存的值；有一项写得不对就返回那一项的原因。 */
export function configValues(schema: ExtensionConfigField[], draft: Record<string, string>): { values: Record<string, unknown> } | { error: string } {
  const values: Record<string, unknown> = {};
  for (const field of schema) {
    if (!(field.key in draft)) continue;
    const parsed = parseConfigInput(field, draft[field.key]);
    if ("error" in parsed) return parsed;
    values[field.key] = parsed.value;
  }
  return { values };
}

/** 扩展市场的条目（与 `market::MarketEntry` 一致）。 */
export type MarketEntry = {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** official：官方仓库里审核过的；community：作者自己的仓库，未审核。 */
  source: "official" | "community";
  repo: string;
  path: string;
  commit: string;
  url: string;
  stars?: number | null;
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 按语义化版本比较：a 新返回正数，旧返回负数，一样（或看不懂）返回 0。构建后缀（+…）不参与比较。 */
export function compareVersions(a: string, b: string): number {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (!left || !right) return 0;
  for (let index = 1; index <= 3; index++) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff) return Math.sign(diff);
  }
  const [pa, pb] = [left[4], right[4]];
  if (!pa || !pb) return pa === pb ? 0 : pa ? -1 : 1; // 正式版比预发布新
  const xs = pa.split(".");
  const ys = pb.split(".");
  for (let index = 0; index < Math.max(xs.length, ys.length); index++) {
    const [x, y] = [xs[index], ys[index]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type ClaudeStatus = {
  supported: boolean;
  sourceApp: string;
  version: string;
  claudeRunning: boolean;
  running: boolean;
  localProcess?: boolean;
  connected: boolean;
  port?: number | null;
  caReady: boolean;
  caTrusted: boolean;
  caMachineSupported: boolean;
  caMachineTrusted: boolean;
  /** 内嵌的录制版本，新的在前。builtAt 是该版本前端的构建时间（秒）。 */
  templates?: Array<{ build: string; builtAt: number | null }>;
  nodeAvailable: boolean;
  dictationReady: boolean;
  config: ClaudeConfig;
  models: string[];
  contextWindow?: number | null;
  warning?: string | null;
  needsRestart: boolean;
};

export const SOURCE_LABELS: Record<string, string> = {
  manual: "手动",
  ccswitch: "cc-switch",
  magpie: "Magpie",
  codexpp: "Codex++",
};

export const IMPORT_SOURCES: Array<{ id: UpstreamSource; label: string; detail: string }> = [
  { id: "ccswitch", label: "cc-switch", detail: "导入 cc-switch 里的 Claude 供应商" },
  { id: "magpie", label: "Magpie", detail: "把 Magpie 的本机网关当上游" },
  { id: "codexpp", label: "Codex++", detail: "把 Codex++ 的本机网关当上游" },
];

export function emptyProfile(): UpstreamProfile {
  return { id: "", name: "", baseUrl: "", apiKey: "", model: "", smallModel: "", models: [], contextWindow: null, modelNames: {}, source: "manual", sourceId: "" };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.trim();
  }
}

/** 表单校验：返回第一条问题，没有问题返回 null。 */
export function profileProblem(profile: UpstreamProfile): string | null {
  const base = profile.baseUrl.trim();
  if (!base) return "填一个 Base URL";
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return "Base URL 不是有效地址";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Base URL 要以 http:// 或 https:// 开头";
  if (/\/v1\/messages\/?$/.test(parsed.pathname)) return "Base URL 只写到根地址，不要带 /v1/messages";
  if (!profile.model.trim()) return "选一个默认模型";
  return null;
}

/** 列表去重、去空白，默认模型排第一。 */
export function normalizeModels(models: string[], primary = ""): string[] {
  const out: string[] = [];
  for (const raw of [primary, ...models]) {
    const model = raw.trim();
    if (model && !out.includes(model)) out.push(model);
  }
  return out;
}

export type Tone = "ok" | "warn" | "off" | "busy";

/** 顶部状态条：一句话 + 色调。 */
export function claudeState(status: ClaudeStatus | null, busy: string | null): { text: string; tone: Tone } {
  if (busy === "launch") return { text: "正在启动…", tone: "busy" };
  if (busy === "stop") return { text: "正在停止…", tone: "busy" };
  if (!status) return { text: "正在检测 Claude…", tone: "busy" };
  if (!status.supported) return { text: "没有找到 Claude Desktop", tone: "warn" };
  if (status.connected) return { text: "已连接", tone: "ok" };
  if (status.claudeRunning && status.localProcess) return { text: "运行中", tone: "ok" };
  if (status.claudeRunning) return { text: "Claude 已打开，但没有经 ClaudeMom 启动", tone: "warn" };
  if (status.running) return { text: "本地服务已就绪", tone: "ok" };
  return { text: "未启动", tone: "off" };
}

/** 启动前还差什么：按顺序列出，界面逐条给按钮。 */
export function setupSteps(status: ClaudeStatus | null, active: UpstreamProfile | null): Array<{ id: "upstream" | "node" | "trust"; text: string }> {
  // 没认出 Claude 时其它缺项照样列出：顶栏只说「需要先安装」，Node 这类缺项不能被它盖住（#46）。
  if (!status) return [];
  const steps: Array<{ id: "upstream" | "node" | "trust"; text: string }> = [];
  if (!active || profileProblem(active)) steps.push({ id: "upstream", text: "先添加一组上游并选好默认模型" });
  if (!status.nodeAvailable) steps.push({ id: "node", text: "需要 Node.js（支持 fetch 与 WebSocket 的版本）" });
  // 第三方模式下 Claude 不经代理，不需要信任本地证书。
  if (!status.caTrusted && !status.config.threePMode) steps.push({ id: "trust", text: "首次使用需要信任本地证书" });
  return steps;
}

export const WINDOW_PRESETS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "不声明（200k）" },
  { value: 200_000, label: "200k" },
  { value: 400_000, label: "400k" },
  { value: 1_000_000, label: "1M" },
];

export function formatWindow(value: number | null | undefined): string {
  if (!value) return "200k";
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1000)}k`;
}

export function isOk(result: { status: CommandStatus }): boolean {
  return result.status === "ok";
}

/** 录制版本的显示：前端构建日期 + build id，例如「2026-11-14 · a4ced7f85b」。 */
export function templateLabel(template: { build: string; builtAt: number | null }): string {
  if (!template.builtAt) return template.build;
  const date = new Date(template.builtAt * 1000);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${day} · ${template.build}`;
}
