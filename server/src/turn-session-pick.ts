// **这一轮续哪一条会话行** —— 从 orchestrator.ts 拆出来(单文件 700 行的约定)。
//
// 拆的是一件独立的职责:一个任务上可以有好几位智能体、每位好几条会话行,而「这一句话该
// 接到哪一条上」压着三个彼此独立的判据 —— 同一位智能体同一种角色、**那条会话的 CLI 配置
// 目录此刻接得上**(共享项目里 B 回复 A 的任务、实例换了额度档位都会让它接不上)、以及
// codex 那几个受影响版本的 rollout 不能再 resume。三条都答「能」才算接得上;接不上要**留下
// 话**(界面上会凭空多一条会话行),所以这里做的不只是挑,还有两处持久说明。
//
// 挑完之后的事(执行器解析、工作目录、prompt 拼装、spawn)仍在 orchestrator.ts。
import { eq } from "drizzle-orm";
import type { AgentType, SessionRole } from "@ash/shared";
import type { CliCommand } from "@ash/shared/cli-commands";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { isDiagnosticSession } from "./turn-failure.js";
import { cliGoalSessionCandidates } from "./task-cli-goal-scopes.js";
import { sessionCliConfigDir, sessionResumableHere } from "./auth/run-env.js";
import { announceSessionNote, CROSS_OWNER_SESSION_NOTE } from "./session-notice.js";
import { affectedCodexResumeVersion, announceAffectedSessionReplacement } from "./session-version-guard.js";
import { LOST_SESSION_PATCH } from "./executors/session-lost.js";

export type SessionRow = typeof sessions.$inferSelect;

/**
 * 挑出这一轮要续的那条会话行。
 *
 * 返回 `all`(这个任务名下全部会话行,新的在前)也是有用的:调用方拿它算「本任务里还有
 * 没有新面孔」那条告知(`peerNoticeFor`),而那要的是**更新 session 行之前**的快照。
 */
export async function pickTurnSession(input: {
  taskId: string;
  task: typeof tasks.$inferSelect;
  agent: AgentType;
  sessionRole: Extract<SessionRole, "single" | "reviewer">;
  profileId: string | null;
  runOwner: string | null;
  slash: CliCommand | null;
  freshSession?: boolean;
  resumeSessionId?: string;
}): Promise<{ all: SessionRow[]; prev: SessionRow | undefined; resuming: boolean; reseed: boolean }> {
  const { taskId, task, agent, sessionRole, profileId, runOwner, slash } = input;
  const opts = { freshSession: input.freshSession, resumeSessionId: input.resumeSessionId };
  // A single task can now host several agents — one session line per agentType,
  // each invited via @-mention. Newest first.
  const all = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
    .filter((session) => !isDiagnosticSession(session))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  // 「这一条接得上吗」不止看 agentType+role:CLI 的会话文件躺在**开它的那个人**的配置
  // 目录里,而共享项目里 B 可以回复 A 的任务(runOwner 上面刚算过)。拿 A 的 session id
  // 去 B 的 CLAUDE_CONFIG_DIR 里 --resume,CLI 只会回一句 "No conversation found" ——
  // 与 2026-08-29 那次接力事故同一堵墙,换了个触发口。判据在 auth/run-env.ts
  // (自用模式两边恒为 null,这一层永远放行,行为不变)。
  // 第二个触发口是实例把「CLI 额度」换了档(共用宿主 CLI ⇄ 每人自带 key):人没变,
  // 目录整体挪了位置。所以比的是**会话行记下的那个目录**,不是按归属人现算一遍。
  // 存量会话没有这两列,回落到任务归属人:它们本来就是按归属人跑的。
  const resumableHere = async (s: typeof all[number]) =>
    !s.cliSessionId || await sessionResumableHere(s, runOwner, agent);
  // 指名道姓要续哪一条会话行（「重跑上一回合」）：按 agentType+role 挑会在同一位
  // 智能体有多条会话时挑错人，而重投必须落回**崩掉的那一条**，否则等于换个人重说。
  const candidates = opts.freshSession
    ? []
    : opts.resumeSessionId
      ? all.filter((s) => s.id === opts.resumeSessionId)
      : cliGoalSessionCandidates(task, agent, profileId, runOwner, slash, all.filter((session) => session.agentType === agent && session.role === sessionRole));
  let prev: typeof all[number] | undefined;
  for (const s of candidates) {
    if (await resumableHere(s)) { prev = s; break; }
    // 接不上就另开一条 —— 但**不能一声不吭**:这一轮起跑后界面上会凭空多出一条会话行,
    // 而旧会话看着好好的却再没人续。理由写进旧会话的时间线,刷新后仍在。
    await announceSessionNote({
      taskId, sessionId: s.id, role: s.role as SessionRole, agentType: agent,
      text: CROSS_OWNER_SESSION_NOTE,
    });
  }
  // 版本守卫要去**这条会话的 rollout 实际写在的那个目录**里读(会话行记着;老行回落到
  // 按归属人现算)——不传等于按宿主机默认目录找,隔离档下必然扑空、静默放行。
  const affectedSessionVersion = await affectedCodexResumeVersion(
    agent, prev?.cliSessionId,
    prev ? await sessionCliConfigDir(prev, agent) : null,
  );
  if (prev && affectedSessionVersion) {
    // 说明必须先持久写进旧会话，凭据后清；否则下面任一 await 抛错都会留下一个
    // 「上下文没了、但没有解释」的永久状态。
    await announceAffectedSessionReplacement({
      taskId, sessionId: prev.id, role: sessionRole, agentType: agent, version: affectedSessionVersion,
    });
    await db.update(sessions).set(LOST_SESSION_PATCH).where(eq(sessions.id, prev.id));
    prev = undefined;
  }
  // 用户删过这个任务里的消息：旧 CLI 会话还记着原话，凡是要在它上面接着跑的都不行。
  //  - 普通消息：会话行照旧续（同一份 .md 接着写），CLI 会话换一条新的、拿删除之后的记录
  //    重建（reseed，conversation-redact.ts / history-reseed.ts）；
  //  - CLI 命令（`/fork` 把旧上下文整份复制进新分支，`/review` `/compact` `/plan` `/goal`
  //    都在旧上下文上让模型干活）：没有「换新会话再执行」的等价物，明说先发一条普通消息。
  //    `/new` `/clear` 本来就不带旧上下文，照常放行。
  // 标记看的是会话行本身，**不看它此刻有没有 cliSessionId**：接力导入（handoff-import.ts）、
  // 会话失效（LOST_SESSION_PATCH）都会把 id 置空而标记还在 —— 那种行照样续、照样重建，
  // 不能当成「没有可续的会话」另开一行，把删除之后的那份记录也一并丢了。
  const stale = !!prev?.contextRebuildAt;
  if (stale && slash && !["new", "clear"].includes(slash.name)) throw new Error(STALE_CONTEXT_COMMAND(slash.name));
  const resuming = (!!prev?.cliSessionId || stale) && !["fork", "new", "clear"].includes(slash?.name ?? "");
  return { all, prev, resuming, reseed: resuming && stale };
}

export const STALE_CONTEXT_COMMAND = (name: string) =>
  `这条会话里删过消息，旧的 CLI 上下文已作废，/${name} 会在旧上下文上执行，所以没有发出。`
  + `先发一条普通消息，让它带着删除后的记录在新会话里接上，再用 /${name}。`;
