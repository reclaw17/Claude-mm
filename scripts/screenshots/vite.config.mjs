// Screenshot harness: builds the real ClaudeMom frontend with its UI strings translated and Tauri replaced
// by a fake, so the README images (docs/images/<lang>/claudemom.png) can be rendered on any OS.
// Driven by shoot.sh through SHOT_APP_DIR, SHOT_LANG (en | ru | zh) and SHOT_OUT_DIR; not used by the app.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.SHOT_APP_DIR;
const lang = process.env.SHOT_LANG;
const outDir = process.env.SHOT_OUT_DIR;
if (!appDir || !lang || !outDir) throw new Error("SHOT_APP_DIR, SHOT_LANG and SHOT_OUT_DIR are required");

const require = createRequire(path.join(appDir, "package.json"));
const react = (await import(require.resolve("@vitejs/plugin-react").replace(/\.cjs$/, ".js"))).default;

/** Replaces Chinese UI strings with translations, longest key first so a short key never cuts into a longer one. */
function translate(dict) {
  const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
  return {
    name: "shot-translate",
    enforce: "pre",
    transform(code, id) {
      if (!/\/src\/[^/]+\.tsx?$/.test(id)) return null;
      let out = code;
      let used = 0;
      for (const key of keys) {
        if (!out.includes(key)) continue;
        used += 1;
        out = out.split(key).join(dict[key]);
      }
      if (process.env.SHOT_DEBUG) {
        const left = (out.match(/\p{Script=Han}/gu) || []).length;
        console.error(`[shot-translate] ${path.basename(id)}: ${used} keys applied, Han characters left: ${left}`);
      }
      return used ? { code: out, map: null } : null;
    },
  };
}

/** Fake Tauri IPC and the macOS window buttons, injected before the app bundle. */
function fakeHost(responses) {
  const head = readFileSync(path.join(here, "head.js"), "utf8").replace("/*__RESPONSES__*/{}", JSON.stringify(responses));
  const extra = readFileSync(path.join(here, "extra.html"), "utf8");
  return {
    name: "shot-fake-host",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html
          .replace("<html lang=", `<html data-shot-lang="${lang}" lang=`)
          .replace("</head>", `<script>${head}</script>${extra}</head>`);
      },
    },
  };
}

const tauri = JSON.parse(readFileSync(path.join(appDir, "src-tauri", "tauri.conf.json"), "utf8"));
const responses = JSON.parse(readFileSync(path.join(here, "data.json"), "utf8"));
responses["plugin:app|version"] = tauri.version;
responses["plugin:updater|check"] = null;
const dict = lang === "zh" ? {} : JSON.parse(readFileSync(path.join(here, `dict.${lang}.json`), "utf8"));

export default {
  root: appDir,
  base: "./",
  plugins: [react(), translate(dict), fakeHost(responses)],
  build: {
    outDir,
    emptyOutDir: true,
    target: ["es2020", "safari14", "chrome87", "edge88", "firefox78"],
    cssTarget: ["safari14", "chrome87", "edge88", "firefox78"],
  },
};
