// DOM 探针的后台：把页面发来的结构存进数据目录，一次一个文件。
import fs from "node:fs";
import path from "node:path";

export default function create(ctx) {
  const safe = (text) => String(text || "").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "page";
  return {
    save({ surface, reason, data } = {}) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(ctx.dataDir, `dump-${stamp}-${safe(surface)}-${safe(reason)}.json`);
      fs.writeFileSync(file, JSON.stringify(data, null, 1));
      return { file, bytes: fs.statSync(file).size };
    },
    list() {
      return fs.readdirSync(ctx.dataDir).filter((name) => name.startsWith("dump-")).sort();
    },
  };
}
