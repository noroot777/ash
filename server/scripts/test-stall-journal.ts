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
//   ② 裁剪只改名、不读-改-写(照 exit-ledger.ts 的教训,那边实测过重写会吞掉追加);
//   ③ 落盘失败**如实报失败**,不许假装成功;
//   ④ `markStallFailure` 的返回值就是落盘结果,三档各自什么意思;
//   ⑤ 没存住那一档,熔断诊断里**要如实多说一句** —— 不然用户看到「已终止」、重启后又看到
//      「已完成」,而他没有任何线索。
//
// 跨进程那一半(真 `consumeSingleRun`、真库被事务占着、真的换一个进程接管)在
// test-stall-restart.ts;这里一个字都不碰库。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 兜底:万一哪条默认参数路径没显式传库文件,也只会落在临时目录里,不可能挨着生产库。
const stage = mkdtempSync(join(tmpdir(), "ash-stall-journal-"));
process.env.ASH_DB = join(stage, "journal.db");

const {
  __seedStallVerdict, appendStallVerdict, readStallVerdict, rotateStallJournal, stallJournalFileForDb,
} = await import("../src/turn-stall-journal.js");
const { markStallFailure, setStallVerdictPersister } = await import("../src/turn-stall-verdict.js");
const { trackTurnStall } = await import("../src/turn-stall.js");
const { configure, notice, sleep, spy, TURN } = await import("./stall-fixtures.js");

const TURN2 = "2026-10-30T09:00:00.000Z";

// ── ① 落盘与读回 ────────────────────────────────────────────────────────────────
{
  const dbFile = join(stage, "read.db");
  assert.equal(readStallVerdict("s", TURN, dbFile), null, "空日志里读出了判决");
  assert.equal(appendStallVerdict({ at: "t0", sessionId: "s", turnStartedAt: TURN, reason: "第一次" }, dbFile), true);
  assert.equal(readStallVerdict("s", TURN, dbFile)?.reason, "第一次");
  // 键是**回合身份**,不是 sessionId:一条会话跑很多轮,只有熔断掉的那一轮算失败。
  assert.equal(readStallVerdict("s", TURN2, dbFile), null, "同一会话的另一轮也被判了失败");
  assert.equal(readStallVerdict("other", TURN, dbFile), null, "另一条会话也被判了失败");
  // 同一身份写了两次(接管后又熔断一次)取最后那条 —— 新判决该盖住旧的。
  appendStallVerdict({ at: "t1", sessionId: "s", turnStartedAt: TURN, reason: "第二次" }, dbFile);
  assert.equal(readStallVerdict("s", TURN, dbFile)?.reason, "第二次", "读到的不是最新那条判决");
}

// ── ② 裁剪只改名,不丢任何已经落盘的记录 ────────────────────────────────────────
// 这一条是 exit-ledger.ts 换来的教训:账本是追加式的,「读整文件 → 重写」会把快照之后的追加
// 整段吞掉(那边用真实入口复现过 206 → 200)。改名没有这个窗口,代价是磁盘上最多留两代 ——
// 所以**读的一侧必须两代都看**,这里连带钉住。
{
  const dbFile = join(stage, "rotate.db");
  const file = stallJournalFileForDb(dbFile);
  appendStallVerdict({ at: "t0", sessionId: "old", turnStartedAt: TURN, reason: "最老那条" }, dbFile);
  rotateStallJournal(dbFile);
  assert.equal(existsSync(`${file}${".1"}`), false, "水位以内就轮转了");
  for (let i = 0; i < 220; i += 1) __seedStallVerdict({ sessionId: `pad-${i}`, turnStartedAt: TURN }, dbFile);
  rotateStallJournal(dbFile);
  assert.equal(existsSync(`${file}.1`), true, "超了水位没轮转");
  assert.equal(readStallVerdict("old", TURN, dbFile)?.reason, "最老那条", "轮转之后上一代里的判决读不到了 —— 那等于丢判决");
  // 轮转之后新来的照样读得出来(落在新文件里)。
  appendStallVerdict({ at: "t2", sessionId: "fresh", turnStartedAt: TURN, reason: "轮转之后" }, dbFile);
  assert.equal(readStallVerdict("fresh", TURN, dbFile)?.reason, "轮转之后");
}

// ── ③ 落盘失败如实报失败 ──────────────────────────────────────────────────────
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

// ── ④ markStallFailure 的返回值就是落盘结果 ────────────────────────────────────
{
  configure({});
  // 没注册持久化(纯状态机测试的常态):**不算落盘失败** —— 否则每份单元测试期望里都挂一句
  // 假警报,读的人就学会忽略它了。
  setStallVerdictPersister(null);
  assert.equal(markStallFailure("d1", TURN, "没注册"), "not-persisted");

  // 整份判决交给持久那一半 —— 包含停滞起点:它必须跟着落盘,否则接管那一路只能现编一个
  // (`StallVerdict.since`:持久标记的 CAS 认的是那个身份)。
  const seen: { sessionId: string; since: string; reason: string }[] = [];
  setStallVerdictPersister((verdict) => { seen.push(verdict); return true; });
  assert.equal(markStallFailure("d2", TURN, "存住了", "2026-10-30T07:00:00.000Z"), "durable");
  assert.deepEqual(seen.map((v) => [v.sessionId, v.since, v.reason]),
    [["d2", "2026-10-30T07:00:00.000Z", "存住了"]], "交给持久那一半的判决少了字段");

  setStallVerdictPersister(() => false);
  assert.equal(markStallFailure("d3", TURN, "没存住"), "lost-on-restart");

  // 持久那一半抛了也只是「没存住」—— 不许把一次磁盘故障变成「这一轮没被熔断」。
  setStallVerdictPersister(() => { throw new Error("磁盘满"); });
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.equal(markStallFailure("d4", TURN, "抛了"), "lost-on-restart");
  } finally {
    console.warn = quiet;
  }
  assert.equal(seen.length, 1, "持久那一半被按错次数调用了");
}

// ── ⑤ 没存住那一档:熔断诊断里如实多说一句 ─────────────────────────────────────
{
  const trip = async (persist: boolean | null, sessionId: string): Promise<string> => {
    configure({ warnErrors: 1, tripMs: 60, pollMs: 15 });
    setStallVerdictPersister(persist === null ? null : () => persist);
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

console.log("test:stall-journal ok：判决先落盘才动手终止,裁剪只改名,没存住如实说出来");
process.exit(0);
