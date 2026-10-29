// 常用命令那条启动记录的**状态投影层**:会话事实(server/src/terminal.ts 的
// `TerminalSessionInfo`)→「还在跑吗 / 还被 ash 管着吗 / 要不要给用户一个出口 / 旁边那行字
// 怎么写」。从 CommandsLauncher.tsx 拆出来有两个理由:① 弹层头部的 service、行列表、外面
// 那颗 ▶ 三个表面都认这同一份判据,**判据只能有一份**(劈叉的实测后果写在各函数注释里);
// ② 它是纯函数,拆出来才钉得住回归(web/scripts/test-command-session-state.mjs)——
// 原先住在 .tsx 里,node 的类型擦除拉不进来,只能靠通读保证。
import type { TerminalSessionInfo } from "../lib/api.ts";

/**
 * 这条会话名下**还有东西在跑吗** —— 弹层里每一个表面(头部按钮、每行的按钮与状态、外面
 * 那颗 ▶ 亮不亮)都认这一个判据,**与服务端的 sessionRunning 逐字对齐**
 * (server/src/terminal.ts):两边劈叉就会出现「停止按钮摆在那儿、点下去什么都没发生」,
 * 或者反过来「服务还听着端口,界面却摆着启动按钮、再点一次起第二份」。
 *
 * 进程归属(groupAlive:组长退了但后台子进程还在的 daemonize 形状也算)之外多两档:
 * ① **它打印过的端口还有人在听**(而且核实是这次启动起来的) —— 真·守护化的服务
 * (双 fork + setsid)从进程归属里全逃了,端口是仅剩的线索;② **上次停止留下了还活着的号**:
 * 端口让出来了,但同组还有核不上归属、没敢杀的进程,那次启动就还没了结,停止按钮得留在那儿
 * 让用户能再按。
 *
 * **只认活证据**:账上那种「一个号都举不出来」的没核销(端口超额,证据本身不全)不进这一问
 * —— 它永远核销不掉,当成「还在跑」就等于这条命令再也起不动了。那句话由 sessionState 去说。
 */
export const leftoversOf = (session: TerminalSessionInfo): number[] =>
  session.stop.kind === "unresolved" ? session.stop.pids : [];

export const sessionRunning = (session: TerminalSessionInfo): boolean =>
  !session.abandoned
  && (session.running ?? (session.groupAlive || session.portsAlive || session.portUncertain === true || leftoversOf(session).length > 0));

/**
 * 这条启动**此刻还被 ash 管着吗** —— 服务那一行要摆停止还是启动,只问这一个函数。
 *
 * 与服务端 `openSession` 逐字对齐,包括**判据的顺序**:放弃过的那一档排在最前面,后面每一档
 * 都可能回「还开着」,而放弃的全部用途就是解除那几档造成的死局。早先这里是一条
 * `sessionRunning(s) || (stopCommand && 正常退出 && 没被停过)` 的或式:第一支排除了放弃,
 * 第二支没有 —— 于是显式放弃之后界面照旧摆着停止按钮,点下去后端回 `{"stopped":false}`,
 * 刷新还是如此(第 1 轮审查 F3 在真实页面上实测)。所以这一档必须收在**一个**函数里,
 * 而不是在每一处兜底各写一遍。
 *
 * 放弃不抹掉残留事实:那几个端口和 pid 仍由 `sessionState` 的「已放弃管理」与放弃弹层交代。
 */
export const managedOpen = (
  session: TerminalSessionInfo | null,
  stopCommand: string | null | undefined,
): TerminalSessionInfo | null => {
  if (!session || session.abandoned) return null;
  if (sessionRunning(session)) return session;
  // `docker compose up -d` 这类连端口都未必打在本机,用户给的那条停止命令就是仅剩的线索。
  return stopCommand && session.exitCode === 0 && !session.stoppedByUser ? session : null;
};

/**
 * 这条启动**卡死在 ash 管不动的状态**上了吗 —— 那颗「我自己处理了」要不要出现看它。
 *
 * 两种形状:① 端口归属核不上(`portUncertain`):启动认为它还开着、停止永远 502、删项目也
 * 被它拦下,而 ash 手里压根没有能动它的凭据;② 上次停止没能确认停净(`unresolved`):账上
 * 挂着的号同样永远核销不掉。两种都是**悲观判据的终点**,拦着也多停不掉一个进程 ——
 * 必须配一个用户够得着的出口(server/src/terminal-abandon.ts 文件头)。
 *
 * 放弃过的不再显示入口:那时状态文案已经在说「已放弃管理」,点日志还能回看当时那份残留。
 */
export const needsHandoff = (session: TerminalSessionInfo): boolean =>
  !session.abandoned && (session.portUncertain === true || session.stop.kind === "unresolved");

// 同一条命令可能挂着「一条活会话」或「一条刚退出的」——一处只说一件事,活的优先。
export function bestSession(sessions: TerminalSessionInfo[], projectId: string, commandId: string): TerminalSessionInfo | null {
  const mine = sessions.filter((s) => s.projectId === projectId && s.commandId === commandId);
  return mine.find(sessionRunning) ?? mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/**
 * 会话事实 → 状态点/文案。service 头部和普通命令行共用,口径才不会劈叉。
 * text 为 null = **没什么可说**:从没跑过的命令旁边就摆着「执行」按钮、点也是灰的,
 * 再写一句「未启动」是把默认态当事件播报(用户 2026-09-18 点名删掉)。
 *
 * open = 会话已经退了,但我们仍认为服务开着(端口还有人听,或配了停止命令;见 serviceOpen)。
 * 这时说「已退出」是错的 —— 退的是启动脚本,服务在 ash 的进程树之外跑着。
 *
 * service = 这是项目级服务那一行。它正常退出时只说「启动脚本已退出」而不说「已退出」:
 * ash 知道的只有**脚本**退了,服务是不是真停了它并不知道(守护化的服务既没留进程、这次又
 * 没打印端口时,谁也说不准)。普通命令不走这一档 —— `npm run build` 退了就是退了。
 */
export function sessionState(
  session: TerminalSessionInfo | null,
  open = false,
  service = false,
): { tone: string; text: string | null } {
  // 用户显式放弃过:**不说「已停止」**(那是谎报 —— 放弃不杀进程),照实说「我放过手了」。
  // 这一档排在最前面:放弃之后服务端的 running 已经是 false,但这条记录的 stop 账原样留着,
  // 落到下面就会被说成「已停止（没能确认停净）」,把用户自己的决定讲成了 ash 的结论。
  if (session?.abandoned) {
    // 三种说法认的是服务端 residueNotice 的措辞:只剩「分不清是不是这次的」那类时不能说成残留自理。
    const notice = session.abandoned.notice;
    const what = notice.includes("探不到任何残留") ? "当时无残留"
      : notice.includes("没找到能确认是这次启动留下的") ? "有分不清来路的进程，未动" : "残留自理";
    return { tone: "off", text: `已放弃管理（${what}）` };
  }
  if (session && sessionRunning(session)) {
    if (session.portUncertain) return { tone: "err", text: "运行状态待确认（端口归属未核实）" };
    // 监听已经让出来了、只剩几个没能收掉的号:既不是「运行中」也不是「已停止」,照实说第三种
    // (第 2 轮审查发现 2 —— 这一档以前被静默并进「已停止」)。
    // **不在这儿写成因**:账上这几个号有两种来路 —— 核不上归属所以没敢动的,以及核实是这次
    // 起来的、却连 KILL 都没停下来的(第 6 轮审查 F1 之后后者也会进账)。前端只拿到号码,
    // 分不出是哪一种;成因在服务端那句 `why` 里逐个说清,这里只报个数。
    if (!session.groupAlive && !session.portsAlive) {
      return { tone: "on", text: `停止未完成（还剩 ${leftoversOf(session).length} 个进程没能收掉）` };
    }
    return session.exitCode === null
      ? { tone: "on", text: "运行中" }
      : { tone: "on", text: "运行中（启动脚本已退出）" };
  }
  if (session) {
    if (open) return { tone: "on", text: "已启动" };
    // 没有活证据了,但那次停止**没能证明停净**(端口超额:没记下的端口谁都没问过,或者
    // 当时核不上归属的号后来才自己退掉)。「已停止」是谎报,这一句得留着 —— 刷新回来也在
    // (根 AGENTS.md:停止要留下持久可见的状态;第 3 轮审查发现 1:这一档以前一个 PID
    // 都举不出来,于是被整条读成「干净」)。
    if (session.stop.kind === "unresolved") return { tone: "err", text: "已停止（没能确认停净）" };
    // 用户自己点的停止不是异常 —— 哪怕进程死于信号带回非零退出码。
    if (session.stoppedByUser) return { tone: "off", text: "已停止" };
    if (session.exitCode === 0) return { tone: "off", text: service ? "启动脚本已退出" : "已退出" };
    return { tone: "err", text: `已退出（${session.exitCode}）` };
  }
  return { tone: "off", text: null };
}
