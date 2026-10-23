// **账本的内存那一摊**:落库失败之后谁扛着、补投怎么投、点过的名会不会在交接里丢。
//
// 从 `test-cleanup-debt.ts` 拆出来是因为职责不同、也因为那一份贴着单文件上限:那边验的是
// 「按行上的线索重新取证,这一刻算不算空」,这一份验的是**责任在落盘之前那段路上不许丢** ——
// 库这一刻写不进去时它留在内存待投清单上,而清单按键只留一格。
//
//  ① 落库失败:责任留在内存里接着扛,下一次清扫开头补投(第 3 轮审查 F2 后半);
//  ② 写库失败之后来了一份**更弱的输入**:叙述可以按序号换新的,**点过的名只能靠退出证据
//     解除** —— 上一版按键整格覆盖,于是一个已知的活后代从库里和内存里同时消失
//     (第 9 轮审查 F1-B 实测:补投后行上名单是 null、清扫销账、同一个号仍 alive、心跳 48→56)。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-cleanup-pending-"));
process.env.ASH_DB = join(root, "ash.db");

const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const {
  noteCleanupDebt, listAllCleanupDebts, sweepAgentCleanupDebts,
  pendingCleanupNoteCount, flushPendingCleanupNotes,
} = await import("../src/executors/cleanup-debt.js");
const { db } = await import("../src/db/index.js");
const { agentCleanupDebts } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");

let bad = 0;
const ok = (m: string) => console.log(`   \u2713 ${m}`);
const fail = (m: string) => { bad += 1; console.log(`   \u2717 ${m}`); };

const forget = async (key: string) => {
  await db.delete(agentCleanupDebts).where(eq(agentCleanupDebts.unitToken, key));
};
async function debts(): Promise<Awaited<ReturnType<typeof listAllCleanupDebts>> & { ok: true }> {
  const listing = await listAllCleanupDebts();
  if (!listing.ok) throw new Error(`\u503a\u8868\u8bfb\u4e0d\u51fa\u6765:${listing.reason}`);
  return listing;
}
const rowOf = async (key: string) => (await debts()).debts.find((d) => d.unitToken === key);
const sweep = async () => {
  const r = await sweepAgentCleanupDebts();
  if (!r.ok) throw new Error(`\u6e05\u626b\u6ca1\u7ed9\u51fa\u7ed3\u8bba:${r.reason}`);
  return r;
};

console.log("\n10) 落库失败不等于责任消失:内存里接着扛,下一次清扫补投");
{
  // 钉的是第 3 轮审查 F2 后半:上一版写库失败就只剩一条日志,那一笔既不在库里也不在任何人
  // 手上,后面哪一次清扫都不会再想起它。下面那句 `[ash] agent 清理责任落库失败` 是夹具
  // 故意制造的,不是真故障。
  const token = `ash-agent-test-pending-${Date.now().toString(36)}`;
  const hole = db as unknown as { insert: unknown };
  const realInsert = hole.insert;
  hole.insert = () => { throw new Error("夹具:这一刻库写不进去"); };
  const noted = await noteCleanupDebt({
    unitToken: token, rootPid: 4245,
    state: "remaining", detail: "夹具:写库失败的那一笔", unitVerdict: "suspected",
  });
  hole.insert = realInsert;
  if (noted === "failed") ok("写库失败如实返回 failed(没印成「本来没什么可追的」)");
  else fail(`写库失败却报 ${noted}`);
  if (!await rowOf(token)) ok("库里确实没有这一行");
  else fail("夹具没生效:这一行居然写进去了");
  const held = pendingCleanupNoteCount();
  if (held >= 1) ok(`责任留在内存里接着扛(${held} 笔),不是只剩一条日志`);
  else fail("写库失败之后谁都不扛这一笔了 —— 正是 F2 要堵的那一下");

  const swept = await sweep();
  if (swept.landedNotes >= 1) ok(`下一次清扫开头把它补投落库了(${swept.landedNotes} 笔)`);
  else fail(`清扫没补投:landedNotes=${swept.landedNotes}`);
  if (!swept.pendingNotes) ok("内存里不再扛着它");
  else fail(`补投完还剩 ${swept.pendingNotes} 笔在内存里`);
  // 补投落库之后它就是一笔正常的账:同一轮清扫接着重新取证,这个号早就不在了,所以
  // 要么行还留着(这台机器证不出空),要么当场确证空被销掉 —— 两种都算责任交接到位,
  // 唯一不许的是「谁都没接」。
  const row = await rowOf(token);
  if (row) ok(`库里有了这一行(state=${row.state})`);
  else if (swept.settled >= 1) ok("补投之后同一轮就确证空、销了账(责任确实交接过)");
  else fail("补投之后既没有行、也没有任何一笔被销账");
  await forget(token);
}
console.log("\n14) 写库失败之后来了一份更弱的输入:点过的名不许被它顶掉");
{
  // 第 9 轮审查 F1-B 实测的那条链(顺序执行、固定 token、两次真实清理、一次暂时写失败):
  // 第一笔点了名(名单里有个活后代)但库写不进去 ⇒ 留在内存待投清单上;第二笔取证恰好
  // 失败、名单是空的 —— 上一版待投清单按键只留最新那一版结论,于是那个号从库里和内存里
  // 同时消失,补投落库后行上的名单是 null,下一次清扫照「没有未排除的号」销了账
  // (审查读数:同一个号仍 alive、心跳 48→56)。
  const { processGenerationSync } = await import("../src/process-generation.js");
  const alive = { pid: process.pid, gen: processGenerationSync(process.pid), why: "夹具:活着的那个" };
  const hole = db as unknown as { insert: unknown };

  const token = `ash-agent-test-weaker-${Date.now().toString(36)}`;
  const realInsert = hole.insert;
  hole.insert = () => { throw new Error("夹具:这一刻库写不进去"); };
  const first = await noteCleanupDebt({
    unitToken: token, rootPid: 4247, state: "unknown",
    detail: "夹具:点了名、可是写不进去", unitVerdict: "unprovable", open: [alive],
  });
  // 第二笔:同一个键、更弱的输入(这一刻连名都点不出来)。库**仍然**写不进去。
  const second = await noteCleanupDebt({
    unitToken: token, rootPid: 4247, state: "unknown",
    detail: "夹具:这一刻取证失败,名单是空的", unitVerdict: "unprovable", open: [],
  });
  hole.insert = realInsert;
  if (first === "failed" && second === "failed") ok("两笔都如实报了写库失败");
  else fail(`夹具没生效(${first} / ${second})`);

  const flushed = await flushPendingCleanupNotes();
  const row = await rowOf(token);
  if (flushed.landed >= 1 && row) ok("补投把它落库了");
  else fail(`补投没落库(landed=${flushed.landed}、行=${!!row})`);
  if ((row?.openMembers ?? "").includes(String(alive.pid))) {
    ok("而且那个号还在行上的名单里(更弱的输入没把它顶掉)");
  } else fail(`名单被后一笔覆盖成了 ${row?.openMembers ?? "null"} —— 审查实测的那条路`);

  await sweep();
  if (await rowOf(token)) ok("清扫据此留账:那个号还活着,核销不掉");
  else fail("清扫把这一行销了 —— 名单在,却没挡住销账");
  await forget(token);

  // 另一半:第一笔写失败、**第二笔写成功**。这时并集必须发生在落库那一句上 ——
  // 待投清单上那一笔还没落盘,库里也还没有这一行,少了这一并就没有第三处能找回它。
  const token2 = `${token}-landed`;
  hole.insert = () => { throw new Error("夹具:这一刻库写不进去"); };
  await noteCleanupDebt({
    unitToken: token2, rootPid: 4248, state: "unknown",
    detail: "夹具:点了名、写不进去", unitVerdict: "unprovable", open: [alive],
  });
  hole.insert = realInsert;
  const landed = await noteCleanupDebt({
    unitToken: token2, rootPid: 4248, state: "unknown",
    detail: "夹具:这一笔写得进去,但名单是空的", unitVerdict: "unprovable", open: [],
  });
  const row2 = await rowOf(token2);
  if (landed === "noted" && (row2?.openMembers ?? "").includes(String(alive.pid))) {
    ok("第二笔落库时把内存待投清单上那个名也并了进去");
  } else fail(`落库那一笔丢了名单(${landed}、${row2?.openMembers ?? "null"})`);
  await forget(token2);
}

console.log(bad ? `\n\u2717 ${bad} \u9879\u672a\u901a\u8fc7` : "\n\u2713 \u5168\u90e8\u901a\u8fc7");
process.exit(bad ? 1 : 0);
