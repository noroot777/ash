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
process.env.ASH_TEAM_STATUS_RETRY_MS = "40"; // 状态重试:别让测试干等 5 秒

// 真机 Codex stderr:同一条 thread 已经 poisoned,恢复它只会一次次撞同一堵墙。
const POISON = "ignored world-state patch without a full snapshot";

// env 要在这些模块被求值之前定好(db/paths 在模块顶层就读它们),所以走动态 import。
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { attachLead, haltTeam, sendInbound, teamIsLive } = await import("../src/team/session.js");
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
// 只让 tasks 的状态更新失败(sessions 照常可写)—— 复现「回合已经收了、库里还写着 running」。
const breakTaskWrites = () =>
  dbClient.executeMultiple(
    "CREATE TRIGGER injected_tasks_failure BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'injected idle status failure'); END;",
  );
const healTaskWrites = () => dbClient.executeMultiple("DROP TRIGGER IF EXISTS injected_tasks_failure;");

interface Scenario {
  /** 这台调度台开台时手上那条 CLI 会话 id(同时写进库)。 */
  cliSessionId: string;
  /** 按 consume 的消费节奏一条条放事件;generator 只有在上一条处理完才恢复执行, */
  /** 所以「装/拆故障」写在 yield 之间,天然排在前一条事件处理完之后。 */
  script: () => AsyncGenerator<AgentEvent>;
  /** events 流**还在线**时要断言的事(由 script 自己用 promise 卡住时机)。 */
  whileLive?: (taskId: string) => Promise<void>;
}

/** 组装一台调度台并挂上线。返回它的 handle 计数,方便断言「有没有往进程里塞过话」。 */
async function startLead(opts: {
  taskId: string;
  sessId: string;
  cliSessionId: string;
  events: AsyncGenerator<AgentEvent>;
  /** 复用一条已有的会话行(openLead 的 resuming 分支就是这么干的),而不是新插一行。 */
  reuse?: boolean;
}) {
  const row = {
    cliSessionId: opts.cliSessionId || null,
    resumeCommand: opts.cliSessionId ? `codex exec resume ${opts.cliSessionId}` : null,
    turnStartedAt: at,
    endedAt: null,
    exitStatus: null,
  };
  if (opts.reuse) await db.update(sessions).set(row).where(eq(sessions.id, opts.sessId));
  else {
    await db.insert(sessions).values({
      id: opts.sessId,
      taskId: opts.taskId,
      role: "lead",
      agentType: "codex",
      executor: "codex@test",
      cwd: root,
      startedAt: at,
      activeMs: 0,
      ...row,
    });
  }
  const runDir = join(root, "runs", opts.taskId);
  mkdirSync(runDir, { recursive: true });
  let sent = 0;
  let killed = 0;
  attachLead({
    taskId: opts.taskId,
    sessId: opts.sessId,
    cliSessionId: opts.cliSessionId,
    agentType: "codex",
    executorId: null,
    model: null,
    reasoningEffort: null,
    cwd: root,
    handle: {
      sessionId: opts.cliSessionId,
      commandLine: `codex exec resume ${opts.cliSessionId}`,
      events: opts.events,
      send: () => { sent++; },
      interrupt: () => {},
      dropSession: () => {},
      close: () => {},
      kill: () => { killed++; },
    },
    out: createWriteStream(join(runDir, `${opts.sessId}.md`), { flags: "a" }),
    busy: true,
    turnStart: at,
    pending: [],
    notices: [],
    pendingCredential: null,
    wantedStatus: null,
    statusTimer: null,
    retired: false,
    idleTimer: null,
    closing: null,
  });
  return {
    runDir,
    sent: () => sent,
    killed: () => killed,
  };
}

/** 建一条 mode:"team" 的任务行(状态 running,回合进行中)。 */
async function seedTeamTask(taskId: string) {
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
}

/** 起一台真的调度台,喂完 script 里的事件,等它自己收完台。 */
async function runLead(name: string, s: Scenario) {
  const taskId = `task-${name}`;
  const sessId = `sess-${name}`;
  await seedTeamTask(taskId);
  const { runDir, sent, killed } = await startLead({
    taskId,
    sessId,
    cliSessionId: s.cliSessionId,
    events: s.script(),
  });

  const deadline = Date.now() + 15_000;
  if (s.whileLive) await s.whileLive(taskId);
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
    sent,
    killed,
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

  // ── ④ 欠着凭据的那条会话随后被判 poisoned:欠账必须一起作废,不能把死会话复活 ──────
  // 前面两条各自成立,交叉起来却能互相拆台:②留下的欠账 + ③判死的会话。补写一旦成功,
  // 连 rotation 都会被翻篇,于是 closeLead 也不再清它 —— 用户看到的是「下次开全新会话」,
  // 库里却又指回那条刚判死的 thread,下一次原样再撞一次。
  const DOOMED = "fresh-thread-that-is-already-poisoned";
  const d = await runLead("credential-then-poison", {
    cliSessionId: "old-thread",
    script: async function* () {
      breakSessionWrites();
      yield { kind: "session", cliSessionId: DOOMED }; // 凭据没写进去,欠着
      healSessionWrites();
      yield { kind: "error", message: POISON, scope: "session" }; // 同一条会话随即判死
      yield { kind: "turnEnd" }; // 这一步会去补欠账 —— 绝不能补
      yield { kind: "done", exitStatus: 0 };
    },
  });
  const dRow = await d.session();
  assert.ok(d.md.includes(SESSION_POISONED_NOTE), "判死这件事要落盘");
  assert.equal(
    dRow.cliSessionId,
    null,
    "已经判死的会话凭据被补写回库 —— 说明里写着「下次开全新会话」,库里却指回同一条坏 thread",
  );
  assert.equal(dRow.resumeCommand, null, "恢复命令是由那个 id 派生的,同样不能留");
  ok("欠着的凭据随会话一起判死,不会被补写复活");

  // ── ⑤ 还没拿到会话 id 就异常:别承诺「会话还在,再说一句就能接回」 ────────────────
  const e = await runLead("abort-before-session", {
    cliSessionId: "", // fresh 调度台:CLI 还没报上任何 thread id
    script: async function* () {
      throw new Error("injected failure before any session event");
      // eslint-disable-next-line no-unreachable
      yield { kind: "done", exitStatus: 0 };
    },
  });
  assert.match(e.md, /调度台事件流异常中断/, "异常中断要如实写下来");
  assert.doesNotMatch(
    e.md,
    /会话还在|自动接回/,
    "手上压根没有会话 id,还说「再说一句话会自动接回」—— 用户照做只会开一条新会话,上下文一个字都回不来",
  );
  assert.match(e.md, /没有可续的 CLI 会话 id/, "没 id 时要明说下次是全新会话");
  assert.equal((await e.session()).cliSessionId, null, "这一路本来就没有 id 可落");
  ok("没拿到会话 id 就异常:如实说下次是全新会话");

  // ── ⑥ 落 idle 那一笔写库瞬时失败:必须补上,不能让任务永久显示 running ──────────────
  // 这一条跟前面几条最大的不同是**事件流全程在线**:常驻调度台收完一个回合就阻塞在
  // events 上,没有下一个自然的补写时机 —— 默认要等下一条消息或 30 分钟空闲回收,
  // ASH_TEAM_IDLE_MS<=0 时可以永远维持。而 tasks.status 是路由门禁、排队投递和页面按钮
  // 的共同真相源:用户看到「仍在跑/可停止」,依赖 idle 的后续动作也不会推进。
  let reachedIdle!: () => void;
  const turnSettled = new Promise<void>((r) => { reachedIdle = r; });
  let releaseStream!: () => void;
  const holdStream = new Promise<void>((r) => { releaseStream = r; });
  const f = await runLead("idle-status-write", {
    cliSessionId: "live-thread",
    script: async function* () {
      breakTaskWrites();
      yield { kind: "turnEnd" }; // 落 idle 这一笔会失败
      healTaskWrites(); // 瞬时故障:库这就好了
      reachedIdle();
      await holdStream; // events 流留在线上,让断言在「调度台还活着」时进行
      yield { kind: "done", exitStatus: 0 };
    },
    whileLive: async (taskId) => {
      await turnSettled;
      const until = Date.now() + 5_000;
      let status = "";
      while (Date.now() < until) {
        status = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!.status;
        if (status === "idle") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(teamIsLive(taskId), true, "这一条要在调度台还在线时验,别退化成「关台时顺手补上了」");
      assert.equal(
        status,
        "idle",
        "落 idle 写库失败后没人再补 —— 回合早收了,库里却一直写着 running,页面按钮和排队投递全按错的状态走",
      );
      releaseStream();
    },
  });
  healTaskWrites();
  assert.match(f.md, /调度台待命状态写入数据库失败/, "第一次失败要如实说出来");
  assert.equal((await f.task()).status, "idle", "收台后同样应是待命");
  ok("落 idle 写库瞬时失败:事件流在线时也会自己补上");

  // ── ⑦ 被接管的旧调度台:遗留的状态重试不许在新台退场后复活过期的 running ──────────
  // 上一条那套重试最容易坏的地方不是重试本身,是**「谁说了算」判错**:只看 leads 里此刻
  // 有没有人的话,新台正常收尾把自己摘牌之后 map 就是空的,旧台的计时器一到点就会把过期
  // 的 running 写回去。这一次没有任何在线调度台或下一个回合会来覆盖它 ——
  // teamIsLive=false 而库里写着 running,页面永远显示「运行中/可停止」。
  const HAND_OVER = "task-supersede-status";
  await seedTeamTask(HAND_OVER);
  let oldArmed!: () => void;
  const oldRetryArmed = new Promise<void>((r) => { oldArmed = r; });
  let releaseOld!: () => void;
  const holdOld = new Promise<void>((r) => { releaseOld = r; });
  async function* oldScript(): AsyncGenerator<AgentEvent> {
    breakTaskWrites();
    yield { kind: "turnEnd" }; // 攒着的执行者消息会立刻开下一回合 → 写 running,失败
    healTaskWrites();
    oldArmed();
    await holdOld; // 旧台的消费循环留在线上,还没轮到它收尾
    yield { kind: "done", exitStatus: 0 };
  }
  await startLead({ taskId: HAND_OVER, sessId: "sess-old", cliSessionId: "old-thread", events: oldScript() });
  // 让它这一回合有活要接着干:turnEnd 时会 beginTurn,那一笔 running 正好撞上故障。
  await sendInbound(HAND_OVER, "执行者汇报:干完了");
  await oldRetryArmed;

  // 新台接管,并且**先于**旧计时器到点正常收尾(写 idle 后把自己摘牌)。
  async function* newScript(): AsyncGenerator<AgentEvent> {
    yield { kind: "done", exitStatus: 0 };
  }
  await startLead({ taskId: HAND_OVER, sessId: "sess-new", cliSessionId: "new-thread", events: newScript() });
  const handOverDeadline = Date.now() + 15_000;
  while (teamIsLive(HAND_OVER) && Date.now() < handOverDeadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(teamIsLive(HAND_OVER), false, "新台应当已经收完台并摘牌");

  // 旧计时器现在到点。等足几个重试周期,它一个字都不该再写。
  await new Promise((r) => setTimeout(r, Number(process.env.ASH_TEAM_STATUS_RETRY_MS) * 5 + 200));
  releaseOld();
  while (teamIsLive(HAND_OVER) && Date.now() < handOverDeadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, Number(process.env.ASH_TEAM_STATUS_RETRY_MS) * 5 + 200));
  assert.equal(teamIsLive(HAND_OVER), false, "两台都收完了,不该还有人在线");
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, HAND_OVER))).at(0)!.status,
    "idle",
    "被接管的旧调度台把过期的 running 写了回去 —— 没有在线调度台了,这个假状态再也不会自愈",
  );
  ok("被接管的旧调度台不会在新台退场后复活过期状态");

  // ── ⑧ 同一条会话行被新台接管:晚到的旧收尾不许把它 finalize 掉 ────────────────────
  // 工作目录被抽走那条路上,openLead 的 resuming 分支**复用同一行 sessions**,并把
  // endedAt/exitStatus 清成 null 表示「这一段正在跑」。旧进程的 close 晚一步才到,它要是
  // 照常写 exitStatus/endedAt,页面就同时看到「调度台在线」和「这条会话已退出」;
  // activeMs 还会把两段重叠的墙钟时间重复计一遍。⑦ 用的是两条不同 session,钉不住这条。
  const SHARED = "task-shared-session-row";
  const SHARED_SESS = "sess-shared";
  await seedTeamTask(SHARED);
  let sharedOldReady!: () => void;
  const sharedOldWaiting = new Promise<void>((r) => { sharedOldReady = r; });
  let releaseSharedOld!: () => void;
  const holdSharedOld = new Promise<void>((r) => { releaseSharedOld = r; });
  async function* sharedOldScript(): AsyncGenerator<AgentEvent> {
    sharedOldReady();
    await holdSharedOld; // 新台接管之后才轮到它收尾
    yield { kind: "done", exitStatus: 7 };
  }
  await startLead({ taskId: SHARED, sessId: SHARED_SESS, cliSessionId: "old-thread", events: sharedOldScript() });
  await sharedOldWaiting;

  let releaseSharedNew!: () => void;
  const holdSharedNew = new Promise<void>((r) => { releaseSharedNew = r; });
  async function* sharedNewScript(): AsyncGenerator<AgentEvent> {
    await holdSharedNew; // 断言期间新台必须一直在线
    yield { kind: "done", exitStatus: 0 };
  }
  // 同一行会话被新进程接回:凭据换成新 thread,回合重新开着。
  await startLead({
    taskId: SHARED, sessId: SHARED_SESS, cliSessionId: "new-thread", events: sharedNewScript(), reuse: true,
  });
  releaseSharedOld();
  // 旧台收完台(它已被接管,leads 里仍是新台)。
  const sharedDeadline = Date.now() + 15_000;
  while (Date.now() < sharedDeadline) {
    const row = (await db.select().from(sessions).where(eq(sessions.id, SHARED_SESS))).at(0)!;
    if (row.endedAt || row.exitStatus !== null) break; // 坏掉了,下面的断言会说清楚
    await new Promise((r) => setTimeout(r, 20));
    if (Date.now() > sharedDeadline - 14_500) break; // 给旧台一点时间跑完 closeLead
  }
  await new Promise((r) => setTimeout(r, 200));
  const sharedRow = (await db.select().from(sessions).where(eq(sessions.id, SHARED_SESS))).at(0)!;
  assert.equal(teamIsLive(SHARED), true, "新台还该在线 —— 这一条要在「在线」和「已退出」能同时出现时验");
  assert.equal(
    sharedRow.endedAt,
    null,
    "被接管的旧调度台把共用的会话行 finalize 了 —— 页面同时看到「调度台在线」和「这条会话已退出」",
  );
  assert.equal(sharedRow.exitStatus, null, "旧进程的退出码混进了新进程正在用的那一行");
  assert.equal(sharedRow.cliSessionId, "new-thread", "新台刚报上来的凭据不能被晚到的旧收尾覆盖");
  releaseSharedNew();
  while (teamIsLive(SHARED) && Date.now() < sharedDeadline) await new Promise((r) => setTimeout(r, 20));
  ok("被接管的旧调度台不会把共用的会话行提前写成已结束");

  // ── ⑨ 用户点「停止全组」后的会话更正:是 system 旁注,不是红色执行诊断 ──────────────
  // 停止一个正常回合本身不是失败。可这一路必须补一句「刚才那条『再说一句就能接回』
  // 作废了」—— 要是照旧走 writeRunError,用户主动停一次就在时间线上收获一笔红色
  // 「执行异常」,正是这次改动想消除的症状。
  let haltReady!: () => void;
  const haltWaiting = new Promise<void>((r) => { haltReady = r; });
  let releaseHalt!: () => void;
  const holdHalt = new Promise<void>((r) => { releaseHalt = r; });
  const g = await runLead("halt-correction", {
    cliSessionId: "poisoned-thread",
    script: async function* () {
      yield { kind: "error", message: POISON, scope: "session" }; // 会话判死并清库成功
      haltReady();
      await holdHalt; // 等用户按下「停止全组」
      yield { kind: "done", exitStatus: 0 };
    },
    whileLive: async (taskId) => {
      await haltWaiting;
      await new Promise((r) => setTimeout(r, 50)); // 让上一条 poisoned 走完清库
      await haltTeam(taskId);
      releaseHalt();
    },
  });
  assert.match(g.md, /更正上面那条/, "会话已作废却不更正「再说一句就能接回」,用户照做只会再撞一次墙");
  assert.doesNotMatch(
    g.md,
    /^> .*更正上面那条/m,
    "用户主动停止一个正常回合,更正却写成了红色执行诊断 —— 时间线上凭空多一笔「执行异常」",
  );
  assert.match(
    g.md,
    /\x1e[^\n]*"t":"system"[^\n]*更正上面那条/,
    "更正要落成 system 旁注,刷新后才跟实时看到的是同一档",
  );
  assert.doesNotMatch(g.trace, /更正上面那条/, "这不是执行异常,不该记进执行过程面板");
  ok("停止全组后的会话更正走 system 旁注,不冒充执行异常");

  console.log("test:team-resilience ok");
} finally {
  healSessionWrites();
  healTaskWrites();
  // Windows 上 sqlite 的文件句柄不放,临时目录就删不掉(EBUSY),会把一次通过的测试
  // 报成失败。先关库再删。
  try {
    dbClient.close();
  } catch {
    /* 已经关了 */
  }
  rmSync(root, { recursive: true, force: true });
}
