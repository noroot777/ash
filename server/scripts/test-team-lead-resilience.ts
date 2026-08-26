import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { parseSessionOutput } from "@ash/shared";
import {
  POISON, root, db, dbClient, ensureSchema, projects, sessions, tasks,
  haltTeam, sendInbound, teamIsLive, bus, SESSION_POISONED_NOTE, eq, at, ok,
  breakSessionWrites, healSessionWrites, breakTaskWrites, healTaskWrites,
  startLead, seedTeamTask, runLead,
} from "./team-lead-resilience-fixture.js";

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

  console.log("test:team-resilience core ok");
} finally {
  healSessionWrites();
  healTaskWrites();
  try {
    dbClient.close();
  } catch {
    /* 已经关了 */
  }
  rmSync(root, { recursive: true, force: true });
}
