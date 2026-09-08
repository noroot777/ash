// PATH 里「别人家的 node_modules/.bin」怎么摘（server/src/executors/bin-resolve.ts）。
//
// 起因是一次实测出来的**谎报成功**：ash 自己是 `npm run start` 起来的，npm 把
// `<ash>/node_modules/.bin` 塞在 PATH 最前面，server 原样继承、又原样传给子进程。于是
// 一个**依赖一个都没装**的前端项目，预览命令 `npm run dev`（脚本是 `vite`）照样起来了，
// 用的是 ash 自己那份 vite。用户点开一个能打开的页面，验收的却是 ash 的 vite 版本 +
// ash 的插件跑出来的东西。宁可报「起不来」，也不能给他这个。
//
// 两个方向的错都要钉住，而且不对称：
//   · 漏摘（别人家的 .bin 留在 PATH 上）= 上面那件事，用户拿不到任何提示。
//   · 多摘（把**本项目的** .bin 也摘了）= 在 ash 自己仓库里干活的任务突然找不到 tsx /
//     vite，一个本来好好的预览变成「起不来」。
//
// 跑法：npm -w server run test:foreign-bins
import { sep } from "node:path";
import { withoutForeignNodeBins } from "../src/executors/bin-resolve.js";
import { PATH_DELIMITER } from "../src/platform.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

const D = PATH_DELIMITER;
const p = (...parts: string[]) => parts.join(sep);
const ASH = p("", "workspace", "ash");
const PROJECT = p("", "workspace", "a4sms-allinone");
const WORKTREE = p(PROJECT, ".worktrees", "T1");
const kept = (path: string, cwd: string) => {
  const out = withoutForeignNodeBins({ PATH: path }, cwd).PATH ?? "";
  return out ? out.split(D) : [];
};

// —— 摘掉别人家的 ——
const mixed = [
  p(ASH, "node_modules", ".bin"),
  p("", "workspace", "node_modules", ".bin"),
  p("", "usr", "local", "bin"),
  p("", "usr", "bin"),
].join(D);
check(
  "别的项目里跑：ash 自己的 .bin 摘掉",
  kept(mixed, WORKTREE),
  // `/workspace/node_modules/.bin` 留着是**故意的**：`/workspace` 是这个 cwd 的祖先，
  // node 自己解析 bin 时本来就会看到它。判据是「按 node 的语义它属不属于这个项目」，
  // 不是「这条是不是 npm 塞进来的」—— 后者要靠猜 ash 装在哪儿，猜错就会把用户项目
  // 自己的 .bin 也摘掉。
  [p("", "workspace", "node_modules", ".bin"), p("", "usr", "local", "bin"), p("", "usr", "bin")],
);
check("普通目录一个都不许摘", kept(p("", "opt", "homebrew", "bin"), WORKTREE), [p("", "opt", "homebrew", "bin")]);

// —— 本项目的必须留下 ——
// ash 仓库里的任务（cwd 在 ash 之下）用的正是 ash 的 tsx/vite —— 那时它不是「别人家的」。
check(
  "在 ash 仓库里干活：它自己的 .bin 留着",
  kept(mixed, p(ASH, ".worktrees", "T2")),
  [p(ASH, "node_modules", ".bin"), p("", "workspace", "node_modules", ".bin"), p("", "usr", "local", "bin"), p("", "usr", "bin")],
);
check(
  "cwd 就是那个项目根也算本项目",
  kept(p(PROJECT, "node_modules", ".bin"), PROJECT),
  [p(PROJECT, "node_modules", ".bin")],
);
check(
  "子目录的 .bin 罩不住上层 cwd，摘掉",
  kept(p(PROJECT, "web", "node_modules", ".bin"), PROJECT),
  [],
);
check(
  "上层的 .bin 罩得住子目录 cwd，留着",
  kept(p(PROJECT, "node_modules", ".bin"), p(PROJECT, "web")),
  [p(PROJECT, "node_modules", ".bin")],
);

// —— 边角 ——
check("尾斜杠不影响判断", kept(p(ASH, "node_modules", ".bin") + sep, WORKTREE), []);
check("名字相近的目录不算 .bin", kept(p(ASH, "node_modules", ".binx"), WORKTREE), [p(ASH, "node_modules", ".binx")]);
check("不在 node_modules 下的 .bin 不动它", kept(p("", "opt", "tools", ".bin"), WORKTREE), [p("", "opt", "tools", ".bin")]);
check("空 PATH 不炸", kept("", WORKTREE), []);
check("PATH 缺失时给空串", withoutForeignNodeBins({}, WORKTREE).PATH, "");
// 环境里的其它变量原样带走：这个函数只碰 PATH。
check("只改 PATH", withoutForeignNodeBins({ PATH: "", FOO: "bar" }, WORKTREE).FOO, "bar");

console.log(failures ? `\n${failures} 条没过` : "\n全过");
process.exit(failures ? 1 : 0);
