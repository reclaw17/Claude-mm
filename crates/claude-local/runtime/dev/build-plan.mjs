// 开发用：在 JS 里拼一份注入计划。
//
// 正式的计划由 Rust 渲染（src/extensions/plan.rs），清单规则也只在 Rust 里。这里为了让开发工具（浏览器预览、
// 录制版界面实测）不依赖宿主程序就能跑，按同样的模板拼一份：清单只读用得上的几个字段、不做校验，配置取默认值。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_TOKEN_PLACEHOLDER } from "../extensions.mjs";
import { PAGE_API_PREFIX } from "../page-api.mjs";

const runtimeDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => fs.readFileSync(path.join(runtimeDir, name), "utf8");

function defaults(schema = {}) {
  const fallback = { number: 0, boolean: false, array: [], object: {} };
  return Object.fromEntries(Object.entries(schema).map(([key, field]) => [key, field.default ?? fallback[field.type] ?? ""]));
}

/** dirs：拓展包目录（里面有 codexpp.json）；dataRoot：各拓展后台的数据目录放在它下面。 */
export function buildPlan(dirs, { dataRoot }) {
  const wrap = read("page-wrap.js");
  const [head, rest] = wrap.split("/*CODEXPP_STYLES*/");
  const [middle, tail] = rest.split("/*CODEXPP_SOURCE*/");
  const packages = dirs.map((dir) => {
    const root = path.resolve(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "codexpp.json"), "utf8"));
    const claude = manifest.claudeDesktop ?? {};
    const scripts = [].concat(claude.renderer ?? []);
    const styles = claude.styles ?? [];
    const methods = claude.methods ?? [];
    const config = defaults(manifest.config);
    const pageConfig = Object.fromEntries(Object.entries(config).map(([key, value]) => [key, manifest.config?.[key]?.secret ? null : value]));
    const key = `local:${manifest.id}`;
    const meta = {
      key, name: manifest.name ?? manifest.id, source: "local",
      manifest: {
        id: manifest.id, name: manifest.name ?? manifest.id, version: manifest.version ?? "", description: manifest.description ?? "",
        engines: { codexpp: 1 }, permissions: { routes: manifest.permissions?.routes ?? [] }, config: pageConfig,
        claudeDesktop: { methods, backend: Boolean(manifest.backend?.script) },
      },
    };
    const pieces = [{ text: head.replace("/*CODEXPP_META*/null", JSON.stringify(meta)) }];
    for (const file of styles) pieces.push({ text: `    runtime.addStyle(meta.key, ${JSON.stringify(file)}, ` }, { file, json: true }, { text: ");\n" });
    pieces.push({ text: middle });
    for (const file of scripts) pieces.push({ file }, { text: "\n;\n" });
    pieces.push({ text: tail });
    return {
      key, slug: `l-${manifest.id}`, id: manifest.id, name: meta.name, version: meta.manifest.version, root, pieces, methods,
      routes: meta.manifest.permissions.routes, backend: manifest.backend?.script ? path.join(root, manifest.backend.script) : null,
      config, dataDir: path.join(dataRoot, manifest.id), hosted: false,
    };
  });
  const boot = {
    version: 1, apiVersion: 1, host: "claudeDesktop", transport: "http", token: PAGE_TOKEN_PLACEHOLDER, api: PAGE_API_PREFIX,
    packages: packages.map((item) => ({ key: item.key, name: item.name, slug: item.slug })),
  };
  return {
    version: 1, transport: "http", legacy: [], packages,
    runtime: { key: "runtime", pieces: [{ text: `window.__codexPlusClaudeBoot = ${JSON.stringify(boot)};\n${read("page-anchors.js")}\n;\n${read("page-runtime.js")}` }] },
  };
}

