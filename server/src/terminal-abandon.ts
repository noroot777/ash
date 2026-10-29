/**
 * 「这次启动的管理责任我自己接手了」—— 一个**显式**出口。
 *
 * 为什么非得有它:归属核不上(`probeOwnedPorts` 回 `unknown`)时整条链路一律悲观,而且每一处
 * 都只读到同一个 `unknown` —— 分不出「这一次没问出来(该重试)」和「这台机器上永远问不出来
 * (对方把环境清空了、或者端口上坐着别的账号的程序)」。于是 `openSession` 认为还开着、两条
 * 停法与 `releaseLaunchResponsibility` 全部拒绝给结论:点启动回 `alreadyRunning`、点停止永远
 * 502、照提示去填一条停止命令再点还是 502、最后连这个项目都删不掉(第 1 轮审查发现 1,
 * `env -i` 洗掉记号的守护进程实测)。**悲观判据必须配一个用户够得着的出口**,否则这条记录
 * 就是一个没有尽头的死局 —— 拦着也多停不掉一个进程。
 *
 * **它不是核销**,三件事严格分开:
 *
 *   ① **不杀、也不宣称停净。** 这次启动停没停净的结论原样留在 `stop` 账上(`unresolved` 不会
 *      被改写成 `verified`),放弃另记一格。刷新回来看得见的是「我放过手 + 当时还有什么活着」,
 *      不是凭空多出来的一句「已停止」。
 *   ② **必须显式确认。** 请求要带上用户当时看到的那条**会话 id**:对不上(期间又起了一份)就
 *      409,不许拿一个旧弹层上的「是」去放过一条新的启动。残留事实(哪个 pid、哪个端口、什么
 *      归属)由 `launchResidue` 现问一遍后交给界面,按下去那一刻**存的就是他看到的那一份快照**。
 *   ③ **解除范围写明白。** 只解除这一条启动记录的删除保护与幂等占位 —— 同项目其它会话不受影响,
 *      这条命令**以后**的启动照旧受全套保护。`scope` 那几句话原样进弹层,用户按之前就读得到。
 */
import type { Hono } from "hono";
import { PORT_TIER_AVAILABLE, probeOwnedPorts } from "./service-ports.js";
import { launchSurvivors } from "./terminal-launch-survivors.js";
import { liveLeftovers } from "./terminal-stop-facts.js";
import { terminalSessions } from "./terminal.js";
import type { LaunchAbandonment, TerminalSessionInfo } from "./terminal-session-facts.js";

/** 放弃之后 ash **不再做**哪几件事。原样进弹层 —— 用户按之前就该读到解除范围。 */
function scopeOf(info: TerminalSessionInfo): string[] {
  return [
    "这条启动记录的删除保护解除：关掉它的日志标签、删掉这个项目都不再被它拦下（只删这条记录，名下的进程 ash 一个都不杀）",
    "启动幂等门不再认它：再点启动会**另起一份**，上面还活着的那些进程不会被顺手收掉",
    "关掉 ash 时不再按它的端口和启动记号去收人，退出交代里也不再提它",
    `只解除「${info.name}」这一次启动（${new Date(info.startedAt).toLocaleString("zh-CN")} 起）——`
      + "同项目其它会话，以及这条命令以后的启动，照旧受全套保护",
  ];
}

/**
 * 残留事实:**现问一遍**,不吃缓存。
 *
 * 三条线索各问各的,一条都不能省:账上没核销的号(`liveLeftovers`)、按启动记号还点到名的号
 * (`launchSurvivors`,双 fork + setsid 之后血缘三条线索全断,只有记号点得到它)、以及这次
 * 启动记下的端口此刻的归属。用户要在「还活着什么」上签字,给他一份残缺的清单等于没给。
 */
export async function launchResidue(info: TerminalSessionInfo): Promise<LaunchAbandonment> {
  const token = terminalSessions.launchTokenOf(info.id);
  const scan = await launchSurvivors(terminalSessions.launchIdentityOf(info.id));
  const taggedPids = scan.pids;
  const probe = info.ports.length && PORT_TIER_AVAILABLE
    ? await probeOwnedPorts(info.ports, token)
    : { state: info.ports.length ? "unavailable" as const : "free" as const, why: null };
  const owedPids = liveLeftovers(info.stop);
  // 两类事实分开说(用户 2026-10-29 选定「停止判据保持诚实」时一并要求):**确定是这次启动
  // 留下的**,和 **ash 分不清是不是这次的**。后者多半是系统自己的后台进程(Spotlight 的索引
  // 进程之类),早先跟前者混成一句「这些残留得你自己处理」,用户看到的就是要他替十几个无关的
  // 系统进程签字。
  const owned: string[] = [];
  const unsure: string[] = [];
  if (taggedPids.length) {
    owned.push(`${pidList(taggedPids)} 还活着（环境里带着这次启动的记号，确凿是它起来的）`);
  }
  const strays = owedPids.filter((pid) => !taggedPids.includes(pid));
  if (strays.length) {
    owned.push(`停止时记下没收掉的 ${pidList(strays)} 还活着`
      + `${info.stop.kind === "unresolved" && info.stop.why ? `（当时的说明：${info.stop.why}）` : ""}`);
  }
  if (info.groupAlive) owned.push("这次启动的进程组里还有活着的进程");
  if (info.ports.length) {
    const where = `端口 ${info.ports.join("、")}`;
    if (probe.state === "ours") owned.push(`${where} 上还有这次启动起来的进程在听`);
    else if (probe.state === "stranger") unsure.push(`${where} 上有进程在听，但核不上是这次启动起来的`);
    else if (probe.state === "unknown") unsure.push(`${where}：${probe.why ?? "上面是谁在听核不上来"}`);
    else if (probe.state === "unavailable") unsure.push(`${where} 在这台机器上没法核验（没有 lsof）`);
  }
  if (info.portsTruncated) unsure.push("这次启动打印的端口超过了记录额度，多出来的那些 ash 压根没问过");
  // 这一句**必须有**:按启动记号那一问没答全时,上面那份「确定留下的」本身就可能漏人,而用户
  // 正要在它上面签字(第 1 轮审查发现 1 的同一条不变量)。
  if (scan.evidence === "incomplete") {
    unsure.push(scan.unanswered.length
      ? `${pidList(scan.unanswered)} 分不清是不是这次启动的：它们跟这次启动同一个用户、在它之后出生，`
        + "身上却没有这次启动的记号 —— 多半是系统自己的后台进程，但 ash 证明不了"
      : scan.why ?? "按启动记号那一问没答全，上面那份清单可能有漏");
  }
  return {
    at: Date.now(), owedPids, taggedPids, ports: info.ports, portState: probe.state,
    notice: residueNotice(owned, unsure),
    left: owned.length ? "owned" : unsure.length ? "unsure" : "none",
  };
}

const pidList = (pids: number[]): string =>
  `${pids.slice(0, 5).map((pid) => `pid ${pid}`).join("、")}${pids.length > 5 ? ` 等 ${pids.length} 个进程` : ""}`;

/** 弹层上那段话。导出只为让回归直接钉住「两类分开说」,不必现造一个分不清来路的进程。 */
export function residueNotice(owned: string[], unsure: string[]): string {
  const doubt = unsure.length
    ? `${unsure.join("；")}。这些 ash 一个都没动过，放弃之后也不再替你盯着。` : "";
  if (owned.length) {
    return `下面这些是这次启动留下的，放弃之后 ash 不再管，得你自己处理：${owned.join("；")}。`
      + (doubt ? `另外，${doubt}` : "");
  }
  if (doubt) return `ash 没找到能确认是这次启动留下的进程。不过，${doubt}`;
  return "此刻探不到任何残留 —— 放弃之后这条记录就只是一条历史了。";
}

/** 弹层要的那一份:残留事实 + 解除范围 + 它针对的那条会话 id(确认时要带回来)。 */
export type LaunchResidueView = {
  sessionId: string;
  name: string;
  startedAt: number;
  residue: LaunchAbandonment;
  scope: string[];
  /** 非 null = 这条记录已经被放弃过,弹层直接显示当时那一份。 */
  abandoned: LaunchAbandonment | null;
};

function target(projectId: string, commandId: string): TerminalSessionInfo | null {
  const mine = terminalSessions.listCommandSessions()
    .filter((session) => session.projectId === projectId && session.commandId === commandId);
  return mine.find((session) => session.running) ?? mine.find((session) => session.abandoned)
    ?? mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

export function mountLaunchAbandonRoutes(api: Hono): void {
  // 看一眼要签的是什么。**只读**:它自己不改任何状态,所以用户可以放心点开再关掉。
  api.get("/projects/:projectId/commands/:commandId/residue", async (c) => {
    const projectId = c.req.param("projectId");
    const info = target(projectId, c.req.param("commandId"));
    if (!info) return c.json({ error: "这条命令名下没有启动记录" }, 404);
    const view: LaunchResidueView = {
      sessionId: info.id, name: info.name, startedAt: info.startedAt,
      residue: info.abandoned ?? await launchResidue(info), scope: scopeOf(info),
      abandoned: info.abandoned ?? null,
    };
    return c.json(view);
  });

  // 签字。`sessionId` 必填,而且必须是**用户刚看过的那一条** —— 一个旧弹层上的「是」不许放过
  // 一条新的启动(这是「显式放弃」跟「静默核销」的分界线)。
  api.post("/projects/:projectId/commands/:commandId/abandon", async (c) => {
    const projectId = c.req.param("projectId");
    const body = await c.req.json().catch(() => ({})) as { sessionId?: unknown };
    if (typeof body.sessionId !== "string" || !body.sessionId) {
      return c.json({ error: "缺少 sessionId：放弃必须针对你刚看过的那一条启动记录" }, 400);
    }
    const info = terminalSessions.get(body.sessionId, projectId);
    if (!info || info.commandId !== c.req.param("commandId")) {
      return c.json({ error: "这条启动记录已经不在了（可能刚被删掉）" }, 404);
    }
    const current = target(projectId, c.req.param("commandId"));
    if (current && current.id !== info.id) {
      return c.json({
        error: "期间这条命令又起了一份，请重新看一眼残留事实再决定",
        sessionId: current.id,
      }, 409);
    }
    // 幂等:再按一次不覆盖第一次那份快照 —— 残留在那之后只会变,改写等于把签字时看到的
    // 事实换掉。
    if (info.abandoned) return c.json({ abandoned: info.abandoned, alreadyAbandoned: true });
    const residue = await launchResidue(info);
    if (!terminalSessions.abandonLaunch(info.id, projectId, residue)) {
      return c.json({ error: "这条启动记录已经不在了（可能刚被删掉）" }, 404);
    }
    return c.json({ abandoned: residue });
  });
}
