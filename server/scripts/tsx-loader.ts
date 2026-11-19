// 子进程要用的 tsx 在哪:加载器(`--import <它>`)和 CLI(`node <它> src/index.ts`)。
//
// **按包解析,不按目录猜。** 两种猜法都栽过:
//  · 写死 `<检出>/node_modules/tsx/...`:任务默认在 git worktree 里跑(`.worktrees/<id>/`),
//    那里的仓库根下压根没有 `node_modules`,于是炸在 `ERR_MODULE_NOT_FOUND`,而它跟被测的东西
//    毫无关系(报错还长得像产品缺陷);
//  · 往上找「第一个有 node_modules 的目录」:win-remote 在 Windows 上的工作区里 `node_modules`
//    只放了 `@navi/*` 几条 junction,其余依赖靠 Node 逐级向上解析到主仓 —— 第一个目录找到了,
//    里面却没有 tsx(2026-11-19 真机上 test:handoff 的对端 server 因此起不来)。
//
// tsx 的 `exports` 里写着这两个口:`.` 是加载器(`dist/loader.mjs`,也就是 `--import tsx`
// 用的那个),`./cli` 是 CLI。拿 `createRequire` 按 Node 自己的规则解析,目录布局怎么变都跟
// 着 Node 走。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function resolveTsx(specifier: "tsx" | "tsx/cli"): string {
  try {
    return require.resolve(specifier);
  } catch (error) {
    throw new Error(`找不到 ${specifier}(按包解析失败):这几条用例要起独立进程跑 .ts —— ${(error as Error).message}`);
  }
}

export function tsxLoaderPath(): string {
  return resolveTsx("tsx");
}

export function tsxCliPath(): string {
  return resolveTsx("tsx/cli");
}
