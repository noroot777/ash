/**
 * duet 的**一轮发言**:起 CLI、消费事件流、把这一轮落进 .md / transcript / sessions 行。
 *
 * 从 index.ts 拆出来的原因很实在 —— 那个文件在这一轮修复后越过了仓库的 700 行上限。
 * 这一块的职责本来也自成一体:index.ts 管的是「谁在第几轮说话、什么时候收敛、门禁怎么
 * 走」,这里只管「让一个执行器把一轮说完,并且把结果如实留在盘上」。两边的接缝就是
 * `Turn`。
 */

import { mkdirSync, createWriteStream, appendFileSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { eq, sql } from "drizzle-orm";
import type { DuetSpeaker, SessionRole, TurnTraceEvent } from "@ash/shared";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { bus } from "../bus.js";
import { id, now } from "../util.js";
import { trackRun, untrackRun, isCanceling, CanceledRun } from "../runs.js";
import type { AgentExecutor } from "../executors/types.js";
import {
  LOST_SESSION_PATCH,
  mergeSessionResumeFault,
  sessionResumeFaultNote,
  shouldDropSession,
  type SessionResumeFault,
} from "../executors/session-lost.js";
import { RUNS_DIR } from "../paths.js";
import { recordSessionUsageEvent, setSessionContext } from "../usage.js";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";
import { affectedCodexResumeVersion, announceAffectedSessionReplacement } from "../session-version-guard.js";
import { isSessionScopeNotice, announceSessionNote, CROSS_OWNER_SESSION_NOTE } from "../session-notice.js";
import { cliConfigDirColumn, runEnvForOwner, sessionResumableHere } from "../auth/run-env.js";
import { recordTurnStart } from "./timeline.js";

const RAISE_RE = /(^|\n)\s*\[可收敛\]/;
const AGREE_RE = /与对方一致[：:]\s*是/; // self-declared agreement with the opponent's conclusion
const CONC_RE = /结论[：:]\s*(.+)/; // one-line final conclusion

/**
 * 复用同一条 session 行接着跑下一轮时,必须跟着刷新的那几列。
 *
 * duet 每一轮都按当前 profile 重新解析执行器,而门禁可以等很久 —— 这期间 profile 可能
 * 被改到另一台机器上、worktree 可能被删后重建。这几列合起来正是「复制到终端接着聊」
 * 那条命令的全部依据(读取端 `resumeCommandFor` 每次按它们重算):漏掉 target 会给出一条
 * 在本机跑的错命令,漏掉 cwd 会给出一条 `cd` 到不存在目录的命令(第 2 轮审查 finding 6)。
 * 单独拎出来是为了让「哪些列会随轮次变」有一个能被测试钉住的地方。
 */
export function reusedSessionPatch(
  executor: AgentExecutor,
  cwd: string,
  commandLine: string,
  cliSessionId: string,
  runOwnerUserId: string | null = null,
  // **故意做成必填**,理由与上面 runOwner 那条同源:给它一个默认值,下一处新加的发言
  // 漏传时不会报错,而是把这条复用行的 cli_config_dir 悄悄写成 null —— null 在读侧
  // 正好等于「这一列上线前的老行」,于是那条会话的目录改按 run_owner 反推,在共用档下
  // 反推出一个从没写过东西的个人目录,直接把第 1 轮刚堵上的 "No conversation found"
  // 放回来,而且从产出上完全看不出来。必填 = 编译期就得回答「这一轮写在哪」。
  cliConfigDir: string | null,
) {
  return {
    commandLine,
    executor: executor.label,
    cwd,
    // 这一轮跑在谁名下(= 注入 CLAUDE_CONFIG_DIR/CODEX_HOME 的那个人)。跟 cwd 一样是
    // 「会话文件此刻在哪」的一部分:跨人回合换了人,transcript 就换到那个人的配置目录下,
    // 不刷新的话接力会去上一个人的目录里扑空。
    runOwnerUserId,
    // 以及那个目录本身(`""` = 宿主机默认目录)。同一个人的目录会随实例的「CLI 额度」
    // 设置整体挪位置,光有「谁」推不出「当初写在哪」—— 说明见 db/schema.ts 同名列。
    cliConfigDir,
    // id 本身也在这份补丁里,不能只写由它派生的那三件套:上一轮若因会话失效被清成 null
    // (LOST_SESSION_PATCH),这一轮开出来的新 id 就只活在内存里 —— 带 newIdFlag 的 CLI
    // 回报的 session 事件与本地 cliId 相同,下面那个 `!==` 分支不会触发,库里于是永远是
    // 「resume_command 指向 new-session、cli_session_id 却为空」的自相矛盾状态,重启后
    // 只能再开一条新会话。(第 1 轮审查 P1)
    // CLI 还没报出 session_id 时这几样都算不出来,那就一列都不碰 —— 写一条缺了 id 的
    // 恢复命令,比留着上一轮那条更糟。
    ...(cliSessionId ? { cliSessionId, ...executor.resumeFields(cwd, cliSessionId) } : {}),
  };
}

export interface Turn {
  rowId: string;
  cliId: string;
  text: string;
  raised: boolean;
  agrees: boolean; // self-declared "我的最终结论与对方一致" (only meaningful when raised)
  conclusion?: string; // self-declared one-line 结论 (for the gate display)
  exit: number;
  error?: string;
  notice?: string;
}

// Run one voice turn: stream events tagged with role+round, persist output +
// credential, and detect the raise-hand marker.
// 导出只为回归测试能直接喂一个假执行器驱动整轮(test:duet-session-lost);duet 内部
// 仍是唯一调用方。
export async function runTurn(args: {
  taskId: string;
  role: SessionRole;
  speaker: DuetSpeaker;
  round: number;
  executor: AgentExecutor;
  prompt: string;
  cwd: string;
  /**
   * 这一轮按谁的身份跑(§八):个人 CLI 配置目录 + git 署名从它算出来。
   *
   * **故意做成必填**:duet 起 CLI 的地方有七八处(开场、驳论、合稿、闸口重放、重试补
   * 跑…),给它一个默认值就等于给「下一处新加的发言」留一个静默漏注入的口子 —— 而漏
   * 掉的后果是那一轮跑在**宿主机**的 `~/.claude` 上,正是 §八 要抹掉的东西,且从产出上
   * 完全看不出来(第 5 轮审查 P1)。必填 = 编译期就得回答「这轮算谁的」。
   * 自用模式下 `runEnvForOwner` 返回空对象,这条路与本功能上线前逐字节一致。
   */
  runOwner: string | null;
  rowId?: string; // reuse a voice's session row across turns
  resumeCliId?: string; // resume the CLI session
  branch?: string | null;
  // 收敛状态下限:进入本轮前该方已有的 raised/结论。提问(ask)轮讨论者被要求不写
  // [可收敛],若它本轮没主动收敛就继承既有状态,避免一次澄清把已达成的共识打回。
  inherit?: { raised: boolean; agrees: boolean; conclusion?: string };
  // 附加进 transcript 行的元数据(如合稿轮的 stop 标签),读取端靠它区分
  // 「已收敛的共同方案」与「未共识的决策文档」。
  extra?: Record<string, unknown>;
}): Promise<Turn> {
  const { taskId, role, speaker, round, executor, prompt, cwd } = args;
  // A stop requested between turns: don't even spawn the next one.
  if (isCanceling(taskId)) throw new CanceledRun();
  let resumeCliId = args.resumeCliId;
  // 复用哪一条会话行。跨人续跑时会被清空 —— 见下。
  let reuseRowId = args.rowId;
  let versionReplacementNotice: string | undefined;
  // 换人接手:门禁能等很久,这期间**换个人点「继续」**是常规操作(runOwner 跟着点的
  // 那个人走)。而这条会话的 transcript 躺在原来那位的 CLI 配置目录里,拿到这一轮的
  // 环境里 --resume 只会扑空 —— 判据与单飞同源(auth/run-env.ts),自用模式恒不触发。
  // 同一堵墙的第二个触发口:实例把「CLI 额度」换了档,人没变、目录整体挪了位置。
  // 接不上就**另开一条会话行**,不是把旧行改写成新人的:旧行原样留着,原来那位再回来
  // 时还能从自己那条接着跑(这一点与上面的版本闸不同 —— 那条会话是真的坏了)。
  const reusedRow = resumeCliId && reuseRowId
    ? (await db
        .select({ cliConfigDir: sessions.cliConfigDir, runOwnerUserId: sessions.runOwnerUserId })
        .from(sessions)
        .where(eq(sessions.id, reuseRowId))).at(0)
    : undefined;
  if (reuseRowId && reusedRow
      && !(await sessionResumableHere(reusedRow, args.runOwner, executor.type))) {
    await announceSessionNote({
      taskId, sessionId: reuseRowId, role, agentType: executor.type, text: CROSS_OWNER_SESSION_NOTE,
    });
    resumeCliId = undefined;
    reuseRowId = undefined;
  }
  // 走到这里 resumeCliId 若还在,它就是**这一轮这个人**自己那条(跨人的已在上面另开),
  // 所以 rollout 按这一轮的配置目录去找。
  const turnConfigDir = await cliConfigDirColumn(args.runOwner, executor.type);
  const affectedSessionVersion = await affectedCodexResumeVersion(
    executor.type, resumeCliId, turnConfigDir || null,
  );
  if (affectedSessionVersion) {
    if (reuseRowId) {
      versionReplacementNotice = await announceAffectedSessionReplacement({
        taskId, sessionId: reuseRowId, role, agentType: executor.type, version: affectedSessionVersion,
        publish: false,
      });
      await db.update(sessions).set(LOST_SESSION_PATCH).where(eq(sessions.id, reuseRowId));
    }
    resumeCliId = undefined;
  }
  // 版本读取与持久说明之间有 await；这期间收到停止请求也不能再起下一轮。
  if (isCanceling(taskId)) throw new CanceledRun();
  const turnStart = now();
  const handle = executor.run({
    prompt: withGlobalBrowserPolicy(prompt, resumeCliId ? "reminder" : "full"),
    cwd,
    sessionId: resumeCliId || undefined,
    // 个人 CLI 配置目录 + git 署名(§八)。
    env: {
      ...(await runEnvForOwner(args.runOwner, executor.type)),
      // **不给讨论者回合身份,并且要确保它是真的没有**:讨论者没有完成协议,duet 的结算
      // 由这条流水线自己做,凭空发一个没登记进 tasks.activeTurnToken 的令牌只会让每个
      // 消费者都拒收。但「不设」不等于「没有」—— 子进程默认继承 server 自己的环境,
      // 而 ash 从一个 ash 任务里启动时那三个变量是有值的(实测:duet 的假 CLI 收到了
      // **另一个任务**的 ASH_TASK_ID)。借来的身份比没有身份更糟,所以显式清掉。
      ASH_TASK_ID: undefined,
      ASH_TURN_TOKEN: undefined,
      ASH_DIRECTION_TOKEN: undefined,
    },
  });
  trackRun(taskId, handle);
  let cliId = handle.sessionId;

  const rowId = reuseRowId ?? id();
  if (!reuseRowId) {
    await db.insert(sessions).values({
      id: rowId,
      taskId,
      role,
      agentType: executor.type,
      // 开新行和复用旧行共用同一份「随执行器/工作目录走」的列,免得两条分支各写各的、
      // 时间一长只有一边跟得上(finding 6 就是这么来的)。
      ...reusedSessionPatch(executor, cwd, handle.commandLine, cliId, args.runOwner ?? null, turnConfigDir),
      worktreePath: args.branch ? cwd : null,
      branch: args.branch ?? null,
      cliSessionId: cliId,
      startedAt: turnStart,
      turnStartedAt: turnStart,
      activeMs: 0,
      exitStatus: null,
    });
  } else {
    // Resuming the same session row for a new turn (e.g. after a gate the
    // user took a while to resolve): stamp this turn's start and clear the prior
    // end, so the gate wait is excluded from execution time.
    await db
      .update(sessions)
      .set({ turnStartedAt: turnStart, endedAt: null, ...reusedSessionPatch(executor, cwd, handle.commandLine, cliId, args.runOwner ?? null, turnConfigDir) })
      .where(eq(sessions.id, rowId));
  }

  recordTurnStart({ type: "duet.progress", taskId, round, speaker, phase: "start", startedAt: turnStart });
  if (versionReplacementNotice) {
    bus.publish({
      type: "agent.event", taskId, sessionId: rowId, role, agentType: executor.type,
      event: { kind: "system", text: versionReplacementNotice, at: now() },
    });
  }

  const runDir = join(RUNS_DIR, taskId);
  mkdirSync(runDir, { recursive: true });
  const out = createWriteStream(join(runDir, `${rowId}.md`), { flags: "a" });
  // 这条流在**整个回合**里一直开着(CLI 跑多久它开多久)。stream 上没人听的 'error'
  // 会直接掀掉进程,而 transcript 写不进去(盘满、worktree 被删、目录没权限)不该连累
  // 这一轮的结算 —— 先接住,回合末尾统一记一笔。
  let outFailure: unknown = null;
  out.on("error", (e) => { outFailure ??= e; });
  out.write(`\n\n### 第 ${round} 轮 · ${speaker}\n`);

  let text = "";
  let exit = 0;
  let errorMsg: string | undefined;
  let noticeMsg = versionReplacementNotice;
  // CLI 否认过这条会话，或 Codex stderr 证明 thread 已 poisoned 吗（见
  // executors/session-lost.ts）。duet 有自己的会话行与自己的
  // 结算,不经过 single-run.ts —— 漏掉这里,duet 任务会一直 --resume 同一个死 id:
  // 库里那份喂下一次 /retry,返回值里那份喂本次运行的后续轮次,两处都要清。
  let sessionFault: SessionResumeFault | null = null;
  // 本回合的执行过程,随回合一起落盘(见 TurnTraceEvent):刷新后时间线才展得开。
  const trace: TurnTraceEvent[] = [];
  const TRACE_CAP = 200;
  try {
    for await (const event of handle.events) {
      const sessionNotice = isSessionScopeNotice(event);
      const emittedEvent = event.kind === "usage"
        ? await recordSessionUsageEvent(rowId, event, executor.type, cliId)
        : event;
      const publishedEvent = event.kind === "error" && sessionNotice
        ? { kind: "system" as const, text: event.message, at: now() }
        : emittedEvent;
      bus.publish({ type: "agent.event", taskId, sessionId: rowId, role, event: publishedEvent });
      if (event.kind === "session" && event.cliSessionId !== cliId) {
        cliId = event.cliSessionId;
        await db
          .update(sessions)
          .set({ cliSessionId: cliId, ...executor.resumeFields(cwd, cliId) })
          .where(eq(sessions.id, rowId));
      } else if (event.kind === "text") {
        text += event.text;
        out.write(event.text + "\n");
      } else if (event.kind === "tool") {
        if (trace.length < TRACE_CAP) trace.push({ kind: "tool", label: event.name, detail: event.detail });
      } else if (event.kind === "thinking") {
        if (trace.length < TRACE_CAP) trace.push({ kind: "thinking", label: "思考过程", detail: event.text });
        out.write("〔思考〕" + event.text + "\n");
      } else if (event.kind === "error") {
        sessionFault = mergeSessionResumeFault(sessionFault, event.message);
        if (sessionNotice) {
          noticeMsg = `${noticeMsg ?? ""}\n${event.message}`.trim();
          out.write("⚠ " + event.message + "\n");
        } else {
          errorMsg = `${errorMsg ?? ""}\n${event.message}`.trim();
          out.write("✕ " + event.message + "\n");
        }
      } else if (event.kind === "context") {
        await setSessionContext(rowId, event.context);
      } else if (event.kind === "done") {
        exit = event.exitStatus;
      }
    }
  } finally {
    untrackRun(taskId, handle);
  }

  let raised = RAISE_RE.test(text);
  let agrees = raised && AGREE_RE.test(text);
  let conclusion = text.match(CONC_RE)?.[1]?.trim().slice(0, 140) || undefined;
  // 提问轮:讨论者按 prompt 不写 [可收敛]。若它进入本轮前本就已收敛,一次澄清提问不该让它
  // "放下手"——继承既有收敛状态，否则 isConsensus 会被一次提问打回为"未达成一致"。
  if (args.inherit && !raised) {
    raised = args.inherit.raised;
    agrees = args.inherit.agrees;
    conclusion = args.inherit.conclusion;
  }
  // A voice turn that exits cleanly but says nothing is degenerate (e.g. a
  // resume that returned no text) — treat it as a failure so the duet stops
  // instead of feeding emptiness to the opponent.
  const isVoice = role === "voiceA" || role === "voiceB";
  if (!errorMsg && exit === 0 && isVoice && !text.trim()) {
    errorMsg = `${executor.type} 本轮没有产出任何内容（空回复），可能是会话恢复异常`;
  }
  const endIso = now();
  const durationMs = Math.max(0, Date.parse(endIso) - Date.parse(turnStart));
  // CLI 否认或判定 poisoned：清掉失效 id 和由它派生的恢复命令，并把这件事写进本轮通知。
  // 会话轮换本身不等于本轮失败：Codex 可能已经 exit 0 且产出了完整正文，若塞进 error，
  // duet 的 failed() 会错误中止整场讨论。
  const dropSession = shouldDropSession(sessionFault, exit);
  if (dropSession) {
    const note = sessionResumeFaultNote(sessionFault!);
    noticeMsg = `${noticeMsg ?? ""}\n${note}`.trim();
    out.write("⚠ " + note + "\n");
    bus.publish({
      type: "agent.event", taskId, sessionId: rowId, role,
      event: { kind: "system", text: note, at: now() },
    });
  }
  // 关流放在**所有** out.write 之后。写已 end 的流不是静默丢弃,是 stream 上一个没人听的
  // 'error' 事件('ERR_STREAM_WRITE_AFTER_END'),会当场把整个 server 打崩 —— 而且只在
  // 会话失效这条冷路径上崩,正常跑一百遍都碰不到。(第 1 轮审查 P1)
  out.end();
  // `end()` 只是「我不写了」,不等于落盘 —— 文件可能连 open 都还没完成。必须等它真结束
  // 再返回:调用方拿到结果后随时会去读这份 transcript,而在那之前流才 open 失败的话,那个
  // 'error' 就成了回合之外的一颗雷,炸在谁头上全看时序(第 2 轮审查 P2:测试删掉 runs
  // 目录后进程被它打掉,断言明明全过了还是 exit 1)。
  await finished(out).catch(() => { /* 具体原因在 outFailure 里,下面统一报 */ });
  if (outFailure) console.warn(`[ash] duet 这一轮的 transcript 没写成 (${rowId}):`, outFailure);
  await db
    .update(sessions)
    .set({
      exitStatus: exit,
      endedAt: endIso,
      activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${durationMs}`,
      ...(dropSession ? LOST_SESSION_PATCH : {}),
    })
    .where(eq(sessions.id, rowId));
  // Persist the turn so a reloaded duet can rebuild its timeline (no live
  // events). Includes errors and non-fatal notices so reload preserves the same meaning as live SSE.
  try {
    appendFileSync(
      join(runDir, "transcript.jsonl"),
      JSON.stringify({ ...args.extra, round, speaker, text, raised, agrees, conclusion, error: errorMsg, notice: noticeMsg, startedAt: turnStart, at: endIso, durationMs, events: trace }) + "\n",
    );
  } catch {
    /* best effort */
  }
  bus.publish({ type: "duet.progress", taskId, round, speaker, phase: "end", raisedHand: raised, at: endIso, startedAt: turnStart, durationMs });
  // A manual stop killed this turn's subprocess → unwind to canceled (the top of
  // each entry point catches CanceledRun).
  if (isCanceling(taskId)) throw new CanceledRun();
  // cliId 清成空串,调用方的 `resumeCliId: ... || undefined` 就会退化成「开新会话」——
  // 本次运行的后续轮次也不会再拿这个死 id 去 --resume。
  return { rowId, cliId: dropSession ? "" : cliId, text, raised, agrees, conclusion, exit, error: errorMsg, notice: noticeMsg };
}
