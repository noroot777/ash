// 常驻调度台:写库失败 / 事件流被掀翻,都不能让这台调度台留下假状态。
//
// 起因(2026-08-25 第 2、3 轮审查)。团队链的写库全都跑在 consume 的 for-await 里,所以
// 这一带的坏法都不是「一个回合失败」,而是**内存、数据库和落盘产物各说各话**:
//   ① endTurn 的 sessions 更新一抛 → writeTurnEnd / flushSessionNotices / 落 idle /
//      closeLead 全跳过:.md 里没有轮换旁注、任务永远 running、leads 里留着一台没人
//      消费事件的假在线调度台(后续消息照送进去,一个字都不落盘)。
//   ② 新会话凭据写库失败后不重试 → 内存 id 已换、库里还是空的。进程一回收或 server
//      一重启就只能 fresh,刚建立的上下文无提示丢失。
//   ③ 事件流在 poisoned 之后抛错 → 收尾要是写死「用同一条会话接回」,就跟刚落盘的
//      「这条会话已作废」正面矛盾;而且从没收到过 done,却把 exit 0 记进库。
//
// 所以这里不是结构 grep,而是**真的让写库失败 / 真的掀翻事件流**(SQLite 触发器
// RAISE(ABORT)、iterator 抛异常),再从落盘的 .md、库里的行和 leads 在线判定上验。
//
// 跑:npm -w server run test:team-resilience
import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import type { ResidentHandle } from "../src/executors/types.js";

const root = mkdtempSync(join(tmpdir(), "ash-team-resilience-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_TEAM_IDLE_MS = "0"; // 别在测试里挂一个 30 分钟的回收计时

// 真机 Codex stderr:同一条 thread 已经 poisoned,恢复它只会一次次撞同一堵墙。
const POISON = "ignored world-state patch without a full snapshot";

// env 要在这些模块被求值之前定好(db/paths 在模块顶层就读它们),所以走动态 import。
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { attachLead, teamIsLive } = await import("../src/team/session.js");
const { SESSION_POISONED_NOTE } = await import("../src/executors/session-lost.js");
const { eq } = await import("drizzle-orm");

const at = "2026-08-25T00:00:00.000Z";
const ok = (m: string) => console.log("   ✓ " + m);

// 让 sessions 的 UPDATE **真的**失败,tasks 照常可写 —— 这样才分得清「哪一行写不进去」
// 和「整个库挂了」,复现的正是审查里那条路径。
const breakSessionWrites = () =>
  dbClient.executeMultiple(
    "CREATE TRIGGER injected_sessions_failure BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'injected sessions failure'); END;",
  );
const healSessionWrites = () => dbClient.executeMultiple("DROP TRIGGER IF EXISTS injected_sessions_failure;");

interface Scenario {
  /** 这台调度台开台时手上那条 CLI 会话 id(同时写进库)。 */
  cliSessionId: string;
  /** 按 consume 的消费节奏一条条放事件;generator 只有在上一条处理完才恢复执行, */
  /** 所以「装/拆故障」写在 yield 之间,天然排在前一条事件处理完之后。 */
  script: () => AsyncGenerator<AgentEvent>;
}

/** 起一台真的调度台,喂完 script 里的事件,等它自己收完台。 */
async function runLead(name: string, s: Scenario) {
  const taskId = `task-${name}`;
  const sessId = `sess-${name}`;
  await db.insert(tasks).values({
    id: taskId,
    projectId: "project",
    title: "调度台",
    body: "带一队人干活",
    mode: "team",
    status: "running", // 回合进行中
    team: JSON.stringify({ lead: "codex", worker: "codex" }),
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    agentType: "codex",
    autoTitle: false,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(sessions).values({
    id: sessId,
    taskId,
    role: "lead",
    agentType: "codex",
    executor: "codex@test",
    cwd: root,
    cliSessionId: s.cliSessionId,
    resumeCommand: `codex exec resume ${s.cliSessionId}`,
    startedAt: at,
    turnStartedAt: at,
    activeMs: 0,
    exitStatus: null,
  });
  const runDir = join(root, "runs", taskId);
  mkdirSync(runDir, { recursive: true });

  let sent = 0;
  let killed = 0;
  const handle: ResidentHandle = {
    sessionId: s.cliSessionId,
    commandLine: `codex exec resume ${s.cliSessionId}`,
    events: s.script(),
    send: () => { sent++; },
    interrupt: () => {},
    dropSession: () => {},
    close: () => {},
    kill: () => { killed++; },
  };
  attachLead({
    taskId,
    sessId,
    cliSessionId: s.cliSessionId,
    agentType: "codex",
    executorId: null,
    model: null,
    reasoningEffort: null,
    cwd: root,
    handle,
    out: createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" }),
    busy: true,
    turnStart: at,
    pending: [],
    notices: [],
    pendingCredential: null,
    idleTimer: null,
    closing: null,
  });

  const deadline = Date.now() + 15_000;
  while (teamIsLive(taskId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    teamIsLive(taskId),
    false,
    `${name}:收尾没跑完,leads 里还挂着这台调度台 —— 后续消息会被送进一个没人听的 handle`,
  );
  // .md 走 WriteStream,end() 之后才保证落到磁盘;上面等的是 leads 摘牌,这里再等正文。
  const mdPath = join(runDir, `${sessId}.md`);
  const readMd = () => { try { return readFileSync(mdPath, "utf8"); } catch { return ""; } };
  while (!readMd() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));

  return {
    md: readMd(),
    trace: (() => { try { return readFileSync(join(runDir, `${sessId}.trace.jsonl`), "utf8"); } catch { return ""; } })(),
    task: async () => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!,
    session: async () => (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!,
    sent: () => sent,
    killed: () => killed,
  };
}

try {
  await ensureSchema();
  await db.insert(projects).values({ id: "project", name: "team-resilience", repoPath: root, createdAt: at });

  // ── ① 回合收尾写库一直失败:旁注照样落盘,任务落回 idle,不留假在线调度台 ────────
  const a = await runLead("end-turn-write", {
    cliSessionId: "poisoned-thread",
    script: async function* () {
      yield { kind: "error", message: POISON, scope: "session" };
      breakSessionWrites(); // 从这里开始,endTurn 和 closeLead 的 sessions 更新都会抛
      yield { kind: "turnEnd" };
      yield { kind: "done", exitStatus: 0 };
    },
  });
  healSessionWrites();
  assert.ok(
    a.md.includes(SESSION_POISONED_NOTE),
    "回合收尾写库失败时轮换旁注没落盘 —— 用户刷新后看不到会话已作废,会照着旧指引再撞一次墙",
  );
  assert.match(a.md, /回合收尾状态写入数据库失败/, "写库失败必须如实说出来,不能咽掉");
  assert.match(a.trace, /回合收尾状态写入数据库失败/, "执行过程面板同样要看得到这次失败");
  assert.equal((await a.task()).status, "idle", "写库失败后任务卡在 running,界面上会永远显示它在干活");
  assert.equal(a.sent(), 0, "这一路没有待送消息,不该凭空往已经收掉的进程里塞话");
  assert.equal(a.killed(), 0, "每一步写库失败都各自兜住了,不该走到掀翻消费循环那条兜底");
  ok("回合收尾写库失败:旁注落盘、任务落回 idle、leads 里不留假在线调度台");

  // ── ② 新会话凭据写库失败一次:后面要补上,不能让上下文无声消失 ──────────────────
  // 内存里的 id 是当场换掉的,库里那笔全靠这次写入。写失败还当它成了,进程一回收或
  // server 一重启就只能 fresh —— 刚建立的会话连同上下文一起没了,而且一个字都不会说。
  const FRESH = "fresh-thread-that-must-survive-recycle";
  const b = await runLead("credential-retry", {
    cliSessionId: "old-thread",
    script: async function* () {
      breakSessionWrites();
      yield { kind: "session", cliSessionId: FRESH };
      healSessionWrites(); // 瞬时故障:库这就好了,欠着的那笔必须补上
      yield { kind: "turnEnd" };
      yield { kind: "done", exitStatus: 0 };
    },
  });
  const bRow = await b.session();
  assert.match(b.md, /新会话凭据写入数据库失败/, "凭据写失败要如实说出来");
  assert.equal(
    bRow.cliSessionId,
    FRESH,
    "凭据写库失败后没重试 —— 库里不知道这条会话,空闲回收/重启后只能 fresh,上下文无提示丢失",
  );
  assert.ok(bRow.resumeCommand?.includes(FRESH), "恢复命令要跟补写进去的 id 一致,不能停在旧会话上");
  assert.equal((await b.task()).status, "idle", "凭据补写这一路同样要把任务落回待命");
  ok("新会话凭据写库失败后会重试,库恢复即补上");

  // ── ③ poisoned 之后事件流被掀翻:不给相反指引,也不把异常中断记成 exit 0 ─────────
  const c = await runLead("abort-after-poison", {
    cliSessionId: "poisoned-thread",
    script: async function* () {
      yield { kind: "error", message: POISON, scope: "session" };
      throw new Error("injected event stream failure");
    },
  });
  assert.ok(c.md.includes(SESSION_POISONED_NOTE), "作废说明照样要落盘");
  assert.match(c.md, /调度台事件流异常中断/, "事件流被掀翻这件事必须如实写下来");
  assert.doesNotMatch(
    c.md,
    /会话还在|同一条 CLI 会话接回|自动接回/,
    "会话刚判过 poisoned,收尾还说「再说一句就能接回」—— 用户照做一次再撞一次墙",
  );
  assert.notEqual(
    (await c.session()).exitStatus,
    0,
    "从没收到过 done 却把 exit 0 落库 —— 异常中断被记成了成功收尾",
  );
  assert.equal(c.killed(), 1, "事件流没人消费了,那个进程必须收掉");
  ok("poisoned 后事件流异常:指引不自相矛盾,退出码不冒充成功");

  console.log("test:team-resilience ok");
} finally {
  healSessionWrites();
  // Windows 上 sqlite 的文件句柄不放,临时目录就删不掉(EBUSY),会把一次通过的测试
  // 报成失败。先关库再删。
  try {
    dbClient.close();
  } catch {
    /* 已经关了 */
  }
  rmSync(root, { recursive: true, force: true });
}
