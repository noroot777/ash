// 常驻调度台:一次写库失败不能掀掉整台调度台。
//
// 起因(2026-08-25 第 2 轮审查):轮换旁注改成「实时先播、落盘攒到 writeTurnEnd 之后」
// 以后,team 那条链的 flush 排在 endTurn 的 `db.update(sessions)` **后面**。那一行
// 写库跑在 consume 的 for-await 里,一抛就是整条循环退出,而不是一个回合失败:
//   • writeTurnEnd / flushSessionNotices 都没跑 → .md 里没有轮换旁注,用户一刷新
//     什么都看不到,还会照着旧指引去重试那条已经作废的会话;
//   • setTaskStatus(idle) 没跑 → 任务永远停在 running;
//   • closeLead 整个被跳过 → leads 里留着一台**假在线**调度台:后续消息照送进去,
//     但没人再消费它的事件,一个字都不落盘也不广播,只能靠重启恢复。
//
// 所以这里不是结构 grep,而是**真的让那一行写库失败**(SQLite 触发器 RAISE(ABORT)),
// 再从落盘的 .md、任务状态和 leads 在线判定上确认三件事都没塌。
//
// 跑:npm -w server run test:team-resilience
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import type { ResidentHandle } from "../src/executors/types.js";

const root = mkdtempSync(join(tmpdir(), "ash-team-resilience-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_TEAM_IDLE_MS = "0"; // 别在测试里挂一个 30 分钟的回收计时

const TASK = "team-lead";
const SESS = "lead-session";
// 真机 Codex stderr:同一条 thread 已经 poisoned,恢复它只会一次次撞同一堵墙。
const POISON = "ignored world-state patch without a full snapshot";

// env 要在这些模块被求值之前定好(db/paths 在模块顶层就读它们),所以走动态 import。
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { attachLead, teamIsLive } = await import("../src/team/session.js");
const { SESSION_POISONED_NOTE } = await import("../src/executors/session-lost.js");
const { createWriteStream } = await import("node:fs");
const { eq } = await import("drizzle-orm");

try {
  await ensureSchema();

  const at = "2026-08-25T00:00:00.000Z";
  await db.insert(projects).values({ id: "project", name: "team-resilience", repoPath: root, createdAt: at });
  await db.insert(tasks).values({
    id: TASK,
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
    id: SESS,
    taskId: TASK,
    role: "lead",
    agentType: "codex",
    executor: "codex@test",
    cwd: root,
    cliSessionId: "poisoned-thread",
    resumeCommand: "codex exec resume poisoned-thread",
    startedAt: at,
    turnStartedAt: at,
    activeMs: 0,
    exitStatus: null,
  });

  const runDir = join(root, "runs", TASK);
  mkdirSync(runDir, { recursive: true });

  // 让 sessions 的 UPDATE **真的**失败,tasks 照常可写 —— 精确复现审查里那条路径:
  // 回合收尾那一行写不进去,后面的落盘/落 idle 本该照常走完。
  const breakSessionWrites = () =>
    dbClient.executeMultiple(
      "CREATE TRIGGER injected_sessions_failure BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'injected sessions failure'); END;",
    );
  const healSessionWrites = () => dbClient.executeMultiple("DROP TRIGGER IF EXISTS injected_sessions_failure;");

  let sent = 0;
  let killed = 0;
  // 事件按 consume 的消费节奏一条条放出来:generator 只有在上一条被处理完、循环回头
  // 要下一条时才恢复执行,所以「装故障」这一步天然排在第一条事件处理完之后。
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { kind: "error", message: POISON, scope: "session" };
    breakSessionWrites();
    yield { kind: "turnEnd" };
    yield { kind: "done", exitStatus: 0 };
  }
  const handle: ResidentHandle = {
    sessionId: "poisoned-thread",
    commandLine: "codex exec resume poisoned-thread",
    events: events(),
    send: () => { sent++; },
    interrupt: () => {},
    dropSession: () => {},
    close: () => {},
    kill: () => { killed++; },
  };

  attachLead({
    taskId: TASK,
    sessId: SESS,
    cliSessionId: "poisoned-thread",
    agentType: "codex",
    executorId: null,
    model: null,
    reasoningEffort: null,
    cwd: root,
    handle,
    out: createWriteStream(join(runDir, `${SESS}.md`), { flags: "a" }),
    busy: true,
    turnStart: at,
    pending: [],
    notices: [],
    idleTimer: null,
    closing: null,
  });

  const deadline = Date.now() + 10_000;
  while (teamIsLive(TASK) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    teamIsLive(TASK),
    false,
    "写库失败后 leads 里还挂着这台调度台 —— 消费循环已经退出,后续消息会被送进一个没人听的 handle",
  );

  // .md 由 WriteStream 写,end() 之后才保证落到磁盘;上面等的是 leads 摘牌,再等一下正文。
  const mdPath = join(runDir, `${SESS}.md`);
  const readMd = () => { try { return readFileSync(mdPath, "utf8"); } catch { return ""; } };
  while (!readMd().includes(SESSION_POISONED_NOTE) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const md = readMd();
  healSessionWrites();

  assert.ok(
    md.includes(SESSION_POISONED_NOTE),
    "回合收尾写库失败时轮换旁注没落盘 —— 用户刷新后看不到会话已作废,会照着旧指引再撞一次墙",
  );
  assert.match(md, /回合收尾状态写入数据库失败/, "写库失败必须如实说出来,不能咽掉");
  assert.match(
    readFileSync(join(runDir, `${SESS}.trace.jsonl`), "utf8"),
    /回合收尾状态写入数据库失败/,
    "执行过程面板同样要看得到这次失败",
  );

  const task = (await db.select().from(tasks).where(eq(tasks.id, TASK))).at(0)!;
  assert.equal(task.status, "idle", "写库失败后任务卡在 running,界面上会永远显示它在干活");

  assert.equal(sent, 0, "这一路没有待送消息,不该凭空往已经收掉的进程里塞话");
  assert.equal(killed, 0, "每一步写库失败都各自兜住了,不该走到掀翻消费循环那条兜底");

  console.log("test:team-resilience ok");
} finally {
  // Windows 上 sqlite 的文件句柄不放,临时目录就删不掉(EBUSY),会把一次通过的测试
  // 报成失败。先关库再删。
  try {
    dbClient.close();
  } catch {
    /* 已经关了 */
  }
  rmSync(root, { recursive: true, force: true });
}
