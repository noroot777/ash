// **内核圈定回归**(`test-kernel-confine.ts`)的现场机件:计分板、线索尽断的后代怎么造出来、
// 两个平台各自的圈定时机、以及几个「这个号现在到底什么状态」的读法。
//
// 为什么独立成文件:用例本体一度写到 756 行(全局上限 700)。按职责切开之后,那边只留
// 「问什么、答什么」,这边只管「现场怎么搭」—— 改判据的人不必读 spawn 细节,反之亦然。
//
// 有一条**顺序**约束落在这个文件上:`staleCredential` 必须在**本进程第一次开圈之前**就埋好
// (见 `plantStaleCredential` 的注释)。ESM 先求值被导入的模块,所以只要用例 import 它,
// 这一句就一定早于用例里任何一次 `openConfinement` —— 这正是把它放在这儿的理由。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IS_WINDOWS as IS_WIN, isPidAlive } from "../src/platform.js";
import {
  CONFINE_ENROLL_CMD, type ConfineCoverage, type Confinement,
} from "../src/executors/kernel-confine.js";

let bad = 0;
export const ok = (m: string) => console.log(`   ✓ ${m}`);
export const fail = (m: string) => { bad += 1; console.log(`   ✗ ${m}`); };
export const skip = (m: string) => console.log(`   ⊘ 跳过:${m}`);
/** 到这一刻为止有多少项没通过(用例末尾据此决定退出码)。 */
export const failCount = (): number => bad;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 「把记号那条线索弄断」的环境。POSIX 上直接空着(= `env -i`);Windows 上留住系统那几项
 * (少了 `SystemRoot` 一类,node 自己起不来 —— 那就不是「后代躲过了设备」,是夹具没起来),
 * 但**一项 `ASH_` 都不带**,所以资源记号那条线索照样是断的。
 */
export function cleanEnv(): Record<string, string> {
  if (!IS_WIN) return {};
  const keep = ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "Path", "PATHEXT",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "USERPROFILE", "COMSPEC"];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

/**
 * **线索尽断的后代**:环境清空(记号没了)+ `stdio: ignore`(不继承追踪 fd、也不接这次运行
 * 的输出文件)+ `detached`(POSIX 上就是 `setsid`,脱离进程组;根一死就被重父到 1 号)。
 *
 * 根进程把后代的号打到 stdout 上,用例据此跟踪它。`delayMs` 之后才生这个后代:Windows 那
 * 条路只能在 `spawn` **之后**才 assign 得进圈(`since-enroll`),所以要给圈定留出时间 ——
 * 那个窗口是那个平台真实的能力边界,夹具不替它假装不存在,只是不让它干扰这一条的结论。
 */
export const rootCodeWith = (delayMs: number) => `
const { spawn } = require("node:child_process");
setTimeout(() => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, env: ${JSON.stringify(cleanEnv())}, windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (!child.pid) process.exit(2);
  process.stdout.write(String(child.pid) + "\\n");
  child.unref();
}, ${delayMs});
setInterval(() => {}, 1000);
`;

/** 读根打到 stdout 上的后代号。 */
export function firstPidFrom(child: ReturnType<typeof spawn>, label: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`${label}没在 20 秒内报出后代的号`)), 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += String(chunk);
      const n = Number(out.trim().split("\n")[0]);
      if (Number.isInteger(n) && n > 1) { clearTimeout(timer); resolve(n); }
    });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

export type Scene = { root: number; descendant: number; coverage: ConfineCoverage };

/**
 * POSIX:圈定发生在 `exec` **之前**(同 detached.ts 那两条生产路径的做法),所以这一轮
 * 的集合罩得住整段运行 —— `whole-run`。
 */
async function scenePosix(dev: Confinement): Promise<Scene> {
  const env = { ...process.env, ...(dev.preExecEnv() ?? {}) };
  const child = spawn("/bin/sh", ["-c", `${CONFINE_ENROLL_CMD}; exec "$@"`, "sh",
    process.execPath, "-e", rootCodeWith(0)], {
    env, detached: true, stdio: ["ignore", "pipe", "ignore"],
  });
  // 父侧再圈一次,跟两条生产路径一字不差(`confine?.enroll(real.pid)`):**幂等**,而且
  // `whole-run` 那份凭据要核对的就是这个号(见 kernel-confine.ts 的 `confirmWholeRun`)。
  if (child.pid) dev.enroll(child.pid);
  const descendant = await firstPidFrom(child, "根进程");
  child.unref();
  return { root: child.pid ?? 0, descendant, coverage: "whole-run" };
}

/**
 * Windows:`AssignProcessToJobObject` 只能在 `spawn` 之后(拿不到 `CREATE_SUSPENDED`),
 * 所以恒是 `since-enroll`。夹具先把根 assign 进圈、**等圈真的认下它**,再让根去生后代 ——
 * 验的是「根已经在圈里之后出生的后代也必然在集合里」(Job Object 的继承语义),这正是那个
 * 平台上这台设备能给的那一档。
 */
async function sceneWindows(dev: Confinement): Promise<Scene> {
  const child = spawn(process.execPath, ["-e", rootCodeWith(4_000)], {
    env: cleanEnv(), detached: true, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  });
  const root = child.pid ?? 0;
  assert.ok(root, "前置条件:根进程起得来");
  assert.ok(dev.enroll(root), "前置条件:根进程 assign 进 Job Object");
  for (let i = 0; i < 40; i += 1) {                 // 等守圈进程把句柄握住、集合里能读到根
    const read = dev.read();
    if (read.kind === "members" && read.members.some((m) => m.pid === root)) break;
    await sleep(250);
  }
  const descendant = await firstPidFrom(child, "根进程");
  child.unref();
  return { root, descendant, coverage: "since-enroll" };
}

export const scene = (dev: Confinement) => (IS_WIN ? sceneWindows(dev) : scenePosix(dev));

/** 「这个号上还有一个在跑的进程」。僵尸(已被杀、等人回收)不算在跑 —— 见第 4 组 ④ 的注释。 */
export function stillRunning(pid: number): boolean {
  if (!isPidAlive(pid)) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0] !== "Z";
  } catch { /* 不是 Linux,退回 ps */ }
  try {
    const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return !state.startsWith("Z");
  } catch {
    return false;                                 // 问不出来就只能按「号还在」那条走(上面已经判过)
  }
}

export function readPpid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    return Number(fields[1]);                     // 第 4 项 ppid = 右括号之后的第 2 项
  } catch { /* 不是 Linux,退回 ps */ }
  try {
    return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

/** 把一个号挪进圈里新建的子 cgroup。`"skipped"` = 这个平台上没有这条路。 */
export function nestInsideConfinement(id: string, pid: number): "ok" | "skipped" | string {
  if (!id.startsWith("/")) return "skipped";      // Windows 的圈号不是路径
  const mount = ["/sys/fs/cgroup", "/sys/fs/cgroup/unified"]
    .find((m) => existsSync(join(m, "cgroup.controllers")));
  if (!mount) return "skipped";
  const nested = join(mount, `.${id}`, "nested");
  try {
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "cgroup.procs"), String(pid));
    return "ok";
  } catch (error) {
    try { rmdirSync(nested); } catch { /* 建都没建出来 */ }
    return (error as NodeJS.ErrnoException).code ?? String(error);
  }
}

/**
 * **过期凭据**夹具(断言收在用例第 4 组⑥)。两个平台盘上那点东西不是同一件,扫它的时机也
 * 不同:
 *
 *   · cgroup 这边是**入圈凭据** `*.enrolled`,`openCgroupConfinement` 每次开圈都顺手扫一遍
 *     ⇒ 临场埋、临场验就行;
 *   · Windows 这边**没有入圈凭据**(拿不到 `CREATE_SUSPENDED`,那台设备恒是 `since-enroll`),
 *     盘上那点东西是守圈进程的**就绪信号** `*.ready`,而扫它只发生在**本进程第一次把守圈
 *     进程拉起来**那一刻(一次性闸)⇒ 夹具必须埋在第一次开圈之前,所以 `staleCredential`
 *     写在这个模块的顶层(import 即执行,早于用例里任何一次 `openConfinement`)。
 *
 * 两边删早了都只是少说一句话(档位退回 `since-enroll` / 读数退成弃权),不会误判成「空」。
 */
export function plantStaleCredential(suffix: string): string {
  const file = join(tmpdir(), "ash-confine", `ash-agent-stale-fixture.${suffix}`);
  mkdirSync(join(tmpdir(), "ash-confine"), { recursive: true });
  writeFileSync(file, "1");
  const old = (Date.now() - 48 * 3600_000) / 1000;  // 两天前:过得了那道一天的门
  utimesSync(file, old, old);
  return file;
}

export const staleCredential = IS_WIN ? plantStaleCredential("ready") : null;
