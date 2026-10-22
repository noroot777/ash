// **给被审代码造一个受控的 `/proc` 世界** —— 只替换 `node:fs` 的三个读取边界。
//
// 为什么需要它:记号那一问的 `exact` 档(NUL 分隔的真实环境项、节拍级代次戳)只有 Linux 给得出,
// 而**本项目不许在 macOS 上替别的平台编结论**(根 AGENTS.md)。所以这里跟审查用同一个办法:
// 把 `/proc/self/environ`(档位探测)、`readdir("/proc")`(进程枚举)、`/proc/<pid>/environ`
// 与 `/proc/<pid>/stat`(环境项与代次)这四个读取点按台子的剧本回答,**被测的扫描、判档、
// 代次比较、发信号函数一律是产品里那一份,进程、信号、死活全是真的**。
//
// 它证的是「这套取证逻辑在 exact 档上的行为」,**不是**「在原生 Linux 内核上压出了 pid 复用」
// —— 后者这台机器做不到,报告里也要照实写。
//
// 两条纪律:
//  ① 剧本按「第几次读」写(`counters`),所以每个用例在调被测函数之前都要重新 `install` 归零;
//  ② **台子要一直开到最后一发延迟信号结束**。提前 `restore()` 会让模拟的 `j:<节拍>` 跟恢复后
//     macOS 的 `t:<启动时刻>` 比较 —— 不相等是必然的,于是测试通过却什么都没检验
//     (第 16 轮审查 F1-A 指出的正是这个台子缺口)。
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { invalidateMonitorUnitScan } from "../src/monitor-unit-scan.js";

/** 这一遍扫描里,被造出来的那个「Linux 进程」该怎么回答。 */
export type FakeAnswers = {
  /** 第 n 次读 `environ` 时,环境里有哪些记号(1 起算;空数组 = 一条都没有)。 */
  tokensOnEnvRead: (n: number) => string[];
  /** 第 n 次读 `stat` 时,这个号上是哪一代(`null` = 这一问失败);1 起算。 */
  genOnStatRead: (n: number) => string | null;
};

const real = {
  existsSync: filesystem.existsSync,
  readFileSync: filesystem.readFileSync,
  readdirSync: filesystem.readdirSync,
};
export const counters = { env: 0, stat: 0, readdir: 0 };

/**
 * `/proc/<pid>/stat`:右括号之后必须有 20 项,第 20 项(整体第 22 项)是 `starttime`,
 * 第 3 项(整体第 5 项)是 `pgrp`。`comm` 故意带空格和括号 —— 产品那边按 `lastIndexOf(")")`
 * 切,这里就把那条路一起走到。
 */
const statText = (pid: number, pgrp: number, gen: string) =>
  `${pid} (fake proc) ${["S", "1", String(pgrp), "1", "0", "-1", "4194304",
    "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", gen,
    // starttime 之后真实的 stat 还有三十来项(vsize/rss/…),照着留几项:**不让被测代码
    // 依赖「我们要的那一项正好在行尾」**。
    "4358144", "277", "18446744073709551615"].join(" ")}\n`;

export function install(pid: number, answers: FakeAnswers): void {
  counters.env = 0; counters.stat = 0; counters.readdir = 0;
  filesystem.existsSync = ((path: any) =>
    path === "/proc/self/environ" || real.existsSync(path)) as typeof filesystem.existsSync;
  filesystem.readdirSync = ((path: any, ...rest: any[]) => {
    if (path !== "/proc") return (real.readdirSync as any)(path, ...rest);
    counters.readdir += 1;
    return [String(pid)];
  }) as typeof filesystem.readdirSync;
  filesystem.readFileSync = ((path: any, ...rest: any[]) => {
    if (path === `/proc/${pid}/environ`) {
      counters.env += 1;
      const items = ["PATH=/usr/bin", "HOME=/root"];
      for (const mark of answers.tokensOnEnvRead(counters.env)) items.push(`ASH_MONITOR_UNIT=${mark}`);
      return `${items.join("\0")}\0`;
    }
    if (path === `/proc/${pid}/stat`) {
      counters.stat += 1;
      const gen = answers.genOnStatRead(counters.stat);
      if (!gen) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return statText(pid, pid, gen);
    }
    return (real.readFileSync as any)(path, ...rest);
  }) as typeof filesystem.readFileSync;
  syncBuiltinESMExports();
  invalidateMonitorUnitScan();
}

/**
 * **这个台子在原生 Windows 上立不起来**,所以用它的脚本开跑前先问这一句。
 *
 * 它造的是一个 Linux `/proc` 世界,而 `exact` 这一档的前提(`monitor-unit-scan.ts:115`
 * 在 `IS_WINDOWS` 上直接返回 `null`)在那台机器上是**结构性缺席**,不是没写到。在那边把
 * `node:fs` 糊成 Linux 再断言「记号这一问答对了」,等于拿伪造的前提替那个平台编结论 ——
 * 跟这份夹具顶注里那条纪律是同一件事,只是方向反过来。
 *
 * 所以这里给的是**点名跳过**而不是让它通过:原来那 15 项红是夹具前提不成立,不是产品有伤,
 * 混在输出里会把真伤盖掉。Windows 上这条链由 `test-kill-lineage.ts` 的 ④ 覆盖 —— 那一节走
 * 的是真表、真 `taskkill`、零注入的生产路径。
 */
export function skipWithoutProcWorld(what: string): boolean {
  if (process.platform !== "win32") return false;
  console.log(`- 跳过 ${what}:这台机器没有 /proc,exact 档在 Windows 上结构性不存在`);
  console.log("  (Windows 侧的逃逸后代回收由 test-kill-lineage.ts 的 ④ 走生产路径覆盖)");
  return true;
}

export function restore(): void {
  filesystem.existsSync = real.existsSync;
  filesystem.readFileSync = real.readFileSync;
  filesystem.readdirSync = real.readdirSync;
  syncBuiltinESMExports();
  invalidateMonitorUnitScan();
}
