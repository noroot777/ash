// **只有 pid 时的击杀** —— 重启后接管的 agent 走这条路。
//
// 从 kill.ts 搬出来的理由跟那一摊里其它几层一样:那份文件贴着 700 行上限,而这一摊是一个
// 自洽的概念 —— 手里**没有 ChildProcess 句柄**(它随上一个 server 进程一起没了,追踪 fd 的
// WeakMap 也没了),所以能用的证据、能发的刀跟 `killChild` 那条路完全不是一套。
//
// 依赖方向照旧是单向的:它只用 platform / proc / 哨兵那边共用的身份判据,不反过来被 kill.ts
// 以外的人依赖。使用方照旧 `import { killByPid } from "./kill.js"`(那边原样转出去)。
import { execFileSync } from "node:child_process";
import { IS_WINDOWS, killTree } from "../platform.js";
import { processGroupMembersSync } from "../process-generation.js";
import { canShoot, killProvenUnit, reclaimState } from "../monitor-reclaim-evidence.js";
import { signalMembers } from "./escapees.js";

// 只有 pid 时的击杀(重启后接管的 agent 走这条 —— ChildProcess 句柄随上一个
// server 进程一起没了,追踪 fd 的 WeakMap 也没了)。
// 只剩三层里的第①③层:进程组信号 + 2s 后补 SIGKILL。第②层(继承 fd 反查逃逸者)
// 做不到,因为那份映射是内存态的。代价:重启前就已经逃出进程组的孤儿杀不到 ——
// 如实记在这里,别让以后的人以为这条路和 killChild 等价。
export function killByPid(
  pid: number,
  startedAt?: string | null,
  proof?: { unitToken?: string | null; outPath?: string | null },
): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const unit = { unitToken: proof?.unitToken ?? null };
  // ① 记号那一问。判档这一次只为分流;**下刀本身不吃这份快照** —— killProvenUnit 自己
  // `fresh` 取证,授权不跨出它那个同步段(理由见那边第 13/14 轮审查那几段注释)。
  const state = reclaimState(pid, startedAt ?? null, unit);
  if (canShoot(state)) {
    killProvenUnit(pid, startedAt ?? null, unit);
    return;
  }
  // ①' **明确的反证不许被后面任何一条弱证据洗掉**(第 3 轮审查 F1 实测)。
  //
  // 那七档不是一个梯度,是两类:`not-ours` 是**正面反证** —— ps 答出来了,这个号上现在是
  // 另一个进程(启动时刻确实对不上,locale 差异由 `processIdentity` 在同一份快照上兜住)。
  // 其余几档是「这一问没答出来」。上一版把两类一视同仁地落进下面那个后备分支,于是
  // 「已经证明它不是我们的」被一条「它打开过我们的输出文件」顶掉,`killTree` 往它那一组
  // 发了信号 —— 审查用真实只读查看器实测:记录指向旧代、这个号上已经是查看器,查看器收到
  // SIGTERM 死掉了。
  //
  // 为什么输出文件那条线索在这里不能当反驳:它最多证明「这个进程握着这个文件」,而我们要
  // 回答的是「这个号上的进程是不是当初那一个」—— 后者 ps 已经明确答了「不是」。一条更弱的
  // 证据推不翻一条更强的反证,何况下刀打的是**它那一组**。
  if (state === "not-ours") {
    console.warn(
      `[ash] pid=${pid} 这个号上现在是另一个进程(记录在案的启动时刻对不上),`
      + "按「证不出就不下刀」处理:没有发送任何信号 —— 握着输出文件也不改变这个结论",
    );
    return;
  }
  // ② 记号证不出来(最常见的是这一行建在记号上线之前,库里只有 pid)。POSIX 的秒级启动
  // 时刻是粗档,单凭它下刀就是在赌一次秒级碰撞 —— 那是明确实测过的误杀。
  //
  // 但 agent 这一侧还有一条哨兵没有的线索:这一次运行独有的输出文件。根进程的 stdout 就
  // 重定向在它上面,路径里带着 sessionId + 回合起点,别的运行不会碰它,而且它跟记号一样
  // 跨得过 server 重启(`sessions.agent_out_path`)。它读的是 `lsof` 的**真实 fd 表**,
  // 不是 macOS 上那种无边界的展示文本 ⇒ 精确可答,够当粗档要的那第二份独立证据。
  //
  // **但它只是「第二份证据」,不是「反证的解药」**:上面 ①' 已经把 `not-ours` 挡在外面了。
  // 这一档要的是「身份这一问没答出来」时的补充,不是「身份这一问答了不是」时的推翻。
  //
  // 而且判据收得很紧(`outPathProvesRoot`):**fd 1 且写模式**,也就是「这个进程的标准输出
  // 就是这个文件」。光「打开过这个文件」不算 —— 用户 tail 日志也打开过它(第 3 轮审查 F1)。
  // 它只证明得了**根**(fd 1 无条件继承,但 CLI 会把它自己子进程的 stdout 接成管道),
  // 而这条路要的恰好就是根:下刀打的是根的进程组。
  if (outPathProvesRoot(pid, proof?.outPath ?? null)) {
    // **第一刀之前把组成员连代次一起记下来** —— 就在根仍被证明着的这一刻。少了这一步,
    // 「外层壳吃了 TERM 老实退场、它派生的那个忽略 TERM 的东西还留在原组里」这个现场就
    // 收不干净:根一死,组号成了空号,两秒后那一刀打在空组上(ESRCH),而那个进程还在写文件。
    // 结构跟 killProvenUnit 一致(它对记号那一档做的是同一件事)。
    const held = processGroupMembersSync(pid) ?? [];
    killTree(pid, "SIGTERM");
    const t = setTimeout(() => {
      // 补刀前**重新取一次同一份证据**:这两秒里根可能已经退了、号可能被接手。
      // 以前这一刀是无条件的 —— 哨兵那边的注释早就点过这个毛病。
      //
      // ①' 那条反证在这里**一样压过输出文件**(第 3 轮审查 F1:首刀与补刀是两个对称消费点,
      // 不许只有一个认这条反证):这两秒里 ps 可能已经答得出「这个号上现在是另一个进程」,
      // 那一刻即便文件那一问还说得通,也只说明有人握着这个文件,不说明这个号还是当初那个。
      if (reclaimState(pid, startedAt ?? null, unit) === "not-ours") {
        console.warn(`[ash] pid=${pid} 在这两秒里换了主人(记录在案的启动时刻对不上),补刀取消`);
        signalMembers(held.filter((m) => m.pid !== pid), "SIGKILL");
        return;
      }
      if (outPathProvesRoot(pid, proof?.outPath ?? null)) killTree(pid, "SIGKILL");
      // 再把第一刀那会儿记下的成员补上:**代次没变才打**(变了就是号换了主人)。
      // 这一下不要求根现在还活着 —— 第一刀本来就是来结束它的。
      signalMembers(held.filter((m) => m.pid !== pid), "SIGKILL");
    }, 2000);
    (t as { unref?: () => void }).unref?.();
    return;
  }
  // ③ 两条线索都证不出来:不下刀,但要留下痕迹 —— 根约定「停止/暂停必须留下持久可见的
  // 状态」,静默失败会让用户只能得出「按钮坏了」。
  console.warn(
    `[ash] 没能证明 pid=${pid} 属于这一次运行(身份这一问停在 ${state}、`
    + `输出文件${proof?.outPath ? "上没有它的 stdout" : "未提供"}),`
    + "按「证不出就不下刀」处理:没有发送任何信号",
  );
}

/**
 * **这个号此刻还握着这一次运行的输出文件吗** —— 粗档 pid 要的那第二份独立证据。
 *
 * 同步实现是刻意的:取证与下刀必须在同一个同步段里完成,中间隔一次 `await`,这个号就可能
 * 已经退出并被别人接手(那是哨兵第 13/14 轮审查反复实测的同一条缝)。单文件 `lsof` 比那边
 * 的全表 `ps` 便宜得多。
 *
 * 三档里只有「确证握着」返回 true:问不出来(lsof 不在、报错)一律当证不出 —— 这一问是用来
 * **授权破坏性操作**的,不许让一次失败的查询变成放行票。
 */
function outPathProvesRoot(pid: number, outPath: string | null): boolean {
  if (!outPath || IS_WINDOWS) return false;       // win32 没有 lsof;那边 pid 时刻本来就是排他档
  try {
    const out = execFileSync("lsof", ["-F", "pfan", "--", outPath], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
    });
    // **要的不是「它打开过这个文件」,是「它的 stdout 就是这个文件」**(第 3 轮审查 F1)。
    // 上一版只比号码,于是只读打开同一个日志的查看器也拿到了整组击杀的授权。fd 1 + 写模式
    // 才等价于「这个进程的标准输出重定向在这一次运行的输出文件上」—— 那正是根的形状,
    // 而看客拿到的是另一个 fd、只读。
    let cur = 0, fd: number | null = null;
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const tag = line[0], value = line.slice(1);
      if (tag === "p") { cur = Number(value) || 0; fd = null; continue; }
      if (tag === "f") { fd = Number.isInteger(Number(value)) ? Number(value) : null; continue; }
      if (tag === "a" && cur === pid && fd === 1 && /[wu]/.test(value)) return true;
    }
    return false;
  } catch {
    return false;                                 // 非零退出(无匹配)与查询失败都不算证明
  }
}
