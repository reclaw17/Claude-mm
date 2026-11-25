// 页面扩展：扩展包是一个文件夹 <id>/manifest.json + 清单里列出的 js / css。
// 启用了哪些写在状态文件里（{"enabled": [...]}，ClaudeMom 改），每次请求现读：开关、改文件都是刷新页面就生效。
// 只提供清单里列出的、启用中的扩展的文件；不跟符号链接，不出扩展自己的文件夹。
// 清单规则与 src/extensions.rs 一致。
// 文件夹里有 codexpp.json 的是 Codex++ 拓展包，不走这里：它们按注入计划下发（见 createPagePlan）。
import fs from "node:fs";
import path from "node:path";

export const EXTENSION_PREFIX = "/__codex_plus/ext/";
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const FILE = /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/;
const MAX_FILES = 32;

const text = (value, max) => typeof value === "string" && value.length <= max;
const files = (value, ext) => value === undefined ? [] :
  Array.isArray(value) && value.length <= MAX_FILES && value.every((file) => text(file, 256) && FILE.test(file) && file.endsWith(ext))
    ? value
    : null;

/** 合法时返回 {id, name, version, scripts, styles}，否则 null。 */
export function parseManifest(raw, id) {
  let manifest;
  try { manifest = JSON.parse(raw); } catch { return null; }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  if (manifest.id !== id || !ID.test(id)) return null;
  if (!text(manifest.name, 64) || !manifest.name.trim() || !text(manifest.version, 64) || !VERSION.test(manifest.version)) return null;
  // null 和不写一样（Rust 侧按 Option 读）。
  if (manifest.author != null && !text(manifest.author, 64)) return null;
  if (manifest.description != null && !text(manifest.description, 500)) return null;
  const scripts = files(manifest.scripts, ".js");
  const styles = files(manifest.styles, ".css");
  if (!scripts || !styles || !scripts.length && !styles.length) return null;
  return { id, name: manifest.name, version: manifest.version, scripts, styles };
}

/** dirs：先内置后用户，同 id 以先找到的为准。 */
export function createExtensions({ dirs, stateFile }) {
  const enabledIds = () => {
    try {
      const enabled = JSON.parse(fs.readFileSync(stateFile, "utf8")).enabled;
      return Array.isArray(enabled) ? [...new Set(enabled.filter((id) => typeof id === "string" && ID.test(id)))].sort() : [];
    } catch {
      return [];
    }
  };
  const load = (id) => {
    for (const dir of dirs) {
      const root = path.join(dir, id);
      try {
        if (!fs.lstatSync(root).isDirectory()) continue;
        if (fs.existsSync(path.join(root, "codexpp.json"))) return null;
        const manifest = parseManifest(fs.readFileSync(path.join(root, "manifest.json"), "utf8"), id);
        if (manifest) return { ...manifest, root };
      } catch {}
    }
    return null;
  };
  const enabled = () => enabledIds().map(load).filter(Boolean);

  return {
    /** 要插进页面的标签，按扩展 id 排序；每个扩展先样式后脚本，按清单顺序。 */
    assets() {
      return enabled().flatMap(({ id, scripts, styles }) => [
        ...styles.map((file) => ({ type: "style", href: `${EXTENSION_PREFIX}${id}/${file}` })),
        ...scripts.map((file) => ({ type: "script", href: `${EXTENSION_PREFIX}${id}/${file}` })),
      ]);
    },
    /** pathname 去掉前缀后的 `<id>/<file>`；不是启用中扩展清单里的文件就返回 null。 */
    read(rest) {
      const slash = rest.indexOf("/");
      if (slash < 1) return null;
      const id = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      if (!ID.test(id) || !enabledIds().includes(id)) return null;
      const extension = load(id);
      if (!extension) return null;
      const type = extension.scripts.includes(file) ? "text/javascript; charset=utf-8"
        : extension.styles.includes(file) ? "text/css; charset=utf-8"
        : null;
      if (!type) return null;
      try {
        const full = path.join(extension.root, file);
        if (!fs.lstatSync(full).isFile()) return null;
        const real = fs.realpathSync(full);
        if (!real.startsWith(fs.realpathSync(extension.root) + path.sep)) return null;
        return { body: fs.readFileSync(real), type };
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------- Codex++ 拓展包（codexpp.json）
// 这些包不在这里解析：清单规则、页面运行时和每个包的包装都由 src/extensions/plan.rs 渲染成一份注入计划
//（page-plan.json）。这里只做「读文件、拼接」：一段脚本由若干片组成，{ text } 原样拼上，{ file } 读包里的文件
// 拼上（json 为真时先 JSON.stringify）。脚本文件每次请求现读，所以改了脚本刷新页面就生效。

export const PAGE_RUNTIME_PATH = "/__codex_plus/rt/runtime.js";
export const PAGE_PACKAGE_PREFIX = "/__codex_plus/pkg/";
export const PAGE_TOKEN_PLACEHOLDER = "__CODEXPP_PAGE_TOKEN__";
const SLUG = /^[A-Za-z0-9_-]{1,80}$/;

/** 读包里的一个文件：只认合法的相对路径，不跟符号链接，不出包自己的文件夹。读不到返回 null。 */
function readInside(root, file) {
  if (typeof root !== "string" || !root || !text(file, 256) || !FILE.test(file)) return null;
  try {
    const full = path.join(root, file);
    if (!fs.lstatSync(full).isFile()) return null;
    const real = fs.realpathSync(full);
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) return null;
    return fs.readFileSync(real, "utf8");
  } catch {
    return null;
  }
}

/** 把若干片拼成一段脚本；有文件读不到时返回 null（这一段不下发，页面运行时会把它记成没执行）。 */
export function renderPieces(pieces, root) {
  if (!Array.isArray(pieces)) return null;
  let out = "";
  for (const piece of pieces) {
    if (typeof piece?.text === "string") {
      out += piece.text;
    } else if (typeof piece?.file === "string") {
      const body = readInside(root, piece.file);
      if (body === null) return null;
      out += piece.json ? JSON.stringify(body) : body;
    } else {
      return null;
    }
  }
  return out;
}

/**
 * 读注入计划。planFile 由宿主程序写，里面有给后台的配置，所以只认只有本人可读的普通文件（isPrivate 判断）。
 * 按修改时间缓存，文件变了下一次请求就用新的。
 */
export function createPagePlan({ planFile, isPrivate = () => true }) {
  let cached = { stamp: "", plan: null };
  const load = () => {
    try {
      const stat = fs.lstatSync(planFile);
      if (!isPrivate(stat)) return null;
      const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
      if (stamp !== cached.stamp) {
        const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
        const valid = plan && plan.version === 1 && plan.transport === "http" && Array.isArray(plan.packages) &&
          plan.packages.every((item) => item && typeof item.key === "string" && typeof item.slug === "string" && SLUG.test(item.slug));
        cached = { stamp, plan: valid ? plan : null };
      }
      return cached.plan;
    } catch {
      cached = { stamp: "", plan: null };
      return null;
    }
  };
  const active = () => {
    const plan = load();
    return plan && plan.runtime && plan.packages.length ? plan : null;
  };
  return {
    /** 要插进页面的脚本地址：运行时在前，然后每个包一个。 */
    scripts() {
      const plan = active();
      return plan ? [PAGE_RUNTIME_PATH, ...plan.packages.map((item) => `${PAGE_PACKAGE_PREFIX}${item.slug}.js`)] : [];
    },
    /** pathname 对应的脚本内容；不是计划里的返回 null。token 换掉运行时里的占位符。 */
    script(pathname, token) {
      const plan = active();
      if (!plan) return null;
      if (pathname === PAGE_RUNTIME_PATH) {
        const source = renderPieces(plan.runtime.pieces, null);
        return source === null ? null : source.split(PAGE_TOKEN_PLACEHOLDER).join(token);
      }
      if (!pathname.startsWith(PAGE_PACKAGE_PREFIX) || !pathname.endsWith(".js")) return null;
      const slug = pathname.slice(PAGE_PACKAGE_PREFIX.length, -3);
      const item = plan.packages.find((candidate) => candidate.slug === slug);
      return item ? renderPieces(item.pieces, item.root) : null;
    },
    /** 启用中的包（页面调后台时按它校验）。 */
    package(key) {
      return active()?.packages.find((item) => item.key === key) ?? null;
    },
    keys() {
      return new Set((active()?.packages ?? []).map((item) => item.key));
    },
  };
}
