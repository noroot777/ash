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
    "这条启动记录的删除保护解除：关掉它的日志标签、删掉这个项目都不再被它拦下",
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
  const scan = await launchSurvivors(token, info);
  const taggedPids = scan.pids;
  const probe = info.ports.length && PORT_TIER_AVAILABLE
    ? await probeOwnedPorts(info.ports, token)
    : { state: info.ports.length ? "unavailable" as const : "free" as const, why: null };
  const owedPids = liveLeftovers(info.stop);
  const parts: string[] = [];
  if (taggedPids.length) {
    parts.push(`按这次启动的记号还点到 ${taggedPids.map((pid) => `pid ${pid}`).join("、")} 活着`
      + "（环境里带着这次启动的记号，确凿是它起来的）");
  }
  const strays = owedPids.filter((pid) => !taggedPids.includes(pid));
  if (strays.length) {
    parts.push(`账上还挂着 ${strays.map((pid) => `pid ${pid}`).join("、")} 没核销`
      + `${info.stop.kind === "unresolved" ? `：${info.stop.why}` : ""}`);
  }
  if (info.ports.length) {
    const where = `端口 ${info.ports.join("、")}`;
    if (probe.state === "ours") parts.push(`${where} 上还有这次启动起来的进程在听`);
    else if (probe.state === "stranger") parts.push(`${where} 上坐着的核实不是这次起来的`);
    else if (probe.state === "unknown") parts.push(`${where}：${probe.why ?? "归属核不上来"}`);
    else if (probe.state === "unavailable") parts.push(`${where} 在这台机器上没法核验（没有 lsof）`);
  }
  if (info.groupAlive) parts.push("这次启动的进程组里还有活着的进程");
  if (info.portsTruncated) parts.push("这次启动打印的端口超过了记录额度，多出来的那些 ash 压根没问过");
  // 清单里**必须有这一句**:这一问没答全时,上面那份「还活着什么」本身就可能漏人,
  // 而用户正要在它上面签字(第 1 轮审查发现 1 的同一条不变量)。
  if (scan.evidence === "incomplete") parts.push(scan.why ?? "按启动记号那一问没答全，这份清单可能有漏");
  return {
    at: Date.now(), owedPids, taggedPids, ports: info.ports, portState: probe.state,
    notice: parts.length
      ? `放弃这次启动的管理责任之后，下面这些 ash 不再管，得你自己处理：${parts.join("；")}。`
      : "此刻探不到任何残留 —— 放弃之后这条记录就只是一条历史了。",
  };
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
