import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import {
  POISON, root, db, dbClient, ensureSchema, projects, sessions,
  sendInbound, teamIsLive, pendingInbound, SESSION_POISONED_NOTE, eq, at, ok,
  breakInboundWrites, healInboundWrites, startLead, seedTeamTask,
} from "./team-lead-resilience-fixture.js";

try {
  await ensureSchema();
  await db.insert(projects).values({ id: "project", name: "team-resilience-inbound", repoPath: root, createdAt: at });
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

  console.log("test:team-resilience inbound ok");
} finally {
  healInboundWrites();
  try {
    dbClient.close();
  } catch {
    /* 已经关了 */
  }
  rmSync(root, { recursive: true, force: true });
}
