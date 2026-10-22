// **「尝试写入」不等于「身份已经接住」** —— 第 13 轮审查 F1 的那条不变量。
//
// 上一轮把确证过的成员接到了判定上(`test-cleanup-ownership.ts` 第四节),可那一节钉的是
// **写成功**那条路。审查实测的是另一半:判定算对了、身份也在结果上了、信号也真发过了,
// 而那一句 UPDATE 被拒之后,那份身份只活在调用方的局部变量里,函数一返回就没了 ——
// 读数:行还在、`open_members=null`、待投清单 0 笔;下一次清扫按「没有未排除的号」把行真的
// DELETE 了,而那个进程仍 alive、心跳文件 49→54 还在涨。
//
// 所以这一份按**失败出口**排用例,每一条都要求同一件事:那几个还没核销的身份,必须在已经
// 落下的 `open_members` 或者进程内待投清单里至少有一个落脚处。
//
//  ① 写**抛错**(真实 SQLite `BEFORE UPDATE` + `RAISE(ABORT)`):身份落到待投清单上;
//  ② 恢复写入后补投:身份从清单落到行上,而且第二遍清扫**自己一个名都没点到**也不许销账
//     —— 它证明身份是靠交接活下来的,不是靠又取了一次证;
//  ③ 进程真退出之后:同一份判据要能把账销掉(假债同样是故障);
//  ④ 写**未命中**(`RAISE(IGNORE)`:不抛错、`rowsAffected` 是 0 —— 版本条件对不上那一档走的是
//     同一条返回路):同样兜底;
//  ⑤ **销账入口**那条路(`settleCleanupDebt` → `settleIfStillEmpty`)同样兜底 —— 审查报告把它
//     列成「未单独实测、按代码推断」的那一处。
//  ⑥ 行上那份名单**读不出来**(JSON 坏了)时:这一列一个字不许动,**而且**这一轮的身份要
//     走兜底 —— 「写了一下」在这一档同样不等于「名单接住了」。这一条是封这一段时自己
//     找出来的,报告没点到:照着空名单写下去,这一列就从「坏的」变成「空的」,而判定对
//     前者答 silent(行销不掉)、对后者直接判空销账 —— 一次 JSON 损坏被升级成真实的责任丢失。
//
// `ours` 这一档只有 Linux 的 `/proc/<pid>/environ` 给得出,这台机器是 macOS ⇒ 用 fake-proc 台子
// 按剧本回答那四个读取点,**判档、代次比较、发信号、进程死活、SQLite 全是真的**(见那份夹具
// 的顶注)。它证的是这套交接逻辑在 exact 档上的行为,不是在原生 Linux 上压出了 pid 复用。
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-cleanup-write-handoff-"));
process.env.ASH_DB = join(root, "ash.db");

const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const {
  noteCleanupDebt, settleCleanupDebt, listAllCleanupDebts, sweepAgentCleanupDebts,
  pendingCleanupNoteCount,
} = await import("../src/executors/cleanup-debt.js");
const { processGenerationSync } = await import("../src/process-generation.js");
const { processUnitEvidence } = await import("../src/proc.js");
const { dbClient } = await import("../src/db/index.js");
const { install: fakeProc, restore: realProc } = await import("./fake-proc-fixture.js");

let bad = 0;
const ok = (m: string) => console.log(`   ✓ ${m}`);
const fail = (m: string) => { bad += 1; console.log(`   ✗ ${m}`); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rowOf = async (key: string) => {
  const listing = await listAllCleanupDebts();
  if (!listing.ok) throw new Error(`债表读不出来:${listing.reason}`);
  return listing.debts.find((d) => d.unitToken === key);
};
/** 行上点着这个号吗。 */
const onRow = (row: { openMembers?: string | null } | undefined, pid: number): boolean =>
  !!row?.openMembers && (row.openMembers.includes(`"pid":${pid}`) || row.openMembers.includes(`"pid": ${pid}`));

/** 真实 SQLite 触发器:让这张表上的 UPDATE 抛错(`abort`)或静默不改行(`ignore`)。 */
async function blockUpdates(how: "abort" | "ignore"): Promise<void> {
  const body = how === "abort" ? "SELECT RAISE(ABORT, '夹具:这一句写入被拒')" : "SELECT RAISE(IGNORE)";
  await dbClient.execute(
    `CREATE TRIGGER block_debt_update BEFORE UPDATE ON agent_cleanup_debts BEGIN ${body}; END;`,
  );
}
const unblockUpdates = () => dbClient.execute("DROP TRIGGER IF EXISTS block_debt_update");

/** 同上,拦的是 INSERT —— 「这个键上还没有行」那一支走的是它。 */
async function blockInserts(how: "abort" | "ignore"): Promise<void> {
  const body = how === "abort" ? "SELECT RAISE(ABORT, '夹具:这一句写入被拒')" : "SELECT RAISE(IGNORE)";
  await dbClient.execute(
    `CREATE TRIGGER block_debt_insert BEFORE INSERT ON agent_cleanup_debts BEGIN ${body}; END;`,
  );
}
const unblockInserts = () => dbClient.execute("DROP TRIGGER IF EXISTS block_debt_insert");

/**
 * 一个**挨了刀还活着、而且记号已经被洗掉**的成员。剧本就是 `exec` 那一下:第一遍扫描读到
 * 记号(`ours`),之后再也读不到(`none`),pid 和那一代一个字没变 —— 所以它核销不掉。
 */
async function survivorWithMark(key: string): Promise<{ pid: number; stop: () => void }> {
  const child = spawn(process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: "ignore" });
  await wait(400);
  const pid = child.pid!;
  const script = { tokensOnEnvRead: (n: number) => (n <= 2 ? [key] : []), genOnStatRead: () => "111" };
  fakeProc(pid, script);
  const probe = processUnitEvidence(key, { fresh: true });
  if (probe.verdict !== "ours" || !probe.members.some((m) => m.pid === pid)) {
    fail(`台子没搭起来(记号这一问答的是 ${probe.verdict})`);
  }
  return {
    pid,
    // 夹具纪律 ①:被测函数之前重新 install 归零,这样清扫里第一遍取证就是剧本的第 1、2 次。
    stop: () => { child.kill("SIGKILL"); },
  };
}
const rearm = (pid: number, key: string) => fakeProc(pid, {
  tokensOnEnvRead: (n: number) => (n <= 2 ? [key] : []), genOnStatRead: () => "111",
});

const noteRow = (key: string) => noteCleanupDebt({
  unitToken: key, taskId: "t-write", sessionId: "s-write",
  // 根那一问要有**正面退出证明**(号上没有进程 ⇒ 当初那个一定退了),否则整行永远走收档,
  // 「销不销」这一头测不到。
  rootPid: 0x7ffffff, rootStartedAt: null, trackPath: null, outPath: null,
  state: "unknown", detail: "夹具:普通待清理行", unitVerdict: "unprovable", open: [],
});

// ── 第一节:写抛错 ────────────────────────────────────────────────────────────────
console.log("\n1) 一句库写抛错之后,这一轮确证过的身份还有落脚处");
{
  const key = "unit:write-abort";
  const { pid, stop } = await survivorWithMark(key);
  await noteRow(key);                               // 建行:首次 INSERT,不碰 UPDATE 触发器
  await blockUpdates("abort");
  rearm(pid, key);
  const swept = await sweepAgentCleanupDebts();
  if (!swept.ok) throw new Error(`清扫没给出结论:${swept.reason}`);

  const row = await rowOf(key);
  if (row) ok("行还在(写被拒 ⇒ 这一行一个字没动)");
  else fail("行不见了 —— 写都失败了,它凭什么消失");
  if (!onRow(row, pid)) ok("前提:行上这一列确实没写进去(所以落脚处只能在别处)");
  else fail("行上居然有名单 —— 触发器没拦住,这一组没测到东西");
  if (pendingCleanupNoteCount() > 0) ok(`写失败 ⇒ 身份落到待投清单上(${pendingCleanupNoteCount()} 笔)`);
  else fail("哪儿都不在 —— 就是审查实测的那一下(局部变量里那份随调用结束消失)");

  // ── 第二节:恢复写入,靠交接活下来的那份身份要能落到行上 ──────────────────────
  console.log("\n2) 写入恢复之后:身份落到行上,而且这一遍自己一个名都没点到也不许销账");
  await unblockUpdates();
  // 剧本不归零 ⇒ 这一遍记号从头到尾答 none(第 7 次往后)。所以判定手上只有「交接过来的
  // 那一份」,没有任何新取证 —— 它证的正是责任靠交接活下来了。
  const again = await sweepAgentCleanupDebts();
  if (!again.ok) throw new Error(`第二遍清扫没给出结论:${again.reason}`);
  const after = await rowOf(key);
  if (after) ok("没销账(手上还有排除不掉的号)");
  else fail("行被销掉了 —— 那个进程还活着,这是假的销账");
  if (onRow(after, pid)) ok("补投把那个号写到了行上(跨得过重启)");
  else fail(`行上仍然没有这个号(open_members=${after?.openMembers ?? "null"})`);
  if (processUnitEvidence(key, { fresh: true }).verdict === "none") {
    ok("而且这一遍记号那一问答的是 none —— 身份不是重新取证取回来的");
  } else fail("剧本错位:记号还读得到,这一组没证明「靠交接活下来」");

  // ── 第三节:真退出之后能销账 ────────────────────────────────────────────────
  console.log("\n3) 它真的退出之后,同一份判据要把账销掉(假债同样是故障)");
  realProc();                                       // 台子撤掉:核销走真实 pid 死活
  stop();
  await wait(500);
  const third = await sweepAgentCleanupDebts();
  if (!third.ok) throw new Error(`第三遍清扫没给出结论:${third.reason}`);
  if (!await rowOf(key)) ok("有退出证据了 ⇒ 这一行销掉,不留假债");
  else fail("它已经退了,行还赖着 —— 那是另一头的故障");
}

// ── 第四节:写未命中(不抛错、就是没改到行)──────────────────────────────────────
console.log("\n4) 写没命中(rowsAffected 是 0)跟抛错同一档:身份一样要有人接");
{
  // 版本条件对不上走的也是这条返回路(`rowsAffectedOf(...) > 0` 为假),用 `RAISE(IGNORE)`
  // 制造 —— 不抛错、不改行,正是那一档的形状。
  const key = "unit:write-miss";
  const { pid, stop } = await survivorWithMark(key);
  await noteRow(key);
  await blockUpdates("ignore");
  rearm(pid, key);
  const swept = await sweepAgentCleanupDebts();
  if (!swept.ok) throw new Error(`清扫没给出结论:${swept.reason}`);
  const row = await rowOf(key);
  if (row && !onRow(row, pid)) ok("前提:这一句没改到行(行还在、名单还是空的)");
  else fail("夹具没造出「没命中」那一档");
  if (pendingCleanupNoteCount() > 0) ok("没命中 ⇒ 身份同样落到待投清单上");
  else fail("「没抛错」被当成了「接住了」—— 这一档也会丢责任");
  await unblockUpdates();
  realProc();
  stop();
  await wait(400);
  const done = await sweepAgentCleanupDebts();
  if (done.ok && !await rowOf(key)) ok("它退出之后照样销得掉");
  else fail("收不了尾");
}

// ── 第五节:销账入口那条路 ──────────────────────────────────────────────────────
console.log("\n5) 销账入口(settleCleanupDebt)那条路的写失败,同样要兜");
{
  // 审查报告把这一处列成「未单独实测、按代码推断」:它跟清扫那条路不同源 —— 没有自己的
  // 扫描,新身份只能来自 `judgeDebtRow` 内部那一遍记号取证(`markerResidue(ours)`)。
  const key = "unit:settle-entry";
  const { pid, stop } = await survivorWithMark(key);
  await noteRow(key);
  await blockUpdates("abort");
  rearm(pid, key);
  await settleCleanupDebt({ unitToken: key, trackPath: null, outPath: null });
  const row = await rowOf(key);
  if (row) ok("行还在(它没拿「写了一下」当成销账成功)");
  else fail("行被删了");
  if (pendingCleanupNoteCount() > 0) ok("这条路上的新身份也有落脚处");
  else fail("销账入口这条路把身份丢了 —— 报告里那处「按代码推断」的位置");
  await unblockUpdates();
  realProc();
  stop();
  await wait(400);
  await sweepAgentCleanupDebts();
  if (!await rowOf(key)) ok("退出之后销得掉");
  else fail("收不了尾");
}

// ── 第六节:行上那份读不出来的时候 ────────────────────────────────────────────────
console.log("\n6) 行上名单坏了:那一列不许被擦成空,这一轮的身份也不许没人接");
{
  const key = "unit:broken-list";
  const { pid, stop } = await survivorWithMark(key);
  await noteRow(key);
  // 把那一列弄成读不出来(同 test-cleanup-ownership 第二节的手法:`readOpenMembers` 对
  // SELECT 失败和坏 JSON 答的是同一档,所以用坏 JSON 制造就够了)。
  await dbClient.execute({
    sql: "UPDATE agent_cleanup_debts SET open_members = ? WHERE unit_token = ?",
    args: ["{不是数组", key],
  });
  rearm(pid, key);
  // 这一遍写入是通的(没装触发器),所以 touch 会真的执行 —— 要测的正是它写了什么。
  const swept = await sweepAgentCleanupDebts();
  if (!swept.ok) throw new Error(`清扫没给出结论:${swept.reason}`);

  const row = await rowOf(key);
  if (row?.openMembers === "{不是数组") {
    ok("那一列一个字没动(坏的 ≠ 空的,擦掉等于把「核不动」写成「没有责任」)");
  } else fail(`那一列被改成了 ${JSON.stringify(row?.openMembers)} —— 一次 JSON 损坏升级成了销账依据`);
  if (pendingCleanupNoteCount() > 0) {
    ok("而且这一轮确证过的身份有落脚处(「写了一下」在这一档也不等于接住了)");
  } else fail("这一列没写、清单也没有 —— 身份哪儿都不在");

  realProc();
  stop();
  await wait(400);
  // 坏数据还在,所以这一行**销不掉**(判定答 silent)—— 那是对的:核不动就不能销。
  await sweepAgentCleanupDebts();
  if (await rowOf(key)) ok("坏名单修不好之前不许销账(核不动 ⇒ 留着)");
  else fail("坏着就把账销了 —— 那正是这一条要防的");
}

// ── 第七节:落账那一层的零行出口(第 14 轮审查 N1)────────────────────────────────
//
// 交接层三条写入早就认改行数了,**落账层**(`noteCleanupDebt` 走的那条)上一版只认「没抛错」:
// upsert 被静默丢掉时改行数是 0,而它答 `noted`,调用方随即把那一笔从内存待投清单上删掉 ——
// 于是那个还活着的号既不在库里也不在内存里。审查用 `RAISE(IGNORE)` 精确注入过两支。
console.log("\n7) 落账层写了零行:身份必须留在待投清单上(两支都测)");
{
  // ⑦-1 这个键上**还没有行**:走 INSERT 那一支。
  const key = "unit:zero-row-insert";
  const { pid, stop } = await survivorWithMark(key);
  // **按增量数,别按总数**:待投清单是模块级的,前面几节(比如坏名单那一节)会留着自己那笔,
  // 拿 `> 0` 问就恒真 —— 那样的断言在反例下也是绿的,等于没钉住。
  const pendingBefore = pendingCleanupNoteCount();
  await blockInserts("ignore");
  await noteCleanupDebt({
    unitToken: key, taskId: "t-write", sessionId: "s-write",
    rootPid: 0x7ffffff, rootStartedAt: null, trackPath: null, outPath: null,
    state: "unknown", detail: "夹具:首次落账", unitVerdict: "ours",
    open: [{ pid, gen: "j:111", why: "夹具:这一轮点的名" }],
  });
  await unblockInserts();

  if (!await rowOf(key)) ok("库里确实没有这一行(注入成立:写了一下、零行)");
  else fail("注入没成立 —— 行竟然落下去了,这一节测不到东西");
  if (pendingCleanupNoteCount() === pendingBefore + 1) ok("那个号留在待投清单上(「写了一下」不等于接住了)");
  else fail(`库里没有、清单也没多出这一笔(${pendingBefore} → ${pendingCleanupNoteCount()}) —— 身份哪儿都不在`);

  // 放开之后补投一次:这一刻才算真的接住。
  await sweepAgentCleanupDebts();
  const row = await rowOf(key);
  if (onRow(row, pid)) ok("写入恢复之后补投把它落到了行上(没有丢)");
  else fail(`补投之后行上还是没有它:${JSON.stringify(row?.openMembers)}`);

  realProc();
  stop();
  await wait(400);
}
{
  // ⑦-2 这个键上**已经有行**:走冲突 UPDATE 那一支。
  const key = "unit:zero-row-upsert";
  const { pid, stop } = await survivorWithMark(key);
  await noteRow(key);                               // 先建行(此时没装触发器)
  const pendingBefore = pendingCleanupNoteCount();  // 同上:按增量数
  await blockUpdates("ignore");
  rearm(pid, key);
  await noteCleanupDebt({
    unitToken: key, taskId: "t-write", sessionId: "s-write",
    rootPid: 0x7ffffff, rootStartedAt: null, trackPath: null, outPath: null,
    state: "unknown", detail: "夹具:第二次落账", unitVerdict: "ours",
    open: [{ pid, gen: "j:111", why: "夹具:这一轮点的名" }],
  });
  await unblockUpdates();

  const row = await rowOf(key);
  if (!onRow(row, pid)) ok("行上确实没有它(注入成立:冲突更新被静默丢掉)");
  else fail("注入没成立 —— 这一节测不到东西");
  if (pendingCleanupNoteCount() === pendingBefore + 1) ok("那个号留在待投清单上");
  else fail(`行上没有、清单也没多出这一笔(${pendingBefore} → ${pendingCleanupNoteCount()})`);

  await sweepAgentCleanupDebts();
  if (onRow(await rowOf(key), pid)) ok("写入恢复之后它落到了行上");
  else fail("恢复之后仍然没落上");

  realProc();
  stop();
  await wait(400);
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过");
process.exit(bad ? 1 : 0);
