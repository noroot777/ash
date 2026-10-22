// **内核圈定**:「这一次运行产生了哪些进程」交给内核维护成一个确定集合。
//
// 这是**新增的一台设备**,不替换任何既有的那套。既有的四类线索都是**事后推断**:进程表
// 快照的父子边、启动时刻代号、继承的追踪 fd、环境里的资源记号。每一条都有「这一刻问不
// 出来」这一档 —— 父边问不出来、代次核验不了、后代自己 close 掉 fd、`env -i` 洗掉记号。
// 于是「我有没有未清理的责任」必须把历史上见过的每一个身份都背着走,而每一次传递都是一个
// 可能漏的地方(那条链上十一轮审查,每一轮的阻塞项都是同一条判据错误的新位置)。
//
// 已知**在那套设备下无解**的那一种:收尾窗口里新起、同时 `env -i` + close 掉继承 fd +
// `setsid` 的后代 —— 三条线索全断,跟一个陌生进程读不出任何差别。内核圈定解掉的正是这一类:
// 进程属不属于这个集合由内核记着,**不存在「问不出来」这一档**,也洗不掉:
//
//   | 线索          | env -i | close fd | setsid | 跨 server 重启 |
//   |---------------|--------|----------|--------|----------------|
//   | 资源记号      | **断** | 在       | 在     | 在(落库)     |
//   | 追踪 fd       | 在     | **断**   | 在     | 断(内存态)   |
//   | ppid 树       | 在     | 在       | **断** | 在             |
//   | **内核圈定**  | **在** | **在**   | **在** | 在(圈号即路径)|
//
// ── 三个平台的能力并不对等,这里如实分档 ──────────────────────────────────────
//
//  · **Linux**:cgroup v2。在**自己这个 cgroup 之下**建一个子 cgroup,把根的号写进
//    `cgroup.procs`;此后它 fork 出来的一切都继承这个归属,`cgroup.procs` 的内容就是那个
//    确定集合,`cgroup.kill` 是一次原子的整圈击杀(内核 ≥5.14)。详见本文件下半。
//  · **Windows**:Job Object。**必须有一个进程一直握着句柄** —— 实测(2026-10-22,真机
//    192.168.1.187):`CreateJobObject` + `Assign` 之后把句柄全关掉,成员进程还活着,可那个
//    名字当场就查不回来了(`OpenJobObject` → ERROR_FILE_NOT_FOUND)。所以那边要一个守圈的
//    旁进程,代价与实测数据见 confine-job.ts 顶部。
//  · **macOS**:**没有等价物**。没有 cgroup、没有 Job Object,`launchd` 的域不能按运行切分。
//    这台设备在这个平台上**如实弃权**(`openConfinement()` 返回 null),清理判据一个字不变,
//    仍然是进程组 + reparent 兜底那一套。**不许让 macOS 的使用者以为自己有 Linux 那一档的
//    保证** —— 披露面那句话由 `confineAbstention()` 给出。
//
// ── 答得出来时压过别的设备,答不出来时退回原路 ────────────────────────────────
//
// 判定那一摊(cleanup-result.ts 的四档答案、两个问、`dischargeOpen` 的核销语义)一个字都
// 没改。这台设备只是**在它答得出来的时候先说话**,规则写在 `confinedResidue()` 里:
//  · 集合非空 ⇒ `remaining`,成员按号点名(**这是整条链上最硬的归属证明**:内核记着的);
//  · 集合空 + 圈住了整段运行 ⇒ 走 `sweptClean(open)`(**责任清单照旧要核销**,见下);
//  · 集合空、但只圈住了「圈定之后」那一段 ⇒ **不说话**,原样退回既有那套;
//  · 读不出来 ⇒ `unknown`(这一次查询失败,下一轮还问得出来);
//  · 压根没圈(平台弃权、建圈失败)⇒ **不说话**。
//
// **为什么「集合空」也仍然要过 `sweptClean`**:核销判据(`dischargeOpen`)是别人家的不变量,
// 这台设备再权威也不去放松它。一个已经被别的设备点过名、此刻还活着的号,内核圈定可以推出
// 「它不在我这个集合里 ⇒ 它不是这次运行的」—— 但那是**改核销判据**,不在本次改动的范围内
// (约束原话:`dischargeOpen` 的语义不要改)。所以名单上还剩一条,这里照样降成 `unknown`。
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { IS_MAC, IS_WINDOWS, killOne } from "../platform.js";
import { processGenerationSync } from "../process-generation.js";
import { openJobConfinement, reopenJobConfinement } from "./confine-job.js";

/**
 * 圈里的一个成员:号 + **读到这个事实时它是哪一代**。
 *
 * `gen` 为 null = 这一刻代次读不出来(成员刚退出、或这个平台问不出来)。它跟
 * `CleanupOpen.gen` 同形,所以点名之后的核销走的还是 `dischargeOpen` 那一份。
 */
export type ConfineMember = { pid: number; gen: string | null };

/**
 * 这个圈**罩住了这次运行的哪一段**。它决定「集合空」这句话能不能压过别的设备。
 *
 * · `whole-run`   —— 圈定在**目标程序的第一条指令之前**就完成了(shell 先把自己写进
 *   `cgroup.procs` 再 `exec`),所以这次运行产生的每一个进程都必然进过这个集合。
 * · `since-enroll` —— 圈定发生在 `spawn` 返回**之后**(父进程这一侧写号、Windows 那边
 *   守圈进程起来之后 assign)。fork 到那一笔写入之间有一个窗口,窗口里出生又立刻脱离的
 *   后代不会进集合。所以这一档的「空」**不构成证明**,只有「非空」算。
 */
export type ConfineCoverage = "whole-run" | "since-enroll";

/** 这台设备这一次的读数。三档的处置见本文件顶部那段。 */
export type ConfineRead =
  | { kind: "members"; members: ConfineMember[]; coverage: ConfineCoverage }
  | { kind: "unqueryable"; why: string }
  | { kind: "absent"; why: string };

/**
 * **`exec` 之前就把自己圈进去**的那一句。调用方把它拼在自己那段 shell 脚本的最前面、
 * 并把 `env` 里那一项带上 —— 于是圈定发生在目标程序被 fork 出来**之前**,这次运行产生的
 * 每一个进程都必然进过集合(coverage 从此是 `whole-run`,见 `ConfineCoverage`)。
 *
 * 写失败一律吞掉(`2>/dev/null`):圈定是**加一台设备**,不该让它把一次正常的运行弄挂。
 * 代价如实记下:那种情形下 coverage 的声称会偏乐观 —— 而圈是本进程 `mkdir` 出来的、
 * 整段运行期间唯一撤它的地方是判空成功之后那句 `dispose()`,所以这一句写失败只可能是
 * 盘/内核层面的异常,不是正常路径。
 *
 * **它是一条命令,不含任何结尾分隔符** —— 分隔符一律由拼它的那一侧写。原先这个常量
 * 自带 `;`,而 FIFO 那条路是把各句 `join("; ")` 起来的,于是拼出 `;;`:`sh` 当场语法
 * 错误、CLI 一条指令都没执行(`test:detached` 当场变红)。所以名字也从 `..._PREFIX`
 * 换成了 `..._CMD`:它不是「可以直接贴上去的前缀」,是「要自己接分隔符的一条命令」。
 */
export const CONFINE_ENROLL_CMD =
  'test -n "$ASH_CONFINE_PROCS" && echo $$ >"$ASH_CONFINE_PROCS" 2>/dev/null';

/** `CONFINE_ENROLL_CMD` 认的那一项环境变量。 */
export const CONFINE_PROCS_ENV = "ASH_CONFINE_PROCS";

export type Confinement = {
  /**
   * **圈号**:Linux 是 cgroup 相对挂载点的路径,Windows 是 Job Object 的名字。
   * 它跨得过 server 重启(路径/名字本身就是身份),所以落库之后清扫侧能原样把圈打开。
   */
  readonly id: string;
  /**
   * 把这个号圈进来 —— 它此后 fork 的一切都继承这个归属。返回 false = 没圈住
   * (调用方据此知道这台设备这一次弃权)。幂等:同一个号写两遍是空操作。
   */
  enroll(pid: number): boolean;
  /**
   * **shell 侧的 `exec` 前圈定**要的那一项环境变量(见 `CONFINE_ENROLL_CMD`)。
   * 调用它就等于声明「我会在目标程序跑起来之前执行那一句」,于是这个圈的 coverage 升到
   * `whole-run`。`null` = 这个平台没有这条路(Windows)。
   */
  preExecEnv(): Record<string, string> | null;
  /** 这一刻的成员集合。 */
  read(): ConfineRead;
  /** 整圈下刀。返回这一刀发给了几个号(-1 = 这一刀自己没发出去)。 */
  killAll(sig: NodeJS.Signals): number;
  /** 圈空了就把圈撤掉。**没空不撤** —— 它还是这次运行唯一的权威身份。 */
  dispose(): void;
};

/**
 * 这台设备在**这台机器**上弃权的理由(给披露面用)。`null` = 没弃权。
 *
 * 为什么要把它单独摆出来:macOS 上这台设备压根不存在,而「不存在」和「存在且答了空」在
 * 披露面上必须看得出区别 —— 否则那个平台的使用者会以为自己也有内核那一档的保证。
 */
export function confineAbstention(): string | null {
  if (!confineEnabled()) return `${CONFINE_OFF_ENV}=0:内核圈定这台设备被显式关掉了`;
  if (IS_MAC) {
    return "这台机器(macOS)没有内核圈定的等价物:没有 cgroup、没有 Job Object,"
      + "进程归属只能靠进程组 + reparent 兜底那几台设备推断";
  }
  if (IS_WINDOWS) return null;
  const mount = cgroupMount();
  if (!mount) return "这台机器上找不到可用的 cgroup v2 挂载点,内核圈定这台设备不可用";
  // **挂载点在不等于建得出来**:判据只有一条「自己这个 cgroup 的目录可不可写」,而它只有
  // 试一次才知道(理由见下面那段降级)。所以这里真去建一个丢掉的目录 —— 两个系统调用,
  // 换来的是「弃权就一定说得出为什么」这条能被回归钉住的不变量。
  const probe = probeCgroupWritable(mount);
  return probe
    ? `这台机器上建不出 cgroup(${probe}):ash 自己这个 cgroup 的目录不可写 —— `
      + "常见于从 ssh 登录会话直接起的 ash(那个 scope 归 root);"
      + "要拿到这台设备得让 ash 跑在一个被 delegate 的 scope 里(systemd-run --user --scope)"
    : null;
}

/**
 * **显式关掉这台设备**的开关(`ASH_KERNEL_CONFINE=0`)。
 *
 * 两个用处,都不是「配置项」:回归要能在**同一台机器上**跑「有这台设备」和「没有这台设备」
 * 两遍,证明「答不出来就退回原路」这条真的走得通(`test:kernel-confine` 第 5 组);真出了
 * 问题时它也是一条退路 —— 关掉只是少一台设备,判定原样退回既有那套,不会放松任何判据。
 */
const CONFINE_OFF_ENV = "ASH_KERNEL_CONFINE";
const confineEnabled = (): boolean => process.env[CONFINE_OFF_ENV] !== "0";

/** `null` = 建得出来(已经删掉);非 null = 建不出来的那个 errno。 */
function probeCgroupWritable(mount: string): string | null {
  const own = ownCgroup();
  if (!own) return "ENOENT";
  const dir = join(mount, `.${own === "/" ? "" : own}`, `ash-confine-probe-${process.pid}`);
  try {
    mkdirSync(dir);
  } catch (error) {
    return describe(error);
  }
  try { rmdirSync(dir); } catch { /* 建出来了就够了 */ }
  return null;
}

/**
 * 给这一次运行建一个圈。`null` = 这台机器/这个环境下建不出来 ⇒ **这台设备弃权**,
 * 判定原样退回既有那套(退回这条路由 `test:kernel-confine` 的「弃权 ⇒ 退回原路」钉住)。
 *
 * `token` 就是这一次运行的资源记号(`unit-token.ts`):两条线索共用一个身份,落库和对账
 * 都少一个要对齐的东西。
 */
export function openConfinement(token: string): Confinement | null {
  if (!confineEnabled()) return null;
  if (IS_WINDOWS) return openJobConfinement(token);
  return openCgroupConfinement(token);
}

/**
 * 按圈号把一个**已经存在**的圈打开(重启后的清扫路径用:圈号落在库里,句柄不在)。
 *
 * `null` = 这个圈号在这台机器上打不开(平台不对、圈已经撤掉)。注意「打不开」跟「空」是
 * 两件事,所以这里不替调用方把它读成空 —— 读数由 `read()` 给。
 */
export function reopenConfinement(id: string): Confinement | null {
  if (!confineEnabled()) return null;
  if (IS_WINDOWS) return reopenJobConfinement(id);
  const mount = cgroupMount();
  if (!mount || !id.startsWith("/")) return null;
  const dir = join(mount, `.${id}`);
  return existsSync(dir) ? cgroupConfinement(id, dir) : null;
}

// ── 句柄这一侧的登记:跟 unit-token.ts 的记号/输出文件同一个套路 ──────────────
//
// 为什么也用 WeakMap 挂在 ChildProcess 上:击杀与清理路径手里只有那个句柄,而这三条线索
// (记号、输出文件、圈号)要在同一个地方取得到。合成句柄/接回句柄与真进程成对出厂时一起
// 过户(`shareConfinement`),否则 detached 那条路上清理侧拿到的是另一个对象、取不到圈。
const confinements = new WeakMap<ChildProcess, Confinement>();

export function registerConfinement(child: ChildProcess, confine: Confinement | null): void {
  if (confine) confinements.set(child, confine);
}

/** 合成句柄与真进程是同一个进程,圈也是同一个。 */
export function shareConfinement(source: ChildProcess, target: ChildProcess): void {
  const confine = confinements.get(source);
  if (confine) confinements.set(target, confine);
}

/** `null` = 这一次运行没有圈(平台弃权、建圈失败、或者老会话接回来的句柄)。 */
export const confinementOf = (child: ChildProcess): Confinement | null =>
  confinements.get(child) ?? null;

// ── Linux:cgroup v2 ──────────────────────────────────────────────────────────
//
// 机制只用到 cgroup v2 最基础的那一层:**不需要任何 controller、不需要 systemd**。
//  · 建圈 = 在自己这个 cgroup 下 `mkdir`;
//  · 圈定 = 把号写进 `cgroup.procs`(此后 fork 出来的一切都继承);
//  · 枚举 = 读 `cgroup.procs`(**要递归**,见 `cgroupMembers`);
//  · 击杀 = 写 `cgroup.kill`(内核 ≥5.14,一次原子地带走整棵子树);
//  · 撤圈 = `rmdir`(只有空圈删得掉,所以它本身也是一次内核权威的「空」证明)。
//
// ── 降级:什么时候建不出来 ───────────────────────────────────────────────────
//
// 判据只有一条:**自己这个 cgroup 的目录可不可写**。写不了就弃权,不去别处找地方 ——
// 这不是保守,是内核规则:cgroup v2 的 delegation containment 要求「迁移一个进程时,写的人
// 必须对**源与目标的共同祖先**的 `cgroup.procs` 有写权限」。所以:
//
//  · ash 跑在 systemd 的 **user scope / user service** 里(`user@<uid>.service` 整棵子树归
//    用户)⇒ 自己的目录可写、共同祖先也在自己子树里 ⇒ **可用**(2026-10-22 在 Ubuntu 24.04
//    aarch64 实测:`systemd-run --user --scope` 里 mkdir/迁移/`cgroup.kill`/rmdir 全通);
//  · 容器里(root + 私有 cgroup 命名空间)⇒ `/sys/fs/cgroup` 就是自己这一层 ⇒ **可用**;
//  · ash 从 **ssh 登录会话**里起(`session-N.scope`,root 所有)⇒ mkdir 当场 EACCES ⇒ 弃权。
//    这一档**不能**靠「改去 `user@<uid>.service` 下面建」绕过去:目录建得出来,可把进程从
//    `session-N.scope` 迁进去时共同祖先是 root 所有的 `user-<uid>.slice`,写入 EACCES
//    (同日实测:`MKDIR_USERAT_OK` 紧跟着 `MIGRATE_FAIL: Permission denied`)。真要在那种
//    部署下拿到这台设备,得让 ash 自己跑在一个被 delegate 的 scope 里(`systemd-run --user
//    --scope`),那是部署方式的选择,代码这一侧只能如实弃权。
const CGROUP_MOUNTS = ["/sys/fs/cgroup", "/sys/fs/cgroup/unified"];

/** cgroup v2 的挂载点。判据是 `cgroup.controllers` 这个文件 —— 只有 v2 有它。 */
function cgroupMount(): string | null {
  if (IS_WINDOWS || IS_MAC) return null;
  for (const mount of CGROUP_MOUNTS) {
    try {
      if (existsSync(join(mount, "cgroup.controllers"))) return mount;
    } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * **自己这一刻在哪个 cgroup 里**(相对挂载点的路径,根是 `/`)。
 *
 * `/proc/self/cgroup` 的 v2 行形如 `0::/user.slice/....scope`。在 cgroup 命名空间里它给的是
 * **命名空间相对**的路径(容器里就是 `0::/`),而 `/sys/fs/cgroup` 正是那个命名空间的根 ——
 * 两者同一个坐标系,拼起来就是真实目录。
 */
function ownCgroup(): string | null {
  try {
    for (const line of readFileSync("/proc/self/cgroup", "utf8").split("\n")) {
      if (line.startsWith("0::")) return line.slice(3).trim() || "/";
    }
  } catch { /* 读不到就是没有 */ }
  return null;
}

function openCgroupConfinement(token: string): Confinement | null {
  const mount = cgroupMount();
  const own = ownCgroup();
  if (!mount || !own) return null;
  const id = `${own === "/" ? "" : own}/${cgroupName(token)}`;
  const dir = join(mount, `.${id}`);
  try {
    mkdirSync(dir);
  } catch (error) {
    // EACCES = 这个部署形态下没有可写的 cgroup(见上面那段降级),EEXIST 几乎不可能
    // (名字带着随机记号)。两种都只有一个处置:**弃权**,让判定退回既有那套。
    console.warn(`[ash] 内核圈定这台设备弃权:建不出 cgroup ${dir}(${describe(error)})`);
    return null;
  }
  sweepStaleCgroups(join(mount, `.${own}`), basename(dir));
  return cgroupConfinement(id, dir);
}

/**
 * 把**早就过期的**空圈扫掉。`dispose()` 只在判空成功那一刻发生,所以判定落在 remaining/
 * unknown 的那些运行,以及 server 被硬杀掉的那些,会把空目录留在 cgroup 树上一直攒。
 *
 * 安全性靠两道:`rmdir` 对**非空** cgroup 必然失败(还有成员的圈一个都删不掉),外加一天的
 * 年龄门(一个回合再长也到不了那儿)。删早了也只会让那个圈的读数退成弃权,不会误判成
 * 「收干净了」—— 判空那一侧要的是「名字在、集合空」,名字没了一律当弃权。
 */
function sweepStaleCgroups(parent: string, keep: string): void {
  const cutoff = Date.now() - 24 * 3600_000;
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;                                         // 父目录读不了:不是我们该管的事
  }
  for (const name of names) {
    if (name === keep || !name.startsWith("ash-agent-")) continue;
    const dir = join(parent, name);
    try {
      if (!statSync(dir).isDirectory() || statSync(dir).mtimeMs >= cutoff) continue;
    } catch {
      continue;
    }
    removeCgroupTree(dir);                          // 深度优先 rmdir:非空的那些自己会失败
  }
}

/** cgroup 目录名。记号本身只含 `[a-z0-9-]`,这里仍然兜一道:路径分隔符进不去。 */
const cgroupName = (token: string): string =>
  `ash-agent-${token.replace(/[^A-Za-z0-9._-]/g, "_")}`;

function cgroupConfinement(id: string, dir: string): Confinement {
  // **默认是保守的那一档**。只有调用方取过 `preExecEnv()`(= 它会在目标程序被 fork 出来
  // 之前把自己写进 `cgroup.procs`)才升到 `whole-run`:detached 那两条路是这样的,管道
  // 那条路只有父进程这一侧写得了号。重新打开的圈不知道当初是怎么圈的,一律保守档。
  let coverage: ConfineCoverage = "since-enroll";
  let enrolledByParent = false;
  return {
    id,
    enroll(pid: number): boolean {
      if (!Number.isInteger(pid) || pid <= 1) return false;
      try {
        writeFileSync(join(dir, "cgroup.procs"), String(pid));
        enrolledByParent = true;
        return true;
      } catch (error) {
        // 两种都归到同一个处置:这个号没圈住。**但不改 coverage** —— shell 那一侧可能
        // 已经把自己写进去了(进程已经退出的话这里写必然失败,而它当初确实进过集合)。
        if (!enrolledByParent) {
          console.warn(`[ash] 内核圈定:${pid} 没能写进 ${id}(${describe(error)})`);
        }
        return false;
      }
    },
    preExecEnv(): Record<string, string> {
      coverage = "whole-run";
      return { [CONFINE_PROCS_ENV]: join(dir, "cgroup.procs") };
    },
    read(): ConfineRead {
      if (!existsSync(dir)) {
        return { kind: "absent", why: `cgroup ${id} 已经不在了(撤过圈,或者从来没建起来)` };
      }
      const members = cgroupMembers(dir);
      if (!members) return { kind: "unqueryable", why: `cgroup ${id} 这一刻读不出成员` };
      return { kind: "members", members, coverage };
    },
    killAll(sig: NodeJS.Signals): number {
      // SIGKILL 走 `cgroup.kill`:**一次写入带走整棵子树**,而且没有「读到号→发信号」之间
      // 那条号被复用的缝(内核自己按成员关系下刀)。这是整条链上唯一一个没有竞态的击杀。
      if (sig === "SIGKILL") {
        try {
          writeFileSync(join(dir, "cgroup.kill"), "1");
          return 1;
        } catch { /* 内核 <5.14 没这个文件,退回逐个发 */ }
      }
      const members = cgroupMembers(dir);
      if (!members) return -1;
      let sent = 0;
      for (const m of members) {
        // 自己和 1 号永远不碰。**归属已经由内核证明**,所以这里不再核一遍代次 —— 唯一的
        // 缝是「读到号」与「发信号」之间那个号退出又被复用,那是 POSIX 上所有按号发信号的
        // 路径共有的窗口(`cgroup.kill` 那条路连这个窗口都没有)。
        if (m.pid === process.pid || m.pid <= 1) continue;
        killOne(m.pid, sig);
        sent += 1;
      }
      return sent;
    },
    dispose(): void {
      removeCgroupTree(dir);
    },
  };
}

/**
 * 圈里的成员。**必须递归**:圈是我们自己的子树,里面的进程有权在自己这一层再 `mkdir` 建
 * 子 cgroup 并把自己迁进去(共同祖先就在我们这个圈里,delegation containment 允许)。只读
 * 最上面那一层的 `cgroup.procs`,就会把「往下躲了一层」的后代当成不存在。
 *
 * `null` = 这一次读不出来(目录还在但读失败)⇒ 由调用方记成 `unqueryable`,不是空。
 *
 * 代次是**另一次读**取的(`/proc/<pid>/stat`):成员关系来自内核的集合、代次来自那个号的
 * stat,两者之间那个号可能刚好退出 ⇒ 代次为 null ⇒ 点名之后只能等它退出才核销掉。宁可这样
 * 也不要反过来(拿一个读不准的代次去核销一份真责任)。
 */
function cgroupMembers(dir: string): ConfineMember[] | null {
  const pids = new Set<number>();
  const walk = (at: string): boolean => {
    let raw: string;
    try {
      raw = readFileSync(join(at, "cgroup.procs"), "utf8");
    } catch {
      // 子 cgroup 在我们读它的这一刻被撤掉(里面的进程退干净了)是正常的,不算读失败。
      if (!existsSync(at)) return true;
      return false;
    }
    for (const line of raw.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 1) pids.add(pid);
    }
    let entries: string[];
    try {
      entries = readdirSync(at);
    } catch {
      return !existsSync(at);
    }
    for (const name of entries) {
      const child = join(at, name);
      if (!existsSync(join(child, "cgroup.procs"))) continue;   // 只有子 cgroup 才有这个文件
      if (!walk(child)) return false;
    }
    return true;
  };
  if (!walk(dir)) return null;
  return [...pids].map((pid) => ({ pid, gen: processGenerationSync(pid) }));
}

/** 自底向上撤圈。非空的那一层删不掉(内核拒绝),如实留着 —— 它还是唯一的权威身份。 */
function removeCgroupTree(dir: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const child = join(dir, name);
    if (existsSync(join(child, "cgroup.procs"))) removeCgroupTree(child);
  }
  try {
    rmdirSync(dir);
  } catch { /* 还有成员 ⇒ 删不掉,这正是该留着的时候 */ }
}

export const describeConfineError = (error: unknown): string => describe(error);

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code ?? (error instanceof Error ? error.message : String(error));
}
