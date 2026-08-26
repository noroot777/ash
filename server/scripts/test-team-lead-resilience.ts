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
import { parseSessionOutput } from "@ash/shared";
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
const { bus } = await import("../src/bus.js");
const { pendingInbound } = await import("../src/team/inbound-queue.js");
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
// 只让持久待送队列的 INSERT 失败 —— 复现「执行者汇报连排队都排不进去」。
const breakInboundWrites = () =>
  dbClient.executeMultiple(
    "CREATE TRIGGER injected_inbound_failure BEFORE INSERT ON team_inbound BEGIN SELECT RAISE(ABORT, 'injected team_inbound failure'); END;",
  );
const healInboundWrites = () => dbClient.executeMultiple("DROP TRIGGER IF EXISTS injected_inbound_failure;");

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
  /** 覆盖 handle 的收件行为:返回 false = 明确拒收,抛错 = 进程已经不可写。缺省全收。 */
  send?: (text: string) => boolean;
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
      send: (text: string) => {
        sent++; // 计的是**尝试**次数,拒收/抛错也算 —— 断言要分得清「没试」和「试了没进去」
        return opts.send ? opts.send(text) : true;
      },
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

  // ── ⑨ 「停止全组」之后才作废的会话:收尾必须更正,而且是 system 旁注不是红色诊断 ─────
  // 按下按钮那一刻会话还在,所以 haltTeam 照实写了「再说一句话就能接回同一会话」——
  // 紧接着 CLI 判死了这条会话。不补一句「上面那条不作数了」,用户刷新后看到的指引与真实
  // 状态正好相反,照做一次再撞一次墙。但停止一个正常回合本身不是失败:补的这一句要是照旧
  // 走 writeRunError,用户主动停一次就在时间线上收获一笔红色「执行异常」。
  // (会话在按下按钮**之前**就作废的那一档由 haltTeam 当场照实说,不留更正 ——
  //  test-team-session-notice.ts 从那头钉着。)
  let haltReady!: () => void;
  const haltWaiting = new Promise<void>((r) => { haltReady = r; });
  let releaseHalt!: () => void;
  const holdHalt = new Promise<void>((r) => { releaseHalt = r; });
  const g = await runLead("halt-correction", {
    cliSessionId: "poisoned-thread",
    script: async function* () {
      haltReady();
      await holdHalt; // 会话还好好的,用户先按下「停止全组」
      yield { kind: "error", message: POISON, scope: "session" }; // 按完才判死并清库成功
      yield { kind: "done", exitStatus: 0 };
    },
    whileLive: async (taskId) => {
      await haltWaiting;
      await haltTeam(taskId);
      releaseHalt();
    },
  });
  assert.match(g.md, /再说一句话就能把调度者接回同一会话/, "这一档的前提是按下按钮时会话还在,停止说明照实承诺了接回");
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

  // ── ⑩ 共用的 .md 与实时事件流:旧台不许插进新台还没说完的那一段 ──────────────────
  // 复用的不只是 sessions 行 —— .md 的文件名就是 sessId,两台开着同一个文件在写。旧台
  // 晚到的执行诊断和 agentEnd 插进去之后,parseSessionOutput 见到 agentEnd 就收口:用户
  // 的一条回复被切成两个气泡,前半段还被旧台的时间戳提前判了结束(用时也跟着错)。
  // 实时那头同样:旧进程的 done/error 顶着同一个 sessionId 广播,正看着新会话的用户会
  // 收到一条「执行异常结束」。
  const SHARED_MD = "task-shared-transcript";
  const SHARED_MD_SESS = "sess-shared-md";
  await seedTeamTask(SHARED_MD);
  const seen: AgentEvent[] = [];
  const unsubscribe = bus.subscribe((ev) => {
    if (ev.type === "agent.event" && ev.sessionId === SHARED_MD_SESS) seen.push(ev.event);
  });
  let releaseMdOld!: () => void;
  const holdMdOld = new Promise<void>((r) => { releaseMdOld = r; });
  async function* mdOldScript(): AsyncGenerator<AgentEvent> {
    await holdMdOld;
    yield { kind: "done", exitStatus: 7 }; // 非零退出:收尾会想写一笔执行诊断
  }
  const mdOld = await startLead({
    taskId: SHARED_MD, sessId: SHARED_MD_SESS, cliSessionId: "old-thread", events: mdOldScript(),
  });
  let mdNewSpoke!: () => void;
  const newHasSpoken = new Promise<void>((r) => { mdNewSpoke = r; });
  let releaseMdNew!: () => void;
  const holdMdNew = new Promise<void>((r) => { releaseMdNew = r; });
  async function* mdNewScript(): AsyncGenerator<AgentEvent> {
    yield { kind: "text", text: "NEW-REPLY-BEGIN" };
    mdNewSpoke();
    await holdMdNew; // 中间这段时间正是旧台收尾的窗口
    yield { kind: "text", text: "-AND-END" };
    yield { kind: "done", exitStatus: 0 };
  }
  await startLead({
    taskId: SHARED_MD, sessId: SHARED_MD_SESS, cliSessionId: "new-thread", events: mdNewScript(), reuse: true,
  });
  await newHasSpoken;
  releaseMdOld();
  // 旧台这就收尾。它要写的东西是同步落的,给足一个宽裕的窗口再让新台继续说。
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(teamIsLive(SHARED_MD), true, "断言要在新台还在线、这一段还没说完时进行");
  releaseMdNew();
  const mdDeadline = Date.now() + 15_000;
  while (teamIsLive(SHARED_MD) && Date.now() < mdDeadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  unsubscribe();

  const sharedMd = readFileSync(join(mdOld.runDir, `${SHARED_MD_SESS}.md`), "utf8");
  assert.doesNotMatch(sharedMd, /执行诊断/, "旧台把自己的执行诊断写进了新台正在用的 .md");
  const segments = parseSessionOutput(sharedMd).filter((seg) => seg.kind === "agent");
  assert.equal(
    segments.length,
    1,
    "新台的一条回复被旧台的 agentEnd 从中间截断了 —— 页面上会显示成两个气泡,前半段用时还被算错",
  );
  assert.match(segments[0].text, /NEW-REPLY-BEGIN[\s\S]*-AND-END/, "这一段回复必须完整");
  assert.deepEqual(
    seen.filter((e) => e.kind === "done").map((e) => e.exitStatus),
    [0],
    "旧进程的退出码顶着同一个 sessionId 广播出去了 —— 用户会看到新会话「执行异常结束」",
  );
  assert.deepEqual(seen.filter((e) => e.kind === "error"), [], "旧台的收尾诊断不该广播给正在看新会话的用户");
  ok("被接管的旧调度台不再污染共用的 .md 与实时事件流");

  // ── ⑪ 摘牌之后的 turnEnd:同样不许把在线的那条会话行写成已结束 ────────────────────
  // ⑧ 只让旧台直接 done,走的是 closeLead 那道闸。可旧进程完全可能在被接管之后还吐一条
  // turnEnd —— 那条路写的是同一行的 endedAt/activeMs,却从来没人挡过:新台明明在线,
  // 页面拿到的会话行已经标成结束,用时还被重复计了一遍。
  const LATE_TURN = "task-late-turn-end";
  const LATE_SESS = "sess-late-turn-end";
  await seedTeamTask(LATE_TURN);
  let lateOldReady!: () => void;
  const lateOldWaiting = new Promise<void>((r) => { lateOldReady = r; });
  let releaseLateOld!: () => void;
  const holdLateOld = new Promise<void>((r) => { releaseLateOld = r; });
  async function* lateOldScript(): AsyncGenerator<AgentEvent> {
    lateOldReady();
    await holdLateOld; // 等新台接管之后再收这个回合
    yield { kind: "turnEnd" };
    yield { kind: "done", exitStatus: 0 };
  }
  await startLead({ taskId: LATE_TURN, sessId: LATE_SESS, cliSessionId: "old-thread", events: lateOldScript() });
  await lateOldWaiting;
  let releaseLateNew!: () => void;
  const holdLateNew = new Promise<void>((r) => { releaseLateNew = r; });
  async function* lateNewScript(): AsyncGenerator<AgentEvent> {
    await holdLateNew;
    yield { kind: "done", exitStatus: 0 };
  }
  await startLead({
    taskId: LATE_TURN, sessId: LATE_SESS, cliSessionId: "new-thread", events: lateNewScript(), reuse: true,
  });
  releaseLateOld();
  await new Promise((r) => setTimeout(r, 400)); // 旧台这就走 turnEnd → closeLead
  const lateRow = (await db.select().from(sessions).where(eq(sessions.id, LATE_SESS))).at(0)!;
  assert.equal(teamIsLive(LATE_TURN), true, "这一条要在新台还在线时验");
  assert.equal(
    lateRow.endedAt,
    null,
    "摘牌的旧台用 turnEnd 把在线的会话行写成了已结束 —— 页面会显示这条会话已经退出",
  );
  assert.equal(lateRow.activeMs, 0, "旧回合的用时被累加进了新台正在用的那一行");
  assert.equal(lateRow.cliSessionId, "new-thread", "凭据仍应是新台报上来的那条");
  releaseLateNew();
  const lateDeadline = Date.now() + 15_000;
  while (teamIsLive(LATE_TURN) && Date.now() < lateDeadline) await new Promise((r) => setTimeout(r, 20));
  ok("摘牌之后的 turnEnd 不会把在线的会话行写成已结束");

  // ── ⑫ 摘牌时攒着的轮换旁注必须落盘,不能只活在 SSE ────────────────────────────────
  // 旁注为了不夹在正文和 agentEnd 之间,是先实时播、再攒着等收尾落盘的。换台把写流一断,
  // 「这条会话已作废、下次会丢上下文」这句话就只剩实时那一份:用户刷新一次,页面上再也
  // 看不出发生过什么 —— 正是本任务反复强调的「停下来的事必须持久可见」。
  const NOTICE_KEEP = "task-notice-on-handover";
  const NOTICE_SESS = "sess-notice-on-handover";
  await seedTeamTask(NOTICE_KEEP);
  let poisoned!: () => void;
  const poisonAnnounced = new Promise<void>((r) => { poisoned = r; });
  let releaseNoticeOld!: () => void;
  const holdNoticeOld = new Promise<void>((r) => { releaseNoticeOld = r; });
  async function* noticeOldScript(): AsyncGenerator<AgentEvent> {
    yield { kind: "error", message: POISON, scope: "session" }; // 旁注攒进 lead.notices
    poisoned();
    await holdNoticeOld;
    yield { kind: "done", exitStatus: 0 };
  }
  const noticeOld = await startLead({
    taskId: NOTICE_KEEP, sessId: NOTICE_SESS, cliSessionId: "poisoned-thread", events: noticeOldScript(),
  });
  await poisonAnnounced;
  await new Promise((r) => setTimeout(r, 50)); // 让那一轮清库和攒旁注走完
  let releaseNoticeNew!: () => void;
  const holdNoticeNew = new Promise<void>((r) => { releaseNoticeNew = r; });
  async function* noticeNewScript(): AsyncGenerator<AgentEvent> {
    await holdNoticeNew;
    yield { kind: "done", exitStatus: 0 };
  }
  await startLead({
    taskId: NOTICE_KEEP, sessId: NOTICE_SESS, cliSessionId: "new-thread", events: noticeNewScript(), reuse: true,
  });
  // 摘牌时就该把它落下去:此刻旧台还没收尾,新台也还在线。
  const noticeMdPath = join(noticeOld.runDir, `${NOTICE_SESS}.md`);
  const noticeDeadline = Date.now() + 10_000;
  let noticeMd = "";
  while (Date.now() < noticeDeadline) {
    try { noticeMd = readFileSync(noticeMdPath, "utf8"); } catch { /* 还没建出来 */ }
    if (noticeMd.includes(SESSION_POISONED_NOTE)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(teamIsLive(NOTICE_KEEP), true, "这一条要在新台还在线时验");
  assert.ok(
    noticeMd.includes(SESSION_POISONED_NOTE),
    "换台把攒着的轮换旁注丢了 —— 那句话只播给了正在看的人,刷新之后一个字都不剩",
  );
  releaseNoticeOld();
  releaseNoticeNew();
  while (teamIsLive(NOTICE_KEEP) && Date.now() < noticeDeadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  const finalNoticeMd = readFileSync(noticeMdPath, "utf8");
  assert.equal(
    finalNoticeMd.split(SESSION_POISONED_NOTE).length - 1,
    1,
    "同一条旁注落了两遍 —— 摘牌时补了一次,收尾时又写了一次",
  );
  ok("换台时攒着的轮换旁注照样落盘,刷新后还看得见");

  // ── ⑬ 换台时攒着的执行者汇报要跟着走,而且只送一次 ────────────────────────────────
  // 调度台忙着的时候,执行者的汇报/提问只进 lead.pending —— 既没送进 CLI,也没落盘(要等
  // endTurn 合并投递时才 recordSystemTurn)。工作目录被抽走那条路会当场摘牌并杀掉旧进程,
  // 那批消息就烂在一个已经出局的对象里:新台在线、页面刷新,一份执行结果或一个待回答的
  // 提问无声消失,调度者接着在缺这些事实的情况下做决定。
  // 反过来也得钉住:搬走时不从旧台清空的话,晚一步到的 turnEnd 会照原样再送一遍。
  const PENDING_KEEP = "task-pending-on-handover";
  const PENDING_SESS = "sess-pending-on-handover";
  const WORKER_REPORT = "执行者汇报:这条必须活过换台";
  await seedTeamTask(PENDING_KEEP);
  let releasePendingOld!: () => void;
  const holdPendingOld = new Promise<void>((r) => { releasePendingOld = r; });
  async function* pendingOldScript(): AsyncGenerator<AgentEvent> {
    await holdPendingOld; // 等新台接管之后再收这个回合
    yield { kind: "turnEnd" }; // 晚到的收尾:没清空的话会把同一条汇报再送一次
    yield { kind: "done", exitStatus: 0 };
  }
  const pendingOld = await startLead({
    taskId: PENDING_KEEP, sessId: PENDING_SESS, cliSessionId: "old-thread", events: pendingOldScript(),
  });
  await sendInbound(PENDING_KEEP, WORKER_REPORT); // 旧台正忙 → 只进 pending,没进 CLI 也没落盘
  let releasePendingNew!: () => void;
  const holdPendingNew = new Promise<void>((r) => { releasePendingNew = r; });
  async function* pendingNewScript(): AsyncGenerator<AgentEvent> {
    yield { kind: "turnEnd" }; // 新台这一回合收尾 —— 攒着的汇报该在这儿合并送出去
    await holdPendingNew;
    yield { kind: "done", exitStatus: 0 };
  }
  const pendingNew = await startLead({
    taskId: PENDING_KEEP, sessId: PENDING_SESS, cliSessionId: "new-thread", events: pendingNewScript(), reuse: true,
  });
  releasePendingOld();
  const pendingDeadline = Date.now() + 10_000;
  while (pendingNew.sent() === 0 && Date.now() < pendingDeadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200)); // 给旧台那条晚到的 turnEnd 走完的时间
  assert.equal(teamIsLive(PENDING_KEEP), true, "这一条要在新台还在线时验");
  assert.equal(
    pendingNew.sent(),
    1,
    "换台把攒着的执行者汇报丢了 —— 那份执行结果/待回答的提问既没进 CLI 也没落盘,调度者不知道它发生过",
  );
  assert.equal(
    pendingOld.sent(),
    0,
    "搬走时没从旧台清空 —— 晚到的 turnEnd 把同一条汇报又塞进了那个已经出局(且已被杀)的 handle",
  );
  releasePendingNew();
  while (teamIsLive(PENDING_KEEP) && Date.now() < pendingDeadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  const pendingMd = readFileSync(join(pendingOld.runDir, `${PENDING_SESS}.md`), "utf8");
  assert.equal(
    pendingMd.split(WORKER_REPORT).length - 1,
    1,
    "这条汇报在共用的 .md 里只该出现一次 —— 刷新后看得见,又不能重复成两条",
  );
  ok("换台时攒着的执行者汇报跟着走,只送一次且刷新后看得见");

  // ── ⑭ 接手的那台没送成:这批汇报要继续往下传,而且 .md 里只留一条 ────────────────────
  // ⑬ 只覆盖了「接手的那台一切正常」。可 endTurn 原来是先清队列、先落盘再 send —— 而
  // send 完全可能拒收:codex 在 ended||closing 时直接返回,claude 在 stdin 已关时写不进去,
  // 两个都不抛错。那一步之后队列已经空了,closeLead 想把汇报交回托盘都拿不到东西:第三台
  // 健康调度台在线却一个字都收不到,自动协作接着在缺执行结果的情况下往下做决定。
  const RESEND = "task-pending-resend";
  const RESEND_SESS = "sess-pending-resend";
  const RESEND_REPORT = "执行者汇报:第一台没送成也不许丢";
  await seedTeamTask(RESEND);
  let releaseResendOld!: () => void;
  const holdResendOld = new Promise<void>((r) => { releaseResendOld = r; });
  async function* resendOldScript(): AsyncGenerator<AgentEvent> {
    await holdResendOld;
    yield { kind: "done", exitStatus: 0 };
  }
  const resendOld = await startLead({
    taskId: RESEND, sessId: RESEND_SESS, cliSessionId: "old-thread", events: resendOldScript(),
  });
  await sendInbound(RESEND, RESEND_REPORT); // 旧台正忙 → 只进 pending
  // 接管的第二台认领了这条汇报,可它的进程已经不可写了。
  async function* brokenScript(): AsyncGenerator<AgentEvent> {
    yield { kind: "turnEnd" }; // 就在这儿投递,而它送不出去
    yield { kind: "done", exitStatus: 0 };
  }
  const broken = await startLead({
    taskId: RESEND, sessId: RESEND_SESS, cliSessionId: "broken-thread", events: brokenScript(), reuse: true,
    send: () => { throw new Error("resident handle is no longer writable"); },
  });
  releaseResendOld();
  const resendDeadline = Date.now() + 15_000;
  while (teamIsLive(RESEND) && Date.now() < resendDeadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(broken.sent(), 1, "第二台该试着投递一次");
  // 第三台健康调度台接手,这批汇报必须落到它手上。
  let releaseThird!: () => void;
  const holdThird = new Promise<void>((r) => { releaseThird = r; });
  async function* thirdScript(): AsyncGenerator<AgentEvent> {
    yield { kind: "turnEnd" };
    await holdThird;
    yield { kind: "done", exitStatus: 0 };
  }
  const third = await startLead({
    taskId: RESEND, sessId: RESEND_SESS, cliSessionId: "third-thread", events: thirdScript(), reuse: true,
  });
  while (third.sent() === 0 && Date.now() < resendDeadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(teamIsLive(RESEND), true, "这一条要在第三台还在线时验");
  assert.equal(
    third.sent(),
    1,
    "上一台没送成的执行者汇报没能接着往下传 —— 第三台健康调度台在线却一个字都没收到",
  );
  releaseThird();
  while (teamIsLive(RESEND) && Date.now() < resendDeadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  const resendMd = readFileSync(join(resendOld.runDir, `${RESEND_SESS}.md`), "utf8");
  assert.equal(
    resendMd.split(RESEND_REPORT).length - 1,
    1,
    "同一条汇报在 .md 里出现了两次 —— 没送成的那一次也当「已投递」记了一笔",
  );
  assert.match(resendMd, /没能送进调度台进程/, "投递失败这件事必须持久可见,不能只在日志里");
  ok("接手的调度台没送成时,汇报继续往下传且只落盘一次");

  // ── ⑮ 待送队列写库瞬时失败:消息不丢,库一恢复就补上,失败本身也看得见 ────────────────
  // 持久化本身也会失败。而这条投递链是 fire-and-forget 的(执行者结算侧只
  // `notifyTeamLead(...).catch(console.error)`),异常抛出去只剩一行控制台日志:内存里没有、
  // 库里也没有、.md 和 SSE 一个字都没有,而执行者已经结算,再没有任何补送入口 —— 一次瞬时
  // 故障就永久吃掉一份执行结果或一个待回答的提问。
  const ENQ = "task-inbound-enqueue-fail";
  const ENQ_SESS = "sess-inbound-enqueue-fail";
  const ENQ_REPORT = "执行者汇报:入队写库失败也不许丢";
  await seedTeamTask(ENQ);
  let releaseEnq!: () => void;
  const holdEnq = new Promise<void>((r) => { releaseEnq = r; });
  async function* enqScript(): AsyncGenerator<AgentEvent> {
    await holdEnq; // 等这条汇报撞上写库故障、并且库已经恢复
    yield { kind: "turnEnd" }; // 这一步要把它补进队列,再合并送出去
    yield { kind: "done", exitStatus: 0 };
  }
  const enq = await startLead({
    taskId: ENQ, sessId: ENQ_SESS, cliSessionId: "enq-thread", events: enqScript(),
  });
  breakInboundWrites();
  await assert.doesNotReject(
    () => sendInbound(ENQ, ENQ_REPORT),
    "写库失败把整条投递链掀了 —— 上游是 fire-and-forget 的,异常只会变成一行控制台日志",
  );
  healInboundWrites(); // 瞬时故障:库这就好了
  releaseEnq();
  const enqDeadline = Date.now() + 15_000;
  while (teamIsLive(ENQ) && Date.now() < enqDeadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(
    enq.sent(),
    1,
    "入队写库失败后这条汇报就此消失 —— 内存里没有、库里也没有,调度者永远不知道它发生过",
  );
  const enqMd = readFileSync(join(enq.runDir, `${ENQ_SESS}.md`), "utf8");
  assert.equal(enqMd.split(ENQ_REPORT).length - 1, 1, "这条汇报在 .md 里只该出现一次");
  assert.match(enqMd, /写入待送队列失败/, "写库失败必须持久可见,不能只在控制台日志里");
  assert.equal(
    (await pendingInbound(ENQ)).length,
    0,
    "库恢复后补进队列的那一行,送成之后同样要销账",
  );
  ok("待送队列写库瞬时失败:消息留在内存照送,库一恢复就补上,失败也看得见");

  // ── ⑯ 库恢复之后,只剩内存副本的那条必须重新变成持久的 ──────────────────────────────
  // ⑮ 那一路运气好:同一台调度台当场就把它送出去了,内存副本够用。可要是这一回合送不出去
  // (进程正在收尾),它就得接着等下一台 —— 这时候「只有内存一份」和「已经回到队列里」的
  // 区别就是 server 一重启还在不在。所以库一恢复就得把欠账补回队列,别等到需要它的时候。
  const REQ = "task-inbound-requeue";
  const REQ_SESS = "sess-inbound-requeue";
  const REQ_REPORT = "执行者汇报:库一恢复就该重新变成持久的";
  await seedTeamTask(REQ);
  let releaseReqA!: () => void;
  const holdReqA = new Promise<void>((r) => { releaseReqA = r; });
  async function* reqAScript(): AsyncGenerator<AgentEvent> {
    await holdReqA;
    yield { kind: "turnEnd" }; // 补队列就在这一步;紧接着的投递会被拒收
    yield { kind: "done", exitStatus: 0 };
  }
  const reqA = await startLead({
    taskId: REQ, sessId: REQ_SESS, cliSessionId: "requeue-a", events: reqAScript(),
    send: () => false, // 这台的进程已经在收尾:明确拒收
  });
  breakInboundWrites();
  await sendInbound(REQ, REQ_REPORT);
  healInboundWrites();
  releaseReqA();
  const reqDeadline = Date.now() + 15_000;
  while (teamIsLive(REQ) && Date.now() < reqDeadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(reqA.sent(), 1, "这台该试着投递一次");
  assert.equal(
    (await pendingInbound(REQ)).length,
    1,
    "库恢复后没把只剩内存副本的那条补回队列 —— 这条消息还得等下一台,而 server 一重启它就没了",
  );
  let releaseReqB!: () => void;
  const holdReqB = new Promise<void>((r) => { releaseReqB = r; });
  async function* reqBScript(): AsyncGenerator<AgentEvent> {
    yield { kind: "turnEnd" };
    await holdReqB;
    yield { kind: "done", exitStatus: 0 };
  }
  const reqB = await startLead({
    taskId: REQ, sessId: REQ_SESS, cliSessionId: "requeue-b", events: reqBScript(), reuse: true,
  });
  while (reqB.sent() === 0 && Date.now() < reqDeadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(reqB.sent(), 1, "补回队列的那条汇报没能交给下一台健康调度台");
  releaseReqB();
  while (teamIsLive(REQ) && Date.now() < reqDeadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  const reqMd = readFileSync(join(reqA.runDir, `${REQ_SESS}.md`), "utf8");
  assert.equal(reqMd.split(REQ_REPORT).length - 1, 1, "这条汇报在 .md 里只该出现一次");
  assert.equal((await pendingInbound(REQ)).length, 0, "送成之后要销账");
  ok("库恢复后欠账补回队列,下一台照样能拿到且只送一次");

  // ── ⑰ 库一直不恢复:内存那一份也得跟着换台走,不能跟着旧台一起没 ────────────────────
  // ⑯ 里库很快就好了,欠账补回队列就有下一台去认领。可要是库一直拒收,这条消息**只有内存
  // 这一份** —— 摘牌时它没有持久的地方可去,再不接住就是当场丢掉。重启仍然会丢(那是数据库
  // 拒收的直接后果,已经如实说过了),但同一个进程里的换台没有任何理由丢。
  const KEEP = "task-inbound-memory-handover";
  const KEEP_SESS = "sess-inbound-memory-handover";
  const KEEP_REPORT = "执行者汇报:库一直坏着也得跟着换台走";
  await seedTeamTask(KEEP);
  let releaseKeepA!: () => void;
  const holdKeepA = new Promise<void>((r) => { releaseKeepA = r; });
  async function* keepAScript(): AsyncGenerator<AgentEvent> {
    await holdKeepA;
    yield { kind: "turnEnd" }; // 补队列还是失败,投递又被拒收 —— 只剩内存那一份
    yield { kind: "done", exitStatus: 0 };
  }
  const keepA = await startLead({
    taskId: KEEP, sessId: KEEP_SESS, cliSessionId: "keep-a", events: keepAScript(),
    send: () => false,
  });
  breakInboundWrites(); // 这一路全程不恢复
  await sendInbound(KEEP, KEEP_REPORT);
  releaseKeepA();
  const keepDeadline = Date.now() + 15_000;
  while (teamIsLive(KEEP) && Date.now() < keepDeadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await pendingInbound(KEEP)).length, 0, "库还坏着,这一条本来就进不了队列");
  let releaseKeepB!: () => void;
  const holdKeepB = new Promise<void>((r) => { releaseKeepB = r; });
  async function* keepBScript(): AsyncGenerator<AgentEvent> {
    yield { kind: "turnEnd" };
    await holdKeepB;
    yield { kind: "done", exitStatus: 0 };
  }
  const keepB = await startLead({
    taskId: KEEP, sessId: KEEP_SESS, cliSessionId: "keep-b", events: keepBScript(), reuse: true,
  });
  while (keepB.sent() === 0 && Date.now() < keepDeadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    keepB.sent(),
    1,
    "写不进库的那条汇报跟着旧台一起没了 —— 同一个进程里换个台而已,没有任何理由丢",
  );
  releaseKeepB();
  while (teamIsLive(KEEP) && Date.now() < keepDeadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  healInboundWrites();
  const keepMd = readFileSync(join(keepA.runDir, `${KEEP_SESS}.md`), "utf8");
  assert.equal(keepMd.split(KEEP_REPORT).length - 1, 1, "这条汇报在 .md 里只该出现一次");
  ok("库一直坏着:内存那一份也跟着换台走,只送一次");

  console.log("test:team-resilience ok");
} finally {
  healSessionWrites();
  healTaskWrites();
  healInboundWrites();
  // Windows 上 sqlite 的文件句柄不放,临时目录就删不掉(EBUSY),会把一次通过的测试
  // 报成失败。先关库再删。
  try {
    dbClient.close();
  } catch {
    /* 已经关了 */
  }
  rmSync(root, { recursive: true, force: true });
}
