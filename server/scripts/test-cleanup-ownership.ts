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
//
// 第三节往后是第 11 轮审查 F1 那条链:记号认下的成员(`ours`)跨不过 `exec`。第三节证代数,
// 第四节证**接线** —— 清扫那一步真的把这一轮确证过的成员交给了判定。
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
const ok = (m: string) => console.log(`   ✓ ${m}`);
const fail = (m: string) => { bad += 1; console.log(`   ✗ ${m}`); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rowOf = async (key: string) => {
  const listing = await listAllCleanupDebts();
  if (!listing.ok) throw new Error(`债表读不出来:${listing.reason}`);
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
    where: `行上=${onRow ? "有" : "无"} 待投=${inMemory ? "有" : "无"}`,
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
  owed.own([{ pid: livePid, gen: liveGen }], "夹具:已确认归属、没敲到它");
  // 这一轮「点的名」是空的(父边读得出来、没有 fault),可账本上有一个已确认的活成员。
  owed.add([]);
  if (owed.verdict().kind !== "empty" && owed.left().some((o) => o.pid === livePid)) {
    ok(`这一轮一个名没点、账上有一个活成员 ⇒ 结论是 ${owed.verdict().kind},不是 empty`);
  } else fail("已确认的活成员没拦住判空 —— 就是审查实测的那一下");

  alive.kill("SIGKILL");
  await wait(400);
  if (owed.verdict().kind === "empty" && !owed.left().length) {
    ok("它退了之后同一本账自己消解 —— 正常收尾不压假债");
  } else fail(`有退出证据了还赖着不走(${owed.verdict().kind})`);

  // 同一个号的两代是两份责任(第 9 轮审查 F1-D),`own` 这条路上同样不许混。
  const twoGen = openLedger();
  twoGen.own([{ pid: livePid, gen: liveGen }], "夹具:旧那一代");
  twoGen.own([{ pid: livePid, gen: "t:别的那一代" }], "夹具:新那一代");
  if (twoGen.left().length === 0) ok("两代都有退出证据时两条一起消解");
  else fail(`这两条本该都被核销(剩 ${twoGen.left().length} 条)`);
}

// ── 第二节:持久交接(落脚处那条不变量)──────────────────────────────────────────
console.log("\n2) 责任交接:noted 要意味着这几个号真的有人接住了");
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
    state: "unknown", detail: "夹具", unitVerdict: "unprovable", open,
  });

  // 前提:先落一笔合法的,行上有名单。
  await note([{ pid: pidA, gen: genA, why: "夹具:先点上名" }]);
  const seeded = await livesSomewhere(key, pidA);
  if (seeded.row) ok("前提:第一笔落了库,行上点着这个号");
  else fail(`夹具没落下(${seeded.where})`);

  // C/D:把行上那一列弄成读不出来,再来一笔**带新身份**的。行会写成功,而这一列一个字不动 ——
  // 旧名单因此没丢(那是对的),可新身份一个都没交出去,所以这一笔不许冒充 noted。
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await wait(300);
  const pidB = other.pid!;
  const genB = processGenerationSync(pidB);
  await db.update(agentCleanupDebts)
    .set({ openMembers: "{不是数组" })
    .where(eq(agentCleanupDebts.unitToken, key));
  const verdict = await note([{ pid: pidB, gen: genB, why: "夹具:新发现的活身份" }]);
  if (verdict === "failed") ok("旧名单读不出来 ⇒ 如实报「没落下」,不冒充 noted");
  else fail(`这一笔报的是 ${verdict} —— 叙述落了就算责任接住了，就是审查实测的那一下`);
  const half = await livesSomewhere(key, pidB);
  if (half.pending) ok(`而且它还有落脚处:${half.where}`);
  else fail(`这个活身份哪儿都不在了(${half.where})`);

  // E:补投这一笔同样要问「接住了吗」。名单还是坏的 ⇒ 投不进去,清单上那一笔不许丢。
  //
  // 走的是 `writeNote → noteDebtRow` 这条出口(叙述没过期)。另一条出口 `mergeOpenIntoRow`
  // (叙述已被更新的一版盖过、只补名单)这一轮也改成了如实反馈成败,但**它在当前时序下
  // 没有独立反例**:能盖过旧叙述的那一笔必然已经把旧 pending 的名单并进了行里,所以那条路
  // 上即使「没接住」也不会丢责任。审查报告 C2 的判断相同 —— 不把辅助函数的潜在脆弱点
  // 虚报成已证实故障,只要求两条出口的确认语义一致。
  const stuck = await flushPendingCleanupNotes();
  if (stuck.pending > 0 && (await livesSomewhere(key, pidB)).pending) {
    ok("补投没人接 ⇒ 清单上那一笔留着(不是打一行日志就完事)");
  } else fail(`补投把责任丢了(pending=${stuck.pending})`);

  // 名单修好之后那一笔要能落下去 —— 这条不变量是「不许丢」,不是「永远卡着」。
  await db.update(agentCleanupDebts)
    .set({ openMembers: "[]" })
    .where(eq(agentCleanupDebts.unitToken, key));
  await flushPendingCleanupNotes();
  const landed = await livesSomewhere(key, pidB);
  if (landed.row) ok("行上那一列修好之后,那个号落到了行上");
  else fail(`跟进不上去(${landed.where})`);

  // F:两个号都退了之后,同一份判据要能把账销掉(假债同样是故障)。
  idle.kill("SIGKILL");
  other.kill("SIGKILL");
  await wait(500);
  const swept = await sweepAgentCleanupDebts();
  if (!swept.ok) throw new Error(`清扫没给出结论:${swept.reason}`);
  if (!await rowOf(key)) ok("两个号都退了 ⇒ 这一行销掉,不留假债");
  else fail("有退出证据了还留着行 —— 那是另一头的故障");
}

// ── 第三节:记号证据的确证成员(它跨不过 exec)────────────────────────────────────
console.log("\n3) 记号认下的成员:确证过那一刻就是唯一的窗口");
{
  // 第 11 轮审查 F1 实测那条链的代数核心:`ours` 的成员自带 pid + 跟记号同源的那一代,是
  // 整条链上最硬的归属证明 —— 可它**跨不过 `exec`**。成员收到 TERM 之后 `execle` 换一个
  // 干净环境,pid 和那一代一个字没变,记号那一问却从此答 `none`。上一版两次读数只喂给
  // `signalMembers`,判定那一步收不到它们,于是「刚朝它开过刀」的成员在下一句变成「这台
  // 设备说没有」,行被真的 DELETE(审查读数:同一个进程仍 alive、心跳 53→58,债表 0 行)。
  const { unitOpen } = await import("../src/executors/cleanup-result.js");
  const { markerResidue } = await import("../src/executors/cleanup-debt-judge.js");
  const { openOf } = await import("../src/executors/cleanup-result.js");
  const mine = process.pid;
  const gen = processGenerationSync(mine);
  const ours = { verdict: "ours", members: [{ pid: mine, gen }] } as const;
  const gone = { verdict: "none" } as const;

  if (unitOpen(ours, "夹具").some((o) => o.pid === mine && o.gen === gen)) {
    ok("ours 的成员带着号 + 同源代次交出来");
  } else fail("ours 的成员没有转成未决身份");

  // `suspected` 是 `ps -E` 的展示文本(macOS):只证明看得见,不给落点,所以也不点名 ——
  // 点了名就等于拿一份弱证据去押一笔核不动的债(判据见 proc.ts 那一层)。
  const weak = { verdict: "suspected", pids: [mine] } as const;
  if (!unitOpen(weak, "夹具").length && !unitOpen(gone, "夹具").length) {
    ok("suspected / none 不点名(弱证据不押账)");
  } else fail("把展示文本档当成确证身份了");

  // **这一刻 ours、下一刻 none,身份不许消失** —— 就是 exec 那一下的代数等价物。
  const owed = openLedger();
  owed.add(unitOpen(ours, "记号认下、这一轮朝它开过刀的成员"));
  owed.add(unitOpen(gone, "下一次读数"));
  if (owed.verdict().kind !== "empty" && owed.left().some((o) => o.pid === mine)) {
    ok("下一次记号答 none 也洗不掉它(exec 换不掉 pid 和那一代)");
  } else fail("下一次答 none 就把它忘了 —— 审查实测的那条链");

  // 判定那一侧:ours 这一档要把成员点在结论上,`touchDebtRow` 落的就是 `openOf(result)`,
  // 所以点在这里等于跨得过重启。
  const said = markerResidue(ours, true);
  const mute = markerResidue(weak, true);
  if (said && openOf(said).some((o) => o.pid === mine) && mute && !openOf(mute).length) {
    ok("判定侧:ours 点名、suspected 不点(身份跟着行落盘)");
  } else fail(`判定侧没把 ours 的成员点在结论上(${said?.kind})`);
}

// ── 第四节:那条链的端到端(exec 洗掉记号之后,行不许被销掉)──────────────────────
console.log("\n4) 落到债行上:记号这一刻认下、下一刻答 none,行不许被删");
{
  // 第三节证的是代数,这一节证**接线**:清扫那一步(`pushDebtLocked`)把这一轮确证过的成员
  // 交给了判定。反事实 —— 把那份名单从判定的入参里拿掉 —— 这一组会红:记号那一问答 none、
  // 路径没线索、根那一问有正面退出证明 ⇒ 行被真的 DELETE,而那个进程还在跑。这正是审查
  // 实测的读数(同一个进程仍 alive、心跳 53→58、债表 0 行)。
  //
  // `ours` 这一档只有 Linux 的 `/proc/<pid>/environ` 给得出,这台机器是 macOS ⇒ 按
  // fake-proc 台子的剧本回答那四个读取点,**判档、代次比较、发信号、进程死活全是产品里
  // 那一份**(见那份夹具的顶注:它证的是「这套取证逻辑在 exact 档上的行为」,不是在原生
  // Linux 上压出了 pid 复用)。剧本就是 `exec` 那一下:第一遍扫描读到记号(`ours`),之后
  // 再也读不到(`none`),而 pid 和那一代一个字没变 —— 所以它核销不掉。
  const { install: fakeProc, restore: realProc, counters } = await import("./fake-proc-fixture.js");
  const { processUnitEvidence } = await import("../src/proc.js");
  const key = "unit:ownership-exec";
  const script = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
  // **忽略 SIGTERM**:产品会真朝它开一刀(剧本的第一遍答 ours,那一档敢下刀),而要测的处境
  // 恰恰是「挨了刀还活着、记号却已经没了」。
  const survivor = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  await wait(400);
  const pid = survivor.pid!;
  const script_env = { tokensOnEnvRead: (n: number) => (n <= 2 ? [key] : []), genOnStatRead: () => "111" };

  fakeProc(pid, script_env);
  const opening = processUnitEvidence(key, { fresh: true });
  if (opening.verdict === "ours" && opening.members.some((m) => m.pid === pid)) {
    ok("台子前提:记号这一问先认下了这个号(exact 档)");
  } else fail(`台子没搭起来(记号这一问答的是 ${opening.verdict})`);

  await noteCleanupDebt({
    unitToken: key, taskId: "t-exec", sessionId: "s-exec",
    // 根那一问要有**正面退出证明**,否则整行永远走收档,这一组测不到销账那一头。
    rootPid: 0x7ffffff, rootStartedAt: null, trackPath: null, outPath: null,
    state: "unknown", detail: "夹具:exec 洗掉了记号", unitVerdict: "ours", open: [],
  });

  // 夹具纪律 ①:被测函数之前重新 install 归零 —— 这样清扫里的第一遍取证就是剧本的第 1、2 次。
  // (`noteCleanupDebt` 自己不取证,三处取证全在清扫那条链上。)
  fakeProc(pid, script_env);
  // 纪律 ②:台子一直开到最后一发延迟信号结束(那里面有一发等 2 秒的补刀)。
  const swept = await sweepAgentCleanupDebts();
  const reads = counters.env;
  realProc();
  if (!swept.ok) throw new Error(`清扫没给出结论:${swept.reason}`);

  const row = await rowOf(key);
  const where = row ? await livesSomewhere(key, pid) : null;
  if (row && where?.row) ok("记号下一刻答 none,行还在、而且点着那个号");
  else fail(`行被销掉了,或者号没点上(${where?.where ?? "行已经没了"}) —— 审查实测的那一下`);
  // 台子真的被走过三遍(opening / again / 判定里那一问),否则上面那句「还在」可能只是
  // 剧本错位(记号从头到尾都读得到)蒙对的。
  if (reads >= 6) ok(`取证走了 ${reads} 次环境读 ⇒ 三遍都真的问过`);
  else fail(`剧本错位:只读了 ${reads} 次环境(期待 ≥6),上面那句不算检验`);
  if (survivor.exitCode === null) ok("前提成立:那个进程确实还活着(所以销账会是假的)");
  else fail("夹具进程自己死了 —— 这一组没测到东西");
  survivor.kill("SIGKILL");
}

// ── 第五节:执行这条不变量的那道闸,自己也要跨平台 ────────────────────────────────
console.log("\n5) 结论类型的绕过闸:owner 豁免不能在 Windows 上失效");
{
  // 第 11 轮审查 F3:那道闸原本拿 `relative()` 的结果去跟一个写死正斜杠的字符串逐字比,
  // 而 Windows 原生 `relative` 返回反斜杠 —— 恒不等,于是 owner 自己那几处合法定义被当成
  // 绕过,build 前置退 1、tsc 压根跑不到。这台机器是 macOS,所以**把两套路径语义都显式
  // 跑一遍**(`path.win32` / `path.posix`),而不是等真机才发现。
  const { isOwnerFile, OWNER_SEGMENTS } = await import("../../scripts/check-cleanup-evidence.mjs");
  const { win32, posix } = await import("node:path");

  const winRoot = "D:\\ai_workspace\\ash";
  const winOwner = win32.join(winRoot, ...OWNER_SEGMENTS);
  const posixRoot = "/Users/fjh/code/harness";
  const posixOwner = posix.join(posixRoot, ...OWNER_SEGMENTS);

  if (isOwnerFile(winOwner, winRoot, win32)) ok(`Windows 语义下认得出 owner(${winOwner})`);
  else fail(`Windows 上 owner 豁免失效 —— build 会被误拦(${winOwner})`);
  if (isOwnerFile(posixOwner, posixRoot, posix)) ok("POSIX 语义下照旧认得出");
  else fail("POSIX 上反而认不出 owner 了");
  // 反面:别的文件不许被当成 owner(豁免放宽了等于那道闸形同虚设)。
  const other = win32.join(winRoot, "server", "src", "single-run.ts");
  if (!isOwnerFile(other, winRoot, win32)) ok("别的文件不会被豁免");
  else fail("豁免匹配太宽,那道闸形同虚设");
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过");
process.exit(bad ? 1 : 0);
