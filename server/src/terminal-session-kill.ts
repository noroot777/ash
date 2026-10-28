// 终端会话的**进程侧收尾**:把一条会话名下的进程(组长 + 整组 + 它见过的全部后代)确定性
// 地杀干净,或者如实说杀不净。从 terminal.ts 拆出来的原因有两个:那份文件已经越过项目 700
// 行的上限,而这一段跟会话表、容量、事件缓冲都没有耦合 —— 它只需要「组长 pid、pty 从设备
// 路径、累积的后代 pgid、退出码」这几样事实。
//
// 判据与枚举能力的来龙去脉在 terminal-process-tree.ts 顶部;这里只放「怎么收尾」。
import { IS_WINDOWS } from "./platform.js";
import type { StopFact } from "./terminal-session-facts.js";
import { requestStop } from "./terminal-stop-facts.js";
import {
  descendantsFromTable,
  freezeAndEnumerate,
  groupAlive,
  processAlive,
  readProcessTableSync,
  sessionMemberPidsSync,
  type DescendantSnapshot,
} from "./terminal-process-tree.js";

/**
 * 收尾只需要会话的这几样事实(TerminalSession 结构上满足它,不必互相 import 类型)。
 * `exitCode`/`stop` 是读写的 —— 终止是用户动作,要留在会话事实里。
 */
export type KillTarget = {
  readonly process: { readonly pid: number; kill(signal?: string): void };
  readonly ttyPath: string | null;
  readonly descendantPgids: Set<number>;
  readonly commandId: string | null;
  exitCode: number | null;
  stop: StopFact;
};

export type KillResult = { ok: true } | { ok: false; reason: string };

/**
 * 关掉 tab 那一下的杀法:只发一轮 SIGKILL,清单按「实时 ppid 树 ∪ 会话成员 ∪ 存续期
 * 累积」拼齐。调用方负责把会话从表里摘掉 —— 本函数只管进程。
 *
 * 注意它**不等**进程真的消失,所以「关 tab = 结束会话」不能只走这里:忽略 HUP/TERM 的
 * 后台作业会被 PID 1 收养,而控制把手已经被删掉(第 1 轮自由审查实锤)。那条路要走
 * terminateSession 的确认版。
 */
export function killSessionTree(target: KillTarget): void {
  const table = readProcessTableSync();
  const live = table ? descendantsFromTable(table, target.process.pid) : { pids: [], pgids: [] };
  const members = sessionMemberPidsSync([target.process.pid], target.ttyPath ? [target.ttyPath] : []) ?? [];
  const pids = new Set(live.pids);
  const pgids = new Set([...target.descendantPgids, ...live.pgids]);
  for (const member of members) {
    if (member.pid === target.process.pid) continue;
    pids.add(member.pid);
    if (member.pgid > 1 && member.pgid !== target.process.pid) pgids.add(member.pgid);
  }
  signalSessionTree(target, "SIGKILL", { pids: [...pids], pgids: [...pgids] });
}

/**
 * 停止一个会话的进程但**保留现场**:会话不删、缓冲日志不丢,退出码照常经 onExit 落在会话
 * 上 —— 停止是用户动作,刷新页面后要看得出「我停过」(根 AGENTS.md 的硬要求),所以它和
 * killSessionTree(关掉 tab、连日志一起丢)是两个动词。
 *
 * 杀的是**整个进程组 + 会话见过的全部后代**(pty 子进程 fork 后 setsid,组长就是它自己,
 * dev server 派生的子进程都在组里;交互 shell 的 job control 会把后台作业挪进独立进程组,
 * 靠「存续期累积 + 发信号前实时补抓」两份后代 pgid 覆盖):SIGTERM 给进程收尾的机会,等不到
 * **整组+后代清空**再 SIGKILL 兜底;两轮都压不住(基本只剩 D 状态)就如实返回失败,绝不把
 * 「没杀死」报成「已停」—— 会话还在,UI 可重试。交互会话的内层 shell 另加一发 SIGHUP
 * (它忽略 TERM,只认挂断;理由见下面发信号处),整组的 TERM 收尾宽限不受影响。判定必须
 * 是「组长退了 **且** 组里没人 **且** 已见后代组/进程全消失」:`cmd & wait`(或 shell
 * 先 exit、独立组作业还在)这种形状下只看组长就会漏杀(第 2 轮审查实锤)。双 fork 后
 * 立刻 setsid 逃逸、且从没被任一次扫描抓到的守护进程超出本方法能力 —— 那一类按它自己
 * 打印过的端口来收(service-ports.ts),归属靠环境里的启动记号核验。
 */
export async function terminateSession(
  target: KillTarget,
  timeouts?: { termMs?: number; killMs?: number },
): Promise<KillResult> {
  const groupId = target.process.pid;
  // 成员清单要在**发信号 + 早退判定之前**拿齐,且拿之前先**冻结**(freezeAndEnumerate):
  // 枚举与发信号之间,组内 shell 可能正把新服务 fork 进新 PGID(实测 restart 后立即
  // stop,nohup 服务恰好从快照缝里漏出去、stopped:true 却留下孤儿)。清单三份并集 ——
  // ① ppid 树(leader 活着时完整);② 会话成员(ctty/sid ∪ fd 持有者,disown 离树的
  // 独立组、stdio 全重定向的 nohup 服务都在列);③ 存续期累积的 pgid(leader 已退、
  // ctty 已 revoke 时仅存的线索)。
  //
  // **两轮都要重新冻结枚举**:TERM 轮解冻是必须的(可捕获信号在 stopped 态挂起,得
  // SIGCONT 才递送,进程才有机会收尾),但解冻窗口里进程的 TERM handler 可以再 fork
  // 出新的独立 PGID(第 7 轮审查实锤);所以升级 KILL **之前**再冻结、再枚举到不动点、
  // 更新快照,把 handler 新建的组一并纳管。SIGKILL 不可捕获,冻结态下发它进程没有
  // 再 fork 的机会,这一轮的完整枚举就是终态判定的依据。
  const memberPids = new Set<number>();
  const clearedBy = (snapshot: DescendantSnapshot) => target.exitCode !== null && !groupAlive(groupId)
    && snapshot.pgids.every((pgid) => !groupAlive(pgid))
    && snapshot.pids.every((pid) => !processAlive(pid));

  const term = await freezeAndEnumerate(groupId, target.ttyPath, target.descendantPgids, memberPids);
  if (clearedBy(term.snapshot)) { term.thaw(); return { ok: true }; }
  // 这一行记的是**「用户要求停止」**,不是「已经停净」—— 两件事必须分开:它在 TERM/KILL
  // 之前就落下,后面每一轮都可能失败。「停净了吗」是账上另一档(StopFact 的 verified /
  // unresolved,由停止动作层核验后落:terminal-commands.ts 的 StopVerdict),这一档只决定
  // 措辞(「已停止」而不是「异常退出」)和回收策略。谁要是拿它当「服务已经不在了」的证据,
  // 就会得出「我点过停止 ⇒ 它停了」(第 2 轮审查发现 2)。已经有核验结论时不覆盖它。
  requestStop(target);
  signalSessionTree(target, "SIGTERM", term.snapshot);
  // 交互 shell 只认挂断:zsh/bash 按 POSIX 惯例**忽略 SIGTERM**(交互模式下),于是
  // 「关 tab」的 TERM 轮必然空等满 termMs 才升级 KILL —— 实测一个什么都没跑的空闲 tab
  // 也要 3.5s 才关掉,而这 3s 全花在等一个约定好不会发生的事件上(leader 自己也 trap 了
  // TERM,成功判定的第一条却是 leader 的 exitCode 落地)。关 tab 的正确语义本来就是
  // **终端挂断**,对应 SIGHUP:shell 收到即退出、并按自己的规矩通知作业(nohup/disown
  // 的不动),wrapper 随后确定性清杀余党,TERM 轮在几百毫秒内自然满足退出条件。
  // 只发给 leader 的直接子进程(那个内层 shell),不广播到整组:组里的服务/前台作业
  // 该拿的仍是 TERM 那份**完整**收尾宽限,一秒都不缩短(命令会话的 stop 因此完全不受
  // 影响 —— dev server 照旧优雅退出)。leader 自己 trap 了 HUP,shell 转发也杀不到它,
  // tty 不会被提前 revoke,枚举能力全程在线。
  if (target.commandId === null) {
    for (const pid of term.innerShellPids) {
      try { process.kill(pid, "SIGHUP"); } catch { /* 已死 */ }
    }
  }
  term.thaw(); // 解冻:让 TERM handler 收尾(它也可能 fork —— 交给下面的 KILL 轮抓)
  if (await waitForGroupExit(target, timeouts?.termMs ?? 3000, term.snapshot)) return { ok: true };

  // KILL 轮:重新冻结 + 枚举到不动点,纳管 TERM handler 解冻期新建的独立 PGID。
  const kill = await freezeAndEnumerate(groupId, target.ttyPath, target.descendantPgids, memberPids);
  signalSessionTree(target, "SIGKILL", kill.snapshot);
  kill.thaw(); // KILL 已致命,CONT 只为不把万一没死透的留在 stopped(D 状态那种)
  if (await waitForGroupExit(target, timeouts?.killMs ?? 2000, kill.snapshot)) return { ok: true };
  return {
    ok: false,
    reason: target.exitCode === null
      ? "进程连 SIGKILL 都没响应，可能卡在不可中断的系统调用里"
      : "主进程已退出，但它派生的子进程杀不掉，可能卡在不可中断的系统调用里",
  };
}

function signalSessionTree(target: KillTarget, signal: "SIGTERM" | "SIGKILL", descendants?: DescendantSnapshot): void {
  try {
    // Windows 没有进程组信号这一说,交给 node-pty 收 ConPTY —— 它按
    // `GetConsoleProcessList` 把挂在这个伪控制台上的进程全部收掉,交互 shell 与
    // 常用命令同一条路(那边的边界见 terminal.ts register 里 wrapper 那段注释)。
    if (IS_WINDOWS) target.process.kill();
    else process.kill(-target.process.pid, signal);
  } catch {
    // 整组已空(ESRCH):没人可杀,waitForGroupExit 会立刻确认。
    try { target.process.kill(signal); } catch { /* already gone */ }
  }
  // job control 的后台作业在自己的组里,逐组、逐 pid 补刀(清单由调用方按 ppid 树 +
  // 会话成员 + 累积拼出;逐 pid 是兜底 —— 覆盖 setpgid 到快照外新组的边角)。
  for (const pgid of descendants?.pgids ?? []) {
    try { process.kill(-pgid, signal); } catch { /* already gone */ }
  }
  for (const pid of descendants?.pids ?? []) {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

/**
 * 等「组长的 exitCode 落了 **且** 进程组里没有任何存活成员 **且** 快照里的后代
 * 进程/进程组全部消失」;超时返回 false,由调用方决定升级还是报失败。组长先死不算完
 * —— 组号还被子进程占着(kill(-pgid, 0) 探测),job control 的后台作业还占着自己的组。
 */
function waitForGroupExit(target: KillTarget, timeoutMs: number, descendants?: DescendantSnapshot): Promise<boolean> {
  const groupId = target.process.pid;
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const cleared = target.exitCode !== null && !groupAlive(groupId)
        && (descendants?.pgids ?? []).every((pgid) => !groupAlive(pgid))
        && (descendants?.pids ?? []).every((pid) => !processAlive(pid));
      if (cleared) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  });
}

/**
 * 关服那一下的清场:对每条会话**整组 + 后代 pgid** 同步连发 TERM+KILL。必须同步
 * ('exit' 钩子里没有 await),但同步 ps/procfs 是可以的 —— 各一次读全表 / 批量枚举全部
 * 会话的成员,给每条会话就地补实时快照,与存续期累积合并。不能只读累积值:那会漏掉
 * 「起了作业但还没被任何一次扫描记下」的独立组(第 2、3 轮实锤)。
 *
 * 会话成员(全会话并集)最后补刀,封两类:第 4 轮竞态(内层 shell 刚退、wrapper 正在
 * 清杀,这一轮组信号把 wrapper 打断的话,disown 的独立组既不在 ppid 树也不在累积里)和
 * 第 6 轮的 stdio 全重定向 nohup 服务(不持 fd,只有 ctty/sid 能点到名)。
 *
 * 无条件连发,不按 exitCode 筛:组长退了组不一定空(daemonize 形状),而对已空的组发信号
 * 只是 ESRCH —— 少一个条件就少一类漏杀。命令会话跑的是 dev server/watch 这类可随时重启的
 * 进程,强杀可接受;不杀的代价是它们被 PID 1 收养成孤儿,ash 重启后会话表(内存态)清零、
 * UI 显示「未启动」,旧进程却继续占着端口。
 */
export function killAllSessionTrees(targets: KillTarget[]): void {
  const table = readProcessTableSync();
  const members = sessionMemberPidsSync(
    targets.map((target) => target.process.pid),
    targets.map((target) => target.ttyPath).filter((path): path is string => path !== null),
  ) ?? [];
  for (const target of targets) {
    const live = table ? descendantsFromTable(table, target.process.pid) : { pids: [], pgids: [] };
    const descendants: DescendantSnapshot = {
      pids: live.pids,
      pgids: [...new Set([...target.descendantPgids, ...live.pgids])],
    };
    signalSessionTree(target, "SIGTERM", descendants);
    signalSessionTree(target, "SIGKILL", descendants);
  }
  for (const member of members) {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try { process.kill(member.pid, signal); } catch { /* already gone */ }
      if (member.pgid > 1) {
        try { process.kill(-member.pgid, signal); } catch { /* already gone */ }
      }
    }
  }
}
