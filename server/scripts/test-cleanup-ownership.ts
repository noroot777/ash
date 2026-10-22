// **一个活身份必须随时有一个落脚处** —— 第 10 轮审查 F1 的那条不变量,写成一句可执行的话。
//
// 前十轮每一轮的 F1 都是同一条判据错误的新位置:「没进这次的视野」被当成「没有未销的
// 责任」。每一轮修的都是报告点到的那两三格,而这件事的格子是**身份来源 × 结论出口**的
// 笛卡尔积 —— 所以这一份不按位置写用例,按**不变量**写:
//
//   一个这一刻还核不动的身份,必须至少在下面三个地方之一找得到:
//     ① 债表那一行的 `open_members` 上;
//     ② 进程内的待投清单上(落库失败时它唯一的落脚处);
//     ③ 或者它已经有退出证据(核销),那它可以哪儿都不在。
//
// 反过来也要成立:**有退出证据的身份不许赖着不走**(否则正常收尾的回合会平白押一笔假债,
// 那是第 3 轮审查 N2 定过的另一头)。
//
// 下面两节覆盖报告点名要一起钉住的六种处境,用的是**同一个** `livesSomewhere` 断言:
//   A. 已知但无权补刀(代次核验不了 ⇒ 正确地不下刀,可责任不许跟着丢);
//   B. 已确认目标从最终视野消失(被重父到 1 号名下、父边恢复可读);
//   C. 旧行读不出来、而行写成功了(交接只算半截);
//   D. 旧字段解析失败(同一档:`readOpenMembers` 对 SELECT 失败和坏 JSON 都答 ok=false,
//      所以这里用坏 JSON 制造 —— 不必在连接层注入故障,走的是同一条分支);
//   E. 补投那一笔没人接(`mergeOpenIntoRow` 失败 ⇒ 不许把清单上那一笔丢掉);
//   F. 正常退出之后能销账(不制造假债)。
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-cleanup-ownership-"));
process.env.ASH_DB = join(root, "ash.db");

const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const {
  noteCleanupDebt, listAllCleanupDebts, sweepAgentCleanupDebts,
  pendingCleanupNoteCount, flushPendingCleanupNotes,
} = await import("../src/executors/cleanup-debt.js");
const { openLedger } = await import("../src/executors/cleanup-result.js");
const { processGenerationSync } = await import("../src/process-generation.js");
const { db } = await import("../src/db/index.js");
const { agentCleanupDebts } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");

let bad = 0;
const ok = (m: string) => console.log(`   \u2713 ${m}`);
const fail = (m: string) => { bad += 1; console.log(`   \u2717 ${m}`); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rowOf = async (key: string) => {
  const listing = await listAllCleanupDebts();
  if (!listing.ok) throw new Error(`\u503a\u8868\u8bfb\u4e0d\u51fa\u6765:${listing.reason}`);
  return listing.debts.find((d) => d.unitToken === key);
};

/**
 * **那条不变量本身**:这个号此刻的落脚处。三者任一成立就算没丢。
 *
 * 刻意把三个地方一起报出来而不是只返回一个布尔:用例失败时要能一眼看出它是「哪儿都不在」
 * 还是「只剩内存里那一份」—— 后者是合法状态,前者才是责任丢失。
 */
async function livesSomewhere(key: string, pid: number): Promise<{
  row: boolean; pending: boolean; where: string;
}> {
  const row = (await rowOf(key))?.openMembers ?? "";
  const onRow = row.includes(`"pid":${pid}`) || row.includes(`"pid": ${pid}`);
  const inMemory = pendingCleanupNoteCount() > 0;
  return {
    row: onRow, pending: inMemory,
    where: `\u884c\u4e0a=${onRow ? "\u6709" : "\u65e0"} \u5f85\u6295=${inMemory ? "\u6709" : "\u65e0"}`,
  };
}

// ── 第一节:账本的代数(来源少并一个会怎样)────────────────────────────────────────
console.log("\n1) 身份来源收口:确认过归属的成员,只有退出证据能让它从账上消失");
{
  // A 和 B 在代数层是**同一条**:核验不了代次所以没下刀的成员、以及收尾那次扫描已经看不见
  // 的成员,都不会出现在「这一次扫描点的名」里,只能靠 `own()` 把它们认进账本。上一版把三个
  // 来源散在调用点上手工并,于是漏了这一条边 —— 审查实测:结论 empty、债表 0 笔、心跳 107→117。
  const alive = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await wait(300);
  const livePid = alive.pid!;
  const liveGen = processGenerationSync(livePid);

  const owed = openLedger();
  owed.own([{ pid: livePid, gen: liveGen }], "\u5939\u5177:\u5df2\u786e\u8ba4\u5f52\u5c5e\u3001\u6ca1\u6572\u5230\u5b83");
  // 这一轮「点的名」是空的(父边读得出来、没有 fault),可账本上有一个已确认的活成员。
  owed.add([]);
  if (owed.verdict().kind !== "empty" && owed.left().some((o) => o.pid === livePid)) {
    ok(`\u8fd9\u4e00\u8f6e\u4e00\u4e2a\u540d\u6ca1\u70b9\u3001\u8d26\u4e0a\u6709\u4e00\u4e2a\u6d3b\u6210\u5458 \u21d2 \u7ed3\u8bba\u662f ${owed.verdict().kind},\u4e0d\u662f empty`);
  } else fail("\u5df2\u786e\u8ba4\u7684\u6d3b\u6210\u5458\u6ca1\u62e6\u4f4f\u5224\u7a7a \u2014\u2014 \u5c31\u662f\u5ba1\u67e5\u5b9e\u6d4b\u7684\u90a3\u4e00\u4e0b");

  alive.kill("SIGKILL");
  await wait(400);
  if (owed.verdict().kind === "empty" && !owed.left().length) {
    ok("\u5b83\u9000\u4e86\u4e4b\u540e\u540c\u4e00\u672c\u8d26\u81ea\u5df1\u6d88\u89e3 \u2014\u2014 \u6b63\u5e38\u6536\u5c3e\u4e0d\u538b\u5047\u503a");
  } else fail(`\u6709\u9000\u51fa\u8bc1\u636e\u4e86\u8fd8\u8d56\u7740\u4e0d\u8d70(${owed.verdict().kind})`);

  // 同一个号的两代是两份责任(第 9 轮审查 F1-D),`own` 这条路上同样不许混。
  const twoGen = openLedger();
  twoGen.own([{ pid: livePid, gen: liveGen }], "\u5939\u5177:\u65e7\u90a3\u4e00\u4ee3");
  twoGen.own([{ pid: livePid, gen: "t:\u522b\u7684\u90a3\u4e00\u4ee3" }], "\u5939\u5177:\u65b0\u90a3\u4e00\u4ee3");
  if (twoGen.left().length === 0) ok("\u4e24\u4ee3\u90fd\u6709\u9000\u51fa\u8bc1\u636e\u65f6\u4e24\u6761\u4e00\u8d77\u6d88\u89e3");
  else fail(`\u8fd9\u4e24\u6761\u672c\u8be5\u90fd\u88ab\u6838\u9500(\u5269 ${twoGen.left().length} \u6761)`);
}

// ── 第二节:持久交接(落脚处那条不变量)──────────────────────────────────────────
console.log("\n2) \u8d23\u4efb\u4ea4\u63a5:noted \u8981\u610f\u5473\u7740\u8fd9\u51e0\u4e2a\u53f7\u771f\u7684\u6709\u4eba\u63a5\u4f4f\u4e86");
{
  const key = "unit:ownership-handoff";
  const idle = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await wait(300);
  const pidA = idle.pid!;
  const genA = processGenerationSync(pidA);
  // 根那一问要给一台**答得出来**的设备:行上的 `rootPid` 为空时它只能答「没有证据来源」
  // (`silent`),于是整行永远走收档,这一组最后那句「两个号都退了就该销账」压根测不到。
  // 用一个确定不存在的号 ⇒ 号上没有进程 ⇒ 当初那个一定退了,是正面的退出证明。
  const goneRoot = 0x7ffffff;
  const note = (open: { pid: number; gen: string | null; why: string }[]) => noteCleanupDebt({
    unitToken: key, taskId: "t-own", sessionId: "s-own",
    rootPid: goneRoot, rootStartedAt: null, trackPath: null, outPath: null,
    state: "unknown", detail: "\u5939\u5177", unitVerdict: "unprovable", open,
  });

  // 前提:先落一笔合法的,行上有名单。
  await note([{ pid: pidA, gen: genA, why: "\u5939\u5177:\u5148\u70b9\u4e0a\u540d" }]);
  const seeded = await livesSomewhere(key, pidA);
  if (seeded.row) ok("\u524d\u63d0:\u7b2c\u4e00\u7b14\u843d\u4e86\u5e93,\u884c\u4e0a\u70b9\u7740\u8fd9\u4e2a\u53f7");
  else fail(`\u5939\u5177\u6ca1\u843d\u4e0b(${seeded.where})`);

  // C/D:把行上那一列弄成读不出来,再来一笔**带新身份**的。行会写成功,而这一列一个字不动 ——
  // 旧名单因此没丢(那是对的),可新身份一个都没交出去,所以这一笔不许冒充 noted。
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await wait(300);
  const pidB = other.pid!;
  const genB = processGenerationSync(pidB);
  await db.update(agentCleanupDebts)
    .set({ openMembers: "{\u4e0d\u662f\u6570\u7ec4" })
    .where(eq(agentCleanupDebts.unitToken, key));
  const verdict = await note([{ pid: pidB, gen: genB, why: "\u5939\u5177:\u65b0\u53d1\u73b0\u7684\u6d3b\u8eab\u4efd" }]);
  if (verdict === "failed") ok("\u65e7\u540d\u5355\u8bfb\u4e0d\u51fa\u6765 \u21d2 \u5982\u5b9e\u62a5\u300c\u6ca1\u843d\u4e0b\u300d,\u4e0d\u5192\u5145 noted");
  else fail(`\u8fd9\u4e00\u7b14\u62a5\u7684\u662f ${verdict} \u2014\u2014 \u53d9\u8ff0\u843d\u4e86\u5c31\u7b97\u8d23\u4efb\u63a5\u4f4f\u4e86\uff0c\u5c31\u662f\u5ba1\u67e5\u5b9e\u6d4b\u7684\u90a3\u4e00\u4e0b`);
  const half = await livesSomewhere(key, pidB);
  if (half.pending) ok(`\u800c\u4e14\u5b83\u8fd8\u6709\u843d\u811a\u5904:${half.where}`);
  else fail(`\u8fd9\u4e2a\u6d3b\u8eab\u4efd\u54ea\u513f\u90fd\u4e0d\u5728\u4e86(${half.where})`);

  // E:补投这一笔同样要问「接住了吗」。名单还是坏的 ⇒ 投不进去,清单上那一笔不许丢。
  //
  // 走的是 `writeNote → noteDebtRow` 这条出口(叙述没过期)。另一条出口 `mergeOpenIntoRow`
  // (叙述已被更新的一版盖过、只补名单)这一轮也改成了如实反馈成败,但**它在当前时序下
  // 没有独立反例**:能盖过旧叙述的那一笔必然已经把旧 pending 的名单并进了行里,所以那条路
  // 上即使「没接住」也不会丢责任。审查报告 C2 的判断相同 —— 不把辅助函数的潜在脆弱点
  // 虚报成已证实故障,只要求两条出口的确认语义一致。
  const stuck = await flushPendingCleanupNotes();
  if (stuck.pending > 0 && (await livesSomewhere(key, pidB)).pending) {
    ok("\u8865\u6295\u6ca1\u4eba\u63a5 \u21d2 \u6e05\u5355\u4e0a\u90a3\u4e00\u7b14\u7559\u7740(\u4e0d\u662f\u6253\u4e00\u884c\u65e5\u5fd7\u5c31\u5b8c\u4e8b)");
  } else fail(`\u8865\u6295\u628a\u8d23\u4efb\u4e22\u4e86(pending=${stuck.pending})`);

  // 名单修好之后那一笔要能落下去 —— 这条不变量是「不许丢」,不是「永远卡着」。
  await db.update(agentCleanupDebts)
    .set({ openMembers: "[]" })
    .where(eq(agentCleanupDebts.unitToken, key));
  await flushPendingCleanupNotes();
  const landed = await livesSomewhere(key, pidB);
  if (landed.row) ok("\u884c\u4e0a\u90a3\u4e00\u5217\u4fee\u597d\u4e4b\u540e,\u90a3\u4e2a\u53f7\u843d\u5230\u4e86\u884c\u4e0a");
  else fail(`\u8ddf\u8fdb\u4e0d\u4e0a\u53bb(${landed.where})`);

  // F:两个号都退了之后,同一份判据要能把账销掉(假债同样是故障)。
  idle.kill("SIGKILL");
  other.kill("SIGKILL");
  await wait(500);
  const swept = await sweepAgentCleanupDebts();
  if (!swept.ok) throw new Error(`\u6e05\u626b\u6ca1\u7ed9\u51fa\u7ed3\u8bba:${swept.reason}`);
  if (!await rowOf(key)) ok("\u4e24\u4e2a\u53f7\u90fd\u9000\u4e86 \u21d2 \u8fd9\u4e00\u884c\u9500\u6389,\u4e0d\u7559\u5047\u503a");
  else fail("\u6709\u9000\u51fa\u8bc1\u636e\u4e86\u8fd8\u7559\u7740\u884c \u2014\u2014 \u90a3\u662f\u53e6\u4e00\u5934\u7684\u6545\u969c");
}

console.log(bad ? `\n\u2717 ${bad} \u9879\u672a\u901a\u8fc7` : "\n\u2713 \u5168\u90e8\u901a\u8fc7");
process.exit(bad ? 1 : 0);
