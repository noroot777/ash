// 子进程要用的 tsx 加载器在哪。
//
// 为什么不能写死 `../../node_modules/tsx/dist/loader.mjs`:**任务默认在 git worktree 里跑**
// (`.worktrees/<id>/`),而那里只有 `server/node_modules` 一条指回主仓的软链 —— 仓库根下压根
// 没有 `node_modules`,于是写死那条路的用例在 worktree 里一律炸在
// `ERR_MODULE_NOT_FOUND: .../<worktree>/node_modules/tsx/dist/loader.mjs`,
// 而它跟被测的东西毫无关系(报错还长得像产品缺陷)。
//
// `import.meta.resolve("tsx/dist/loader.mjs")` 也不行:那个子路径没写进 tsx 的 `exports`。
// 所以按目录往上找 —— worktree 嵌在主仓里面(`<repo>/.worktrees/<id>/server/scripts`),
// 一路往上走一定会走到主仓根的那一份。
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

export function tsxLoaderPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "loader.mjs");
    if (existsSync(candidate)) return candidate;
    if (dir === root) break;
    dir = dirname(dir);
  }
  throw new Error("找不到 tsx 的加载器(node_modules/tsx/dist/loader.mjs):这几条用例要起独立进程跑 .ts");
}
