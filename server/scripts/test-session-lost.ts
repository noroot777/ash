/**
 * 「CLI 否认了这条会话」的识别与清理。
 *
 * 起因(2026-08-21,172.16.88.252):任务第一次起跑就被 claude 的 root 闸拒掉,stdout
 * 0 字节 —— 会话压根没建起来,但 ash 在 spawn 那一刻就把自己发的 session id 落了库。
 * 之后每一次重试都 `--resume` 一个从不存在的会话,稳定失败,报的还是另一句话。用户
 * 把真正的病因(root 闸)修好了,任务照样红,两件事看不出关系。
 *
 * 这条链子有四节,断哪节都会静默失效,所以四节都在这儿钉住:
 *   ① claude 执行器把 CLI 那句原话**原样**带出来(它对别的错误是会改写的)
 *   ② isSessionLost 认得这句、且不误伤别的错误(误清 = 白丢一条能续的会话)
 *   ③ 清理要抹掉由那个 id 派生的全部字段,不是只抹 id
 *   ④ 每一条「拿库存 id 去 --resume」的链路都真的接了这套清理(别再长出第四条漏网的)
 * 跑:npm -w server run test:session-lost
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { parseSessionOutput } from "@ash/shared";
import { readCodexCliVersion } from "../src/executors/codex-rollout.js";
import {
  LOST_SESSION_PATCH,
  SESSION_DROP_PERSISTENCE_FAILED_NOTE,
  SESSION_POISONED_NOTE,
  codexSessionPoisonReason,
  isSessionLost,
  mergeSessionResumeFault,
  sessionResumeFault,
  shouldDropSession,
} from "../src/executors/session-lost.js";
import { affectedCodexSessionReplacementNote } from "../src/executors/version-policy.js";
import { parseClaudeStream } from "../src/executors/claude.js";
import { affectedCodexResumeVersion } from "../src/session-version-guard.js";
import { latestTeamLeadSession } from "../src/team/session-selection.js";
import {
  idleRotation,
  onFreshSession,
  onRotationError,
  onRotationNotPersisted,
  onRotationPersisted,
} from "../src/team/rotation-state.js";

const dir = mkdtempSync(join(tmpdir(), "ash-session-lost-"));
const ok = (m: string) => console.log("   ✓ " + m);

// 真机原话(claude 2.1.220,`claude --resume <uuid>` 指向一个不存在的 transcript)。
const REAL = "No conversation found with session ID: 6f8c7cdd-b820-416e-a4f3-96b516d6a8e2";

// ── ② 认得这句 ──────────────────────────────────────────────────────────────

assert.equal(isSessionLost(REAL), true, "真机原话");
assert.equal(isSessionLost(`Error: ${REAL}\n`), true, "被包在别的话里也算");
assert.doesNotMatch(SESSION_DROP_PERSISTENCE_FAILED_NOTE, /已清掉|已经把.*清掉/, "写库失败时不能谎称恢复字段已清");
assert.match(SESSION_DROP_PERSISTENCE_FAILED_NOTE, /可能再次尝试旧会话/, "写库失败时必须说明下一次仍可能撞旧会话");
assert.equal(isSessionLost(REAL.toLowerCase()), true, "大小写不敏感");
ok("认得 claude 的「这条会话我不认识」");

// 反面:这些都不该清会话。第一条尤其重要 —— 它正是 2026-08-21 那次的**真病因**,
// 会话那时是好的(压根还没建),清它没意义,只会把「为什么失败」搅浑。
for (const other of [
  "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons",
  "Credit balance is too low",
  "API Error: 404 model not found",
  "Invalid session ID format",
  "",
]) {
  assert.equal(isSessionLost(other), false, `不该误判:${other.slice(0, 40)}`);
}
ok("不误伤 root 闸 / 余额 / 404 / 格式错 等其它失败");

const POISON_UNKNOWN_TURN =
  "dropping turn-scoped item for unknown turn id 01a03642-0000-7000-8000-000000000000";
const POISON_MISSING_WORLD_STATE =
  "ignored world-state patch without a full snapshot";
const POISON_FLUSH =
  "failed to flush rollout after emitting terminal turn event: thread 01a03415-e32e-72d2-8510-26a3beb2832f not found";
assert.ok(codexSessionPoisonReason(POISON_UNKNOWN_TURN), "应识别真机 unknown-turn poisoned stderr");
assert.equal(sessionResumeFault(POISON_UNKNOWN_TURN), "poisoned");
assert.match(
  codexSessionPoisonReason(POISON_MISSING_WORLD_STATE) ?? "",
  /world-state/,
  "应在第一次无工具回合就识别真机缺失完整 world-state 的 stderr",
);
assert.equal(sessionResumeFault(POISON_MISSING_WORLD_STATE), "poisoned");
assert.equal(
  sessionResumeFault(POISON_FLUSH),
  "poisoned",
  "rollout flush 前兆按用户口径只作废恢复 thread，不能再静默忽略",
);
assert.equal(shouldDropSession("poisoned", 0), true, "poisoned thread 即使 exit 0 也必须作废");
assert.equal(shouldDropSession("lost", 0), false, "普通会话不存在仍保留 exit 0 防误清语义");
assert.equal(mergeSessionResumeFault("lost", POISON_UNKNOWN_TURN), "poisoned", "后到的 poisoned 信号必须升级判定");
assert.match(SESSION_POISONED_NOTE, /exit 0/);
assert.match(SESSION_POISONED_NOTE, /全新会话/);
ok("Codex 缺 world-state / unknown-turn / rollout flush 指纹都触发恢复 thread 轮换");

// ── ① 执行器原样带出来 ──────────────────────────────────────────────────────
// claude.ts 对 CLI 的 stderr 有一层措辞归一(normalizeClaudeCliError)。这句要是哪天
// 被改写成中文提示,上面那把正则就静默失配了 —— 那才是最难查的坏法:功能没了,测试
// 全绿。所以这里走真的解析器,而不是直接拿字符串喂 isSessionLost。
const script = join(dir, "stub.mjs");
writeFileSync(script, `process.stderr.write(${JSON.stringify(REAL + "\n")}); process.exitCode = 1;`);
const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
child.stdin?.end();
const events: any[] = [];
for await (const event of parseClaudeStream(child as any)) events.push(event);
const errors = events.filter((e) => e.kind === "error").map((e) => e.message as string);
assert.ok(errors.length > 0, "非零退出要报一条 error 事件");
assert.ok(errors.some((m) => isSessionLost(m)), `error 事件里认不出会话失效:${JSON.stringify(errors)}`);
ok("claude 执行器把这句原样带出来,识别接得上");

// ── ③ 清理抹干净 ────────────────────────────────────────────────────────────
// 只抹 cli_session_id 不够:三件套恢复命令是由它派生的,留着就是给用户一条复制粘贴
// 就撞墙的命令。(少了哪一列会编译不过,这里再从值上确认一次。)
assert.deepEqual(
  LOST_SESSION_PATCH,
  { cliSessionId: null, resumeCommand: null, resumeEnv: null, resumeArgs: null },
  "失效会话要连派生的恢复命令一起清掉",
);
ok("清理覆盖 id + 三件套恢复命令");

// ── ③bis 旧 Codex 会话在起跑前替换 ─────────────────────────────────────────
// rollout 首部允许有 BOM、空行或少量旁注；只要紧随其后的 session_meta 能证明它由
// 0.147 创建，三条真正 spawn --resume 的链都应走同一套版本守卫。
const originalCodexHome = process.env.CODEX_HOME;
const codexHome = join(dir, "codex-home");
const codexThreadId = "01a032e5-c973-78c2-bbc7-a2ff7d10b3da";
const rolloutDir = join(codexHome, "sessions", "2026", "08", "24");
mkdirSync(rolloutDir, { recursive: true });
writeFileSync(
  join(rolloutDir, `rollout-2026-08-24T10-00-00-${codexThreadId}.jsonl`),
  `\uFEFF\n${JSON.stringify({ type: "notice", payload: {} })}\n`
    + `${JSON.stringify({ type: "session_meta", payload: { session_id: codexThreadId, cli_version: "0.147.0" } })}\n`,
);
process.env.CODEX_HOME = codexHome;
try {
  assert.equal(await readCodexCliVersion(codexThreadId), "0.147.0", "应越过文件头噪声读到创建版本");
  assert.equal(await affectedCodexResumeVersion("codex", codexThreadId), "0.147.0");
  assert.equal(await affectedCodexResumeVersion("claude", codexThreadId), undefined, "只替换 Codex 会话");
  const replacementNote = affectedCodexSessionReplacementNote("0.147.0") ?? "";
  assert.match(replacementNote, /本轮不再续用/);
  assert.doesNotMatch(replacementNote, /下次运行|再次运行/, "替换事件不能混入尚未发生的时态");
} finally {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
}
ok("能识别带文件头噪声的 0.147 Codex rollout");

const cappedThreadId = "01b032e5-c973-78c2-bbc7-a2ff7d10b3da";
writeFileSync(
  join(rolloutDir, `rollout-2026-08-24T10-05-00-${cappedThreadId}.jsonl`),
  "\n".repeat(32)
    + `${JSON.stringify({ type: "session_meta", payload: { session_id: cappedThreadId, cli_version: "0.147.0" } })}\n`,
);
process.env.CODEX_HOME = codexHome;
try {
  assert.equal(await readCodexCliVersion(cappedThreadId), null, "32 行扫描上限必须把空行计入");
} finally {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
}
ok("Codex rollout 扫描上限包含空行");

const latestLead = latestTeamLeadSession([
  { id: "older-live", role: "lead", startedAt: "2026-08-24T08:00:00.000Z", cliSessionId: "old-id" },
  { id: "newer-cleared", role: "lead", startedAt: "2026-08-24T09:00:00.000Z", cliSessionId: null },
  { id: "newest-worker", role: "single", startedAt: "2026-08-24T10:00:00.000Z", cliSessionId: "worker-id" },
]);
assert.equal(latestLead?.id, "newer-cleared", "最新 lead 被清空后不能越过它复活更老上下文");
assert.equal(latestLead?.cliSessionId, null, "最新 lead 无凭据时应由 openLead 开全新会话");
ok("团队调度台只认最新 lead 行，不复活更老会话");

// ── ④ 没有第四条没接清理的续跑链 ────────────────────────────────────────────
// 这个修复最容易坏的方式不是写错,是**再长出一条链**:谁都能写一行
// `sessionId: <库里读出来的 id>` 把 CLI 的 --resume 接上,却不知道还得在自己的结算里
// 清掉失效 id。漏了不会报错,只会让那条链上的任务永远撞同一堵墙(2026-08-21 原样重演),
// 而且当时 duet 就是这么漏的。所以在这里把「链子」和「谁负责清」的对应关系钉死。
const SRC = join(import.meta.dirname, "..", "src");
/** 拿库里的 id 去 --resume 的调用点 → 它这一轮的结算落在哪个文件。 */
const CHAIN_OWNER: Record<string, string> = {
  // 重启后接回已有进程,不自己 spawn --resume;收尾复用 consumeSingleRun。
  "reattach.ts": "single-run.ts",
  "orchestrator.ts": "single-run.ts",
  "team/session.ts": "team/session.ts",
  "duet/turn.ts": "duet/turn.ts",
};
const RESUME_CALL = /sessionId:[^,\n]*(cliSessionId|resumeCliId)/;
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
  );
const rel = (p: string) => relative(SRC, p).split(sep).join("/");
const chains = walk(SRC).filter((f) => RESUME_CALL.test(readFileSync(f, "utf8"))).map(rel).sort();
assert.deepEqual(
  chains,
  Object.keys(CHAIN_OWNER).sort(),
  "server/src 里拿库存 id 续跑的地方变了。新增一条链的话:先在它自己的结算里接上 "
    + "mergeSessionResumeFault + LOST_SESSION_PATCH,再把它登记进 CHAIN_OWNER",
);
for (const [chain, owner] of Object.entries(CHAIN_OWNER)) {
  const code = readFileSync(join(SRC, owner), "utf8");
  assert.ok(code.includes("LOST_SESSION_PATCH"), `${chain} 的结算方 ${owner} 没在清失效会话`);
  // 识别 poisoned 可以直接调合并规则,也可以走常驻那台状态机(它自己就架在同一条规则上,
  // 见 team/rotation-state.ts 与本文件 ⑦)—— 但总得有一个,不能一个都没有。
  assert.match(
    code,
    /mergeSessionResumeFault|onRotationError/,
    `${chain} 的结算方 ${owner} 没识别 poisoned 会话`,
  );
  assert.ok(code.includes("shouldDropSession"), `${chain} 的结算方 ${owner} 没让 poisoned exit 0 作废`);
}
ok("每条续跑链都有人负责清失效 id");

for (const chain of ["orchestrator.ts", "team/session.ts", "duet/turn.ts"]) {
  const code = readFileSync(join(SRC, chain), "utf8");
  assert.ok(code.includes("affectedCodexResumeVersion"), `${chain} 没在起跑前识别受影响的 Codex 会话`);
  assert.match(
    code,
    /announceAffectedSessionReplacement\([\s\S]*?db\.update\(sessions\)\.set\(LOST_SESSION_PATCH\)/,
    `${chain} 应先持久说明，再清除旧会话凭据`,
  );
}
ok("single / team / duet 都在持久说明后替换受影响的 Codex 会话");

const teamSessionCode = readFileSync(join(SRC, "team/session.ts"), "utf8");
assert.match(
  teamSessionCode,
  /async function closeLead[\s\S]*?catch \(error\)[\s\S]*?if \(dropSession\) dropNote = SESSION_DROP_PERSISTENCE_FAILED_NOTE/,
  "closeLead 写库失败后仍会沿用‘恢复字段已清掉’的旧文案",
);
ok("团队调度台写库失败时改用与事实一致的会话说明");

// ── ⑤ 轮换旁注不是「本回合失败」,而且不能挤掉 agentEnd ──────────────────────
// scope:"session" 那条诊断说的是「这条恢复会话作废了」,一个 exit 0、正常交卷的回合
// 不该因此在执行过程里记一笔异常 —— 所以 single-run / team 都把它降成 system 旁注。
// 但旁注是**落盘的 turn sentinel**,而重建时 agentEnd 只往「最后一段是 agent」的气泡上
// 盖结束时间(parseSessionOutput)。写在正文和 agentEnd 之间,这一回合的用时就会退回到
// 「算到下一次说话为止」。这里拿真解析器把两种写法都跑一遍,把顺序钉死。
const ROTATION_NOTE = "ash 已清掉这条会话的恢复字段：下一次运行会开一条全新会话。";
const AGENT_END_AT = "2026-08-25T10:00:05.000Z";
const noticeTurn = (at: string) =>
  `\n\x1e${JSON.stringify({ t: "system", agent: "codex", text: ROTATION_NOTE, at })}\n`;
const agentEndTurn = `\n\x1e${JSON.stringify({ t: "agentEnd", at: AGENT_END_AT })}\n`;

const afterEnd = parseSessionOutput(`活干完了。${agentEndTurn}${noticeTurn("2026-08-25T10:00:06.000Z")}`);
assert.deepEqual(afterEnd.map((seg) => seg.kind), ["agent", "system"], "旁注要独立成段,不能糊进正文");
assert.equal(
  afterEnd.find((seg) => seg.kind === "agent")?.endedAt,
  AGENT_END_AT,
  "旁注排在 agentEnd 之后时,agent 气泡仍拿得到真实结束时间",
);
assert.equal(afterEnd.at(-1)?.text, ROTATION_NOTE, "旁注正文要原样留着");

// 反面:夹在中间就会把 agentEnd 的落点抢走 —— 这正是要避免的写法。
const beforeEnd = parseSessionOutput(`活干完了。${noticeTurn("2026-08-25T10:00:04.000Z")}${agentEndTurn}`);
assert.equal(
  beforeEnd.find((seg) => seg.kind === "agent")?.endedAt,
  undefined,
  "旁注夹在正文和 agentEnd 之间会让 agent 气泡丢掉结束时间(所以两条链都必须写在 agentEnd 之后)",
);

// 落盘顺序由代码保证:两条链都得先 writeTurnEnd,再补旁注。
const singleRunCode = readFileSync(join(SRC, "single-run.ts"), "utf8");
assert.match(
  singleRunCode,
  /writeTurnEnd\(out, endIso\);[^\n]*\n\s*flushSessionNotices\(\);/,
  "single-run 的轮换旁注必须写在 writeTurnEnd 之后",
);
// 而且不能只在正常尾部落盘:清库/重放/结算任何一步抛错,旁注就只活在实时 SSE 里,
// 用户一刷新什么都看不到,还会去重试同一条坏会话。异常路径必须有兜底 flush。
assert.match(
  singleRunCode,
  /\} finally \{[\s\S]{0,600}?flushSessionNotices\(\);[\s\S]{0,200}?await closeExecution\("failed", now\(\)\);/,
  "single-run 的 finally 必须兜底把轮换旁注落盘,否则异常路径上这条证据会整个消失",
);
// 兜底能安全跑两次的前提:flush 先把缓冲取空。否则正常路径已经 end 掉流之后再写一次,
// 会当场把整个 server 打崩(ERR_STREAM_WRITE_AFTER_END)。
assert.match(
  singleRunCode,
  /const flushSessionNotices = \(\) => \{\s*\n\s*const notices = sessionNotices\.splice\(0\);/,
  "flushSessionNotices 必须先取空再写,否则 finally 那次兜底会把同一条写两遍/写到已 end 的流上",
);
for (const fence of [/writeTurnEnd\(lead\.out, endIso\);[^\n]*\n\s*flushSessionNotices\(lead\)/]) {
  assert.match(teamSessionCode, fence, "team 的轮换旁注必须紧跟在 writeTurnEnd 之后落盘");
}
assert.equal(
  (teamSessionCode.match(/flushSessionNotices\(lead\);/g) ?? []).length,
  2, // endTurn + closeLead:回合正常结束和进程没了两条路都得把攒下的旁注落盘
  "endTurn 与 closeLead 都要 flush 旁注,否则进程直接没了那一路会把旁注丢在内存里",
);
// scope 分流:三条链都得认这个字段,少一条就会在成功回合上记异常。
for (const [chain, owner] of [["single", "single-run.ts"], ["team", "team/session.ts"], ["duet", "duet/turn.ts"]]) {
  assert.match(
    readFileSync(join(SRC, owner!), "utf8"),
    /scope === "session"/,
    `${chain} 没按 scope 分流会话轮换诊断,成功回合会被记成有异常`,
  );
}
ok("会话轮换旁注按 scope 分流,排在 agentEnd 之后,异常路径也落得下来");

// ── ⑥ 中途已作废的会话,收尾不再重播整段说明 ────────────────────────────────
assert.match(
  teamSessionCode,
  /rotation\.announced \? ROTATION_ALREADY_ANNOUNCED : dropNote/,
  "consume 里已经播过轮换说明时,closeLead 应只补指路而不是整段重复",
);
// 中途清库那一步也要认「这条会话行已被新进程接管」,否则会抹掉新进程刚写进去的 id。
assert.match(
  teamSessionCode,
  /if \(leads\.get\(lead\.taskId\) === lead\) \{\s*\n\s*let note = sessionResumeFaultNote\("poisoned"\);\s*\n\s*try \{\s*\n\s*await db\.update\(sessions\)\.set\(LOST_SESSION_PATCH\)/,
  "常驻中途作废会话前必须排除 superseded,否则会清掉新进程的有效 id",
);
ok("常驻中途作废:不重播说明,也不抹掉接管进程的新会话 id");

// ── ⑦ 轮换状态机:标志位必须跟着会话一起翻篇 ────────────────────────────────
// 常驻调度台在同一条 events 流里跑很多回合,所以「坏没坏 / 等不等新 id / 那句『已作废』
// 说没说过」是**跨会话**活着的三个标志。真正的坏法不是写错一行,而是换了新会话却漏复位
// 其中一个 —— 于是上一条会话的结论被串到下一条上。这是状态序列题,结构 grep 抓不到,所以
// 逻辑抽在 team/rotation-state.ts 里按序列测。
const POISON = "ignored world-state patch without a full snapshot";

// 基线:干净状态什么都不认。
assert.deepEqual(idleRotation(), { fault: null, awaitingFresh: false, announced: false });

// ① 普通 error 不该升起任何轮换意图。
assert.deepEqual(
  onRotationError(idleRotation(), "Error: 余额不足"),
  { fault: null, awaitingFresh: false, announced: false },
  "不相干的失败不能被当成会话轮换",
);

// ② 第一条会话 poisoned + 清库成功 → 那句「已作废」可以说,而且属实。
const firstRotated = onRotationPersisted(onRotationError(idleRotation(), POISON));
assert.deepEqual(firstRotated, { fault: "poisoned", awaitingFresh: true, announced: true });

// ③ 下一回合 fresh session 报上新 id → 三个标志一起归零。
const afterFresh = onFreshSession(firstRotated);
assert.deepEqual(
  afterFresh,
  { fault: null, awaitingFresh: false, announced: false },
  "换上新会话后必须连 announced 一起复位,否则上一次的『已作废』会被算到新会话头上",
);

// ④ 新会话再次 poisoned,这次数据库写不进去 → 绝不能报喜。
const secondFailed = onRotationNotPersisted(onRotationError(afterFresh, POISON));
assert.equal(secondFailed.fault, "poisoned");
assert.equal(
  secondFailed.announced,
  false,
  "恢复字段没清成还标成『已说过』,收尾就会用一句报喜的短话盖掉真相(库里旧 id 还在)",
);
assert.equal(shouldDropSession(secondFailed.fault, 1), true, "poisoned 仍然要作废恢复会话");

// ⑤ 没在等新 id 的时候收到 session 事件(第一回合的正常开台),不该动任何标志。
const untouched = onRotationError(idleRotation(), REAL); // 普通 lost，没走轮换
assert.deepEqual(onFreshSession(untouched), untouched, "没在等新 id 时,session 事件不该清掉既有判定");
ok("轮换状态机:新会话建立后三个标志一起复位,第二次清库失败不报喜");

rmSync(dir, { recursive: true, force: true });
console.log("session-lost: 全部通过");
