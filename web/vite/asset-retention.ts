// 新 build 不清空 dist/assets:**开着的旧页面还要按需去拉它那一版的懒加载分块**。
//
// 终端、Git 工作台是 `lazy(() => import(...))` 拆出去的分块,第一次打开时才下载。一个
// 很久没刷新的页面手里是旧的入口脚本,它要的是旧 hash 的分块;vite 默认每次 build 先清空
// outDir,那份文件就没了,点终端 = 导入失败。旧分块只从旧入口(早已在页面的模块表里)
// 取导出,所以把文件留着,旧页面就能照常打开它那一版。
//
// 留多久:懒加载分块和字体等资源留 RETAIN_DAYS 天(按 mtime 算 —— 每次 build 都会重写
// 当前产物,所以 mtime 就是它最后一次还在用的那次 build)。旧版入口脚本和入口样式当场删:
// 它们只在页面加载那一刻下载,开着的页面不会再要。入口每次 build 都换 hash、体积又最大,
// 不删的话这个目录涨得最快。超过期限的页面拿不到分块时,前端的错误边界会提示刷新。

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

const RETAIN_DAYS = 14;
// 上一次 build 的入口文件清单,下一次 build 据此精确删掉旧入口(不靠文件名猜)。
const LEDGER = ".entry-assets.json";

export function retainPreviousAssets(): Plugin {
  return {
    name: "ash:retain-previous-assets",
    apply: "build",
    config: () => ({ build: { emptyOutDir: false } }),
    writeBundle(options, bundle) {
      if (!options.dir) return;
      const current = new Set(Object.keys(bundle));
      const entries = Object.values(bundle).flatMap((item) =>
        item.type === "chunk" && item.isEntry ? [item.fileName, ...(item.viteMetadata?.importedCss ?? [])] : [],
      );
      const ledgerPath = join(options.dir, LEDGER);
      let previousEntries: string[] = [];
      try { previousEntries = JSON.parse(readFileSync(ledgerPath, "utf8")); } catch { /* 第一次 build 没有清单 */ }
      const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
      const assetsDir = join(options.dir, "assets");
      for (const name of readdirSync(assetsDir)) {
        const file = `assets/${name}`;
        if (current.has(file)) continue;
        const path = join(assetsDir, name);
        if (previousEntries.includes(file) || statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      }
      writeFileSync(ledgerPath, JSON.stringify(entries));
    },
  };
}
