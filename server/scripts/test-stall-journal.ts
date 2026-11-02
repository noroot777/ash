// 熔断判决的**落盘事实**那一层:日志本身,以及「存住了没有」这个结论怎么一路传到用户眼前。
// 跑:npm -w server run test:stall-journal
//
// 起因(第 4 轮审查 F1,已实测两个独立消费进程):判决原先只写库那一格,而库的写要过
// `whenIdle`(db/node-sqlite-client.ts:写不许借别人的事务)—— 别人开着长事务时这条 UPDATE
// 排在队里,既没抛错也没落盘。而判决作出之后紧接着就是不可撤销的两件事(时间线上写「已终止
// 本回合并按失败结算」、向执行器发终止请求)。消费者在这段窗口退出,排着的写和内存判决一起
// 消失,下一个进程读到 `stall_reason=NULL` 就把它解释成「没熔断过」。
//
// 根上错的那条判据是**「调了持久化函数」=「事实已经持久」**。所以这份文件钉的是改过之后的
// 契约本身:
//   ① 事实落在一个不可能排在别人事务后面的地方(另一个文件、同步写、写完 fsync);
//   ② **「读不出来」跟「没有」是两件事**(第 5 轮审查 F1:上一版的 `parseRecords` 把权限失败、
//      I/O 错误、半行坏记录统统归约成空数组 —— 新的权威日志沿用了旧实现那个不可靠的缺省值);
//   ③ 压缩的保留条件只能是「这一轮已经确凿结算完了」,不能是条数、年龄,**也不能是回合区间
//      收口了**(第 5 轮审查 F2 + 第 1 轮审查 F1:后者实测过「区间已 failed、任务仍 running」那个
//      窗口 —— 区间收口只证明执行流结束,不证明任务落位);所以销账是日志自己的一种记录;
//   ④ 落盘失败**如实报失败**,不许假装成功;
//   ⑤ `markStallFailure` 的返回值就是落盘结果,三档各自什么意思;加上启动装载;
//   ⑥ 没存住那一档,熔断诊断里**要如实多说一句** —— 不然用户看到「已终止」、重启后又看到
//      「已完成」,而他没有任何线索。
//
// 跨进程那一半(真 `consumeSingleRun`、真库被事务占着、真的换一个进程接管)在
// test-stall-restart.ts;这里一个字都不碰库。
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 兜底:万一哪条默认参数路径没显式传库文件,也只会落在临时目录里,不可能挨着生产库。
const stage = mkdtempSync(join(tmpdir(), "ash-stall-journal-"));
process.env.ASH_DB = join(stage, "journal.db");

const {
  __seedStallVerdict, appendStallDischarge, appendStallVerdict, compactStallJournal, pendingStallVerdicts,
  readStallJournal, stallJournalFileForDb,
} = await import("../src/turn-stall-journal.js");
const {
  __resetStallFailures, loadStallFailures, markStallFailure, setStallVerdictPersister, stallFailure,
} = await import("../src/turn-stall-verdict.js");
const { trackTurnStall } = await import("../src/turn-stall.js");
const { configure, notice, sleep, spy, TURN } = await import("./stall-fixtures.js");

const TURN2 = "2026-10-30T09:00:00.000Z";

/** 读一个回合身份上最后那条判决 —— 读的一侧只认「全集 + 状态」,这个只是测试里的取数糖。 */
const verdictOf = (sessionId: string, turnStartedAt: string, dbFile: string) =>
  pendingStallVerdicts(readStallJournal(dbFile))
    .filter((r) => r.sessionId === sessionId && r.turnStartedAt === turnStartedAt).at(-1) ?? null;

// ── ① 落盘与读回 ────────────────────────────────────────────────────────────────
{
  const dbFile = join(stage, "read.db");
  // 文件压根不在 = **确实没有判决**,这一档必须是 ok(不是「读不出来」):否则每台新装的 ash
  // 第一次启动都在喊「核不了自己的判决」,那句警告立刻变成噪音。
  const empty = readStallJournal(dbFile);
  assert.equal(empty.status, "ok", "日志文件不存在被当成了读取故障");
  assert.deepEqual(empty.verdicts, [], "空日志里读出了判决");
  assert.deepEqual(empty.discharges, [], "空日志里读出了销账记录");
  assert.equal(appendStallVerdict({ at: "t0", sessionId: "s", turnStartedAt: TURN, reason: "第一次" }, dbFile), true);
  assert.equal(verdictOf("s", TURN, dbFile)?.reason, "第一次");
  // 键是**回合身份**,不是 sessionId:一条会话跑很多轮,只有熔断掉的那一轮算失败。
  assert.equal(verdictOf("s", TURN2, dbFile), null, "同一会话的另一轮也被判了失败");
  assert.equal(verdictOf("other", TURN, dbFile), null, "另一条会话也被判了失败");
  // 同一身份写了两次(接管后又熔断一次)取最后那条 —— 新判决该盖住旧的。
  appendStallVerdict({ at: "t1", sessionId: "s", turnStartedAt: TURN, reason: "第二次" }, dbFile);
  assert.equal(verdictOf("s", TURN, dbFile)?.reason, "第二次", "读到的不是最新那条判决");
  // 整条记录都得落全(F4:短写时 `writeSync` 不一定抛,按字节数自己核)。
  const line = readFileSync(stallJournalFileForDb(dbFile), "utf8").split("\n").filter(Boolean).at(-1)!;
  assert.deepEqual(JSON.parse(line).reason, "第二次", "落盘的那一行不是一条完整记录");
}

// ── ② 「读不出来」≠「没有」 ────────────────────────────────────────────────────
// 第 5 轮审查 F1 的根:上一版把权限失败、I/O 错误、半行坏记录统统归约成「空」,于是接管一个
// 仍然存活的回合时恢复静默失败,上游一恢复这一轮就记成 completed、任务落 done,而用户那边
// 「已自动终止本回合」的红字还在。
{
  // (a) 整个文件读不出来(权限):status 必须是 unavailable。
  const dbFile = join(stage, "eacces.db");
  const file = stallJournalFileForDb(dbFile);
  appendStallVerdict({ at: "t0", sessionId: "s", turnStartedAt: TURN, reason: "读不到我" }, dbFile);
  chmodSync(file, 0o000);
  try {
    const read = readStallJournal(dbFile);
    assert.equal(read.status, "unavailable", "日志读不出来被当成了「没有判决」—— 那一轮会升级成成功");
    assert.match(read.status === "unavailable" ? read.why : "", /eacces|permission/i, "没说清为什么读不出来");
  } finally {
    chmodSync(file, 0o600);
  }
  // 权限修好之后照样读得出来(上一步没破坏内容)。
  assert.equal(readStallJournal(dbFile).status, "ok");

  // (b) 半行坏记录:**好的那些照常读出来**,但整次读取仍然是 unavailable —— 丢了一条就不能
  // 再对任何一轮说「它没被判失败」。
  const partial = join(stage, "partial.db");
  appendStallVerdict({ at: "t0", sessionId: "good", turnStartedAt: TURN, reason: "完好" }, partial);
  appendFileSync(stallJournalFileForDb(partial), '\n{"at":"t1","sessionId":"half"\n');
  const damaged = readStallJournal(partial);
  assert.equal(damaged.status, "unavailable", "半行坏记录被静默跳过了");
  assert.deepEqual(damaged.verdicts.map((r) => r.sessionId), ["good"], "坏行把同一份日志里完好的判决也带走了");
}

// ── ③ 压缩:保留条件只能是「这一轮确凿结算完了」 ────────────────────────────────
// 第 5 轮审查 F2(日志那一侧已实测):上一版按条数轮转,第二次轮转直接覆盖上一代 —— 实测保留
// 一个「已判失败、库投影没写进去、区间仍开着」的目标回合,连续建两代各 201 条之后那条判决就没了。
// `rename` 原子、不读改写,但那**不证明被覆盖的上一代已经没人需要**。同一个类问题在内存那侧被
// 打回过两次(条数水位、年龄 TTL),判据见 turn-stall-verdict.ts。
{
  const dbFile = join(stage, "compact.db");
  const file = stallJournalFileForDb(dbFile);
  appendStallVerdict({ at: "t0", sessionId: "still-open", turnStartedAt: TURN, reason: "还没结算" }, dbFile);
  for (let i = 0; i < 400; i += 1) {
    __seedStallVerdict({ sessionId: `settled-${i}`, turnStartedAt: TURN }, dbFile);
    appendStallDischarge(`settled-${i}`, TURN, dbFile);
  }
  // 条数远超过任何水位,但保留条件只认「销账了没有」。
  const result = compactStallJournal(dbFile);
  assert.deepEqual(result, { kept: 1, dropped: 800 }, "压缩的账算错了(400 条判决 + 400 条销账都该清掉)");
  assert.equal(verdictOf("still-open", TURN, dbFile)?.reason, "还没结算",
    "压缩把一条还没销账的判决清掉了 —— 那一轮收到结束回执时会被记成正常完成");
  assert.equal(verdictOf("settled-0", TURN, dbFile), null, "已经销账的没清掉");
  assert.equal(existsSync(`${file}.1`), false, "压缩之后上一代还留着");

  // **销账之前它一直算数**,哪怕回合区间早就收口了:上一版的判据正是「区间收口 ⇒ 可以扔」,
  // 而执行流结束不证明任务落位(第 1 轮审查 F1,已实测)。这一层压根不认识回合区间,所以这里
  // 钉的是另一头:只有那条销账记录才搬得动它。
  const kept = pendingStallVerdicts(readStallJournal(dbFile));
  assert.deepEqual(kept.map((r) => r.sessionId), ["still-open"], "压缩之后留下来的不是那一条");
  appendStallDischarge("still-open", TURN, dbFile);
  assert.deepEqual(pendingStallVerdicts(readStallJournal(dbFile)), [], "销账之后它还算一条有效判决");
  assert.deepEqual(compactStallJournal(dbFile), { kept: 0, dropped: 2 }, "销账之后没被压掉");

  // 读不全的时候**不许重写**:那会把「核实不了」变成「没有」,正是 F1 换个地方重演。
  appendStallVerdict({ at: "t2", sessionId: "still-open", turnStartedAt: TURN2, reason: "还没结算" }, dbFile);
  appendFileSync(file, '\n{"坏行\n');
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.equal(compactStallJournal(dbFile), null, "读不全还照样重写了日志");
  } finally {
    console.warn = quiet;
  }
  assert.ok(readFileSync(file, "utf8").includes("还没结算"), "读不全那一次把内容抹掉了");
}

// ── ④ 落盘失败如实报失败 ──────────────────────────────────────────────────────
// 返回值是契约:上层拿它决定「要不要在用户看到的诊断里说一句重启会丢」。假装成功就等于把
// F1 换了个地方重演。
{
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const nowhere = join(stage, "这个目录不存在", "x.db");
    assert.equal(appendStallVerdict({ at: "t", sessionId: "s", turnStartedAt: TURN, reason: "r" }, nowhere), false,
      "写不进去却报了成功");
  } finally {
    console.warn = quiet;
  }
}

// ── ⑤ markStallFailure 的返回值就是落盘结果,外加启动装载 ──────────────────────
{
  configure({});
  // 没注册持久化(纯状态机测试的常态):**不算落盘失败** —— 否则每份单元测试期望里都挂一句
  // 假警报,读的人就学会忽略它了。
  setStallVerdictPersister(null);
  assert.equal(markStallFailure("d1", TURN, "没注册"), "not-persisted");

  // 整份判决交给持久那一半 —— 包含停滞起点:它必须跟着落盘,否则接管那一路只能现编一个
  // (`StallVerdict.since`:持久标记的 CAS 认的是那个身份)。
  const seen: { sessionId: string; since: string; reason: string }[] = [];
  const discharged: string[] = [];
  setStallVerdictPersister({
    append: (verdict) => { seen.push(verdict); return true; },
    discharge: (sessionId, turnStartedAt) => { discharged.push(`${sessionId}@${turnStartedAt}`); },
  });
  assert.equal(markStallFailure("d2", TURN, "存住了", "2026-10-30T07:00:00.000Z"), "durable");
  assert.deepEqual(seen.map((v) => [v.sessionId, v.since, v.reason]),
    [["d2", "2026-10-30T07:00:00.000Z", "存住了"]], "交给持久那一半的判决少了字段");
  // **销账也走持久那一半**,而且只在真的销掉一条时走:判决的回收条件是「权威结算确认过」,
  // 而唯一知道这件事的就是 `clearStallFailure` 的调用者(第 1 轮审查 F1)。
  const { clearStallFailure } = await import("../src/turn-stall-verdict.js");
  clearStallFailure("d2", TURN);
  assert.deepEqual(discharged, [`d2@${TURN}`], "结算销账时没通知持久那一半 —— 盘上那条判决会被重新读回来");
  clearStallFailure("d2", TURN);
  assert.equal(discharged.length, 1, "压根没有判决的回合也往日志里写了一条销账 —— 每轮一行废记录");

  setStallVerdictPersister({ append: () => false, discharge: () => {} });
  assert.equal(markStallFailure("d3", TURN, "没存住"), "lost-on-restart");

  // 持久那一半抛了也只是「没存住」—— 不许把一次磁盘故障变成「这一轮没被熔断」。
  setStallVerdictPersister({ append: () => { throw new Error("磁盘满"); }, discharge: () => {} });
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.equal(markStallFailure("d4", TURN, "抛了"), "lost-on-restart");
  } finally {
    console.warn = quiet;
  }
  assert.equal(seen.length, 1, "持久那一半被按错次数调用了");

  // 启动装载:盘上那些一次性装进内存,之后结算侧只读内存(判据见 loadStallFailures)。
  __resetStallFailures();
  const loaded = loadStallFailures([
    { sessionId: "boot", turnStartedAt: TURN, reason: "上一个进程判的", at: "t0", since: "s0" },
  ]);
  assert.equal(loaded, 1);
  assert.equal(stallFailure("boot", TURN)?.reason, "上一个进程判的", "装回来的判决读不到");
  assert.equal(stallFailure("boot", TURN)?.since, "s0", "停滞起点没跟着装回来 —— 撤标记会撤到别人身上");
  assert.equal(stallFailure("boot", TURN)?.kind, "tripped");
  // 本进程刚判的那一份更新,不许被盘上的旧记录盖掉。
  setStallVerdictPersister({ append: () => true, discharge: () => {} });
  markStallFailure("boot", TURN, "本进程刚判的");
  assert.equal(loadStallFailures([{ sessionId: "boot", turnStartedAt: TURN, reason: "盘上那条", at: "t0" }]), 0);
  assert.equal(stallFailure("boot", TURN)?.reason, "本进程刚判的", "装载把本进程刚作出的判决盖掉了");
  __resetStallFailures();
}

// ── ⑥ 没存住那一档:熔断诊断里如实多说一句 ─────────────────────────────────────
{
  const trip = async (persist: boolean | null, sessionId: string): Promise<string> => {
    configure({ warnErrors: 1, tripMs: 60, pollMs: 15 });
      setStallVerdictPersister(persist === null ? null : { append: () => persist, discharge: () => {} });
    const { actions, log } = spy();
    trackTurnStall(sessionId, {}, TURN, notice(), actions);
    await sleep(320);
    assert.equal(log.trips.length, 1, `${sessionId} 没熔断 —— 夹具不对`);
    return log.trips[0]!;
  };
  const volatileText = await trip(false, "t-lost");
  assert.match(volatileText, /已自动终止本回合/, "正经那段诊断被这一句挤掉了");
  assert.match(volatileText, /没能写进磁盘/, "判决没存住,诊断里一个字都没说");
  assert.match(volatileText, /重新显示成已完成/, "没说清后果 —— 用户要能对上「怎么又变回已完成了」");

  // 存住了就不许说这句:一句永远都在的警告等于没有警告。
  assert.doesNotMatch(await trip(true, "t-durable"), /没能写进磁盘/, "判决存住了还在喊重启会丢");
  assert.doesNotMatch(await trip(null, "t-plain"), /没能写进磁盘/, "压根没注册持久化也喊了一句假警报");
}

// 留白(如实记):**短写本身没有制造**(F4 按代码推断)。macOS 没有 /dev/full,配额/满盘在这个
// 夹具里造不出来,所以这里钉的是它的两头 —— 成功那一路整条记录确实落全(①),以及半行记录在读
// 的一侧被算作「读不出来」而不是「没有」(②(b))。中间那一段(短写时按字节补写、补不完返回
// false)只有代码阅读保证。
console.log("test:stall-journal ok：读不出来≠没有,压缩只认结算,没存住如实说出来");
process.exit(0);
