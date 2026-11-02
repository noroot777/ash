// **看门狗静默档的判据本体** —— 「回合起来了,输入却从未送到」那一类现场的第三道闸。
// 跑:npm -w server run test:undriven-turn(与 test-undriven-turn.ts 同一条命令,先跑这一份)
//
// 起因与另两道闸见 test-undriven-turn.ts 的文件头(同一次事故:2026-11-02 任务 WfLfTjaGzcA8
// 零输出 1.5 小时)。**从那份里拆出来的理由只有一个:它顶到了单文件上限**(根 CLAUDE.md 的
// 700 行),而这几段跟那边的依赖不重合 —— 这一份一个真进程都不起:看门狗是纯状态机
// (`turn-stall.ts` 文件头最后一段),判据侧只多一个落盘的进展记号。那边才是真实 CLI /
// 真实 app-server / 投递记账那条链。
//
// 这一份里每一段红了都指向同一个问题:**「它压根没跑起来」与「它跑得正好,只是我没看见
// 前半段」被当成了同一件事**(或者反过来)。两个方向各有实测:
//   · 当成「没跑起来」→ 杀掉一个正在跑 sleep 3600 的健康回合(第 1 轮 F1、第 2 轮 F2);
//   · 当成「跑得正好」→ 一条输出都没有的回合挂满 1.5 小时,看门狗一拍都没动(事故本体)。
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-silence-tier-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const { ensureSchema } = await import("../src/db/index.js");
const { configure, spy, sleep, notice } = await import("./stall-fixtures.js");
const { trackTurnStall, watchTurnSilence, clearTurnStall } = await import("../src/turn-stall.js");
await ensureSchema();

let failures = 0;
const ok = (line: string) => console.log(`   ✓ ${line}`);
const fail = (line: string) => { failures += 1; console.error(`   ✗ ${line}`); };
const check = (cond: boolean, line: string) => (cond ? ok(line) : fail(line));

console.log("① 看门狗静默档:回合开始后一条进展都没有");
// 回合起点必须是**真的过去**:静默档按 `Date.now() - 回合起点` 算欠的时间,写一个固定字面量
// 就会随日历漂成未来值,`Math.max(0, …)` 把 elapsed 夹成 0 —— 那几段会一声不响地假绿。
const turnAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
{
  // 口径压到毫秒级,时间档靠共享计时器走(最后一条事件之后再也不会有事件,这一档只能靠它)。
  // 阈值与 sleep 都要绕开 `arm()` 的 200ms 轮询下限(turn-stall.ts 的 pollMs):时间档只能
  // 靠那个共享计时器走,压到比一拍还短就只是在测夹具自己。
  configure({ silentWarnMs: 100, silentTripMs: 1_200, pollMs: 200 });
  const { actions, log } = spy();
  const owner = {};
  // 起点取**回合真实起点**,所以「挂得晚」不打折 —— 接管回来的会话正是这一种。
  watchTurnSilence("s-silent", owner, turnAgo(50), actions);
  await sleep(500);
  check(log.warns.length === 1, `静默到警告阈值就报了一次(${log.warns.length} 次)`);
  check(/回合无输出/.test(log.warns[0]?.text ?? ""), "措辞是「回合无输出」,不是「上游停滞」那一套");
  check(log.projects.length > 0, "持久投影也做了(刷新后仍看得出来)");
  check(log.trips.length === 0, "警告档触发时还不该熔断(两档分开)");
  await sleep(1_200);
  check(log.trips.length === 1, `到熔断阈值自动终止本回合(${log.trips.length} 次)`);
  check(/已自动终止本回合/.test(log.trips[0] ?? ""), "熔断诊断如实说「已终止并按失败结算」");
  clearTurnStall("s-silent", owner);
}
{
  // 一条进展就摘掉它:正常回合一档都不许触发。
  configure({ silentWarnMs: 100, silentTripMs: 300, pollMs: 200 });
  const { actions, log } = spy();
  const owner = {};
  const progressTurn = turnAgo(50);
  watchTurnSilence("s-progress", owner, progressTurn, actions);
  trackTurnStall("s-progress", owner, progressTurn, { kind: "tool", name: "exec", detail: "pytest -q" }, actions);
  await sleep(700);
  check(log.warns.length === 0 && log.trips.length === 0,
    "开场就是一条跑半小时的命令 —— 工具调用本身就是进展,一档都没触发");
  // 摘掉之后这一轮不该被重新盯上(消费链不会再挂,事件也开不了静默档)。
  watchTurnSilence("s-progress", owner, progressTurn, actions);
  await sleep(700);
  check(log.warns.length === 0 && log.trips.length === 0, "有过进展的回合不会被静默档重新盯上");
}
{
  // 接管时唯一会出现的那种事件(`session` 报一遍会话身份)**不算进展** —— 事故现场就只有它。
  configure({ silentWarnMs: 100, silentTripMs: 60_000, pollMs: 200 });
  const { actions, log } = spy();
  const owner = {};
  const sessionTurn = turnAgo(50);
  watchTurnSilence("s-session", owner, sessionTurn, actions);
  trackTurnStall("s-session", owner, sessionTurn, { kind: "session", cliSessionId: "th-undriven" }, actions);
  await sleep(500);
  check(log.warns.length === 1, "只报了一遍会话身份,静默档照样该报警");
  clearTurnStall("s-session", owner);
}
{
  // 期间来了错误事件 → 前提被推翻,换成错误档那一份,**不许沿用静默档的起点提早熔断**。
  configure({ silentWarnMs: 60_000, silentTripMs: 60_000, warnErrors: 1, tripMs: 900, pollMs: 200 });
  const { actions, log } = spy();
  const owner = {};
  const late = turnAgo(5_000);
  watchTurnSilence("s-switch", owner, late, actions);
  trackTurnStall("s-switch", owner, late, notice(), actions);
  check(log.warns.length === 1 && /上游停滞/.test(log.warns[0]!.text),
    "换成错误档的措辞(它手上有重试统计可说)");
  await sleep(500);
  check(log.trips.length === 0,
    "起点跟着换回「第一条错误到达时」—— 没有把回合已经跑掉的 5 秒算进熔断钟");
  await sleep(700);
  check(log.trips.length === 1, "到错误档自己的阈值才熔断");
  clearTurnStall("s-switch", owner);
}

console.log("② 接管·这一轮在别的进程里已经有过进展 → 静默档压根不该开(第 1 轮自由审查 F1)");
{
  const { openTurnProgress, noteTurnProgress, turnProgress, __resetTurnProgressMarks } =
    await import("../src/turn-progress-mark.js");
  __resetTurnProgressMarks();
  // 这一档刻意只在「确证没有过进展」时开:接管回来的新句柄看不到 agentOffset 之前那一段,
  // 光凭内存里那张 WeakMap 判,等于把「跑着 sleep 3600 的健康回合」和「输入压根没送到」
  // 当成同一件事 —— 审查实测到的就是这个误杀(重启前 offset=454、trace 里有 exec sleep 3600,
  // 接管后新进程写「一条输出都没有过」并终止了它)。
  const turn = new Date(Date.now() - 90 * 60_000).toISOString(); // 欠了 90 分钟,远超 45 分钟熔断线
  openTurnProgress("t-progress", "s-progress-mark", turn);
  check(turnProgress("t-progress", "s-progress-mark", turn) === "none",
    "本进程开的这一轮(参与证明在)、记号没写 → 确证这一轮没有过进展");

  // ②a 记号在(上一个进程见过进展)→ 不开档,一拍都不许动
  configure({ silentWarnMs: 100, silentTripMs: 400, pollMs: 200 });
  noteTurnProgress("t-progress", "s-progress-mark", turn);
  check(turnProgress("t-progress", "s-progress-mark", turn) === "seen", "记号落盘了,读回来是 seen");
  const seenSpy = spy("t-progress");
  watchTurnSilence("s-progress-mark", {}, turn, seenSpy.actions, "seen");
  await sleep(700);
  check(seenSpy.log.warns.length === 0 && seenSpy.log.trips.length === 0,
    "本轮已有进展 → 静默档不开,正在跑长工具的健康回合不会被误杀");

  // ②b 读不出来 → 同样不开(宁可漏判,不可拿一个核实不了的前提去杀)
  const blindSpy = spy("t-missing");
  watchTurnSilence("s-blind", {}, turn, blindSpy.actions, "unreadable");
  await sleep(700);
  check(blindSpy.log.warns.length === 0 && blindSpy.log.trips.length === 0,
    "有无进展核实不了 → 静默档不开");

  // ②c 确证没有过 → 照旧开(别把这一档修没了)
  const noneSpy = spy("t-none");
  watchTurnSilence("s-none", {}, turn, noneSpy.actions, "none");
  await sleep(700);
  check(noneSpy.log.warns.length === 1 && noneSpy.log.trips.length === 1,
    "确证零进展 → 警告加熔断照旧(这一档没被修没)");
  clearTurnStall("s-none", {});

  // ②d 消费链真的把「第一条进展事件」落到盘上了吗 —— 判据侧的那一半
  __resetTurnProgressMarks();
  const liveTurn = new Date().toISOString();
  const owner = {};
  const noted: string[] = [];
  const probe = spy("t-note");
  trackTurnStall("s-note", owner, liveTurn, { kind: "tool", name: "bash", input: "sleep 3600" } as never,
    { ...probe.actions, noteProgress: () => noted.push("first") });
  trackTurnStall("s-note", owner, liveTurn, { kind: "text", text: "干活了" } as never,
    { ...probe.actions, noteProgress: () => noted.push("again") });
  check(noted.join(",") === "first", `只在本轮第一条进展事件上落一次盘(实际:${noted.join(",") || "一次都没有"})`);

  // ②e **「确证零进展」的前提不许由判的人自己造出来**(第 2 轮自由审查 F2,已跨版本实测)
  //
  // 上一版的前提是「目录在」,而接管那条路自己就会先把目录建出来 —— 于是升级前那一代开的
  // 回合(压根没有这套记号、正跑着 sleep 3600)在接管后又被判成「一条输出都没有过」杀掉,
  // 跟第 1 轮 F1 一模一样的误杀,只换了触发路径。所以证明力绑在**逐轮**的参与证明上。
  __resetTurnProgressMarks();
  const mine = new Date(Date.now() - 90 * 60_000).toISOString();
  const elders = new Date(Date.now() - 95 * 60_000).toISOString(); // 旧代开的那一轮
  openTurnProgress("t-proof", "s-proof", mine); // 本进程开了自己这一轮(顺手把目录建了出来)
  check(turnProgress("t-proof", "s-proof", mine) === "none",
    "前提:本进程开的那一轮确实判「确证零进展」(否则下面那条断言是假绿)");
  check(turnProgress("t-proof", "s-proof", elders) === "unreadable",
    "同一个目录下、没有逐轮参与证明的那一轮 → 核实不了,不是「确证零进展」(F2 的根因)");
  const elderSpy = spy("t-proof");
  watchTurnSilence("s-proof", {}, elders, elderSpy.actions, turnProgress("t-proof", "s-proof", elders));
  await sleep(700);
  check(elderSpy.log.trips.length === 0,
    "于是旧代开的那一轮不会被接管方杀掉(实测过的那次误杀:它正跑着 sleep 3600)");

  // ②f **记不住进展的人没资格声明「它没产出」**:写记号失败要把参与证明撤掉
  __resetTurnProgressMarks();
  const fragile = new Date(Date.now() - 90 * 60_000).toISOString();
  openTurnProgress("t-fragile", "s-fragile", fragile);
  check(turnProgress("t-fragile", "s-fragile", fragile) === "none", "前提:参与证明落下了");
  // 把记号那个路径做成指向不存在目录的软链 → 落记号必然失败(ENOENT),而撤参与证明照样做得到。
  // (故意不占成目录:那样 `existsSync` 会答真,读出来是 `seen` —— 那是夹具的假象,不是被测行为。)
  const markPath = join(root, "runs", "t-fragile", "progressed", `s-fragile-${fragile.replace(/[^0-9]/g, "")}`);
  symlinkSync(join(root, "no-such-dir", "mark"), markPath);
  check(noteTurnProgress("t-fragile", "s-fragile", fragile) === false,
    "落盘失败如实答 false(看门狗据此在下一条进展事件上重试)");
  check(turnProgress("t-fragile", "s-fragile", fragile) === "unreadable",
    "参与证明被撤掉 → 这一轮退回「核实不了」,宁可漏判也不误杀");

  // ②g **连撤销也失败时,水位替它说话**(第 3 轮自由审查 F5)
  //
  // ②f 那条撤销自己也会失败,而且失败得成对:目录变只读、文件系统切只读 —— 同一个原因让
  // 「写进展」和「撤证明」一起失败。于是 `.watch` 留在那里继续声明「会记的人在盯,它没记过」,
  // 而那一轮其实正在产出、输出甚至已经被消费并提交了水位 → 接管回来按旧起点计时,长工具照杀。
  // 所以「确证没产出」要两个事实:证明在,**而且持久消费水位一字未动**。
  __resetTurnProgressMarks();
  const longTool = new Date(Date.now() - 90 * 60_000).toISOString();
  openTurnProgress("t-watermark", "s-watermark", longTool, 454); // 开轮那一刻已消费 454 字节
  check(turnProgress("t-watermark", "s-watermark", longTool, 454) === "none",
    "前提:水位一字未动 → 照旧是「确证零进展」(这一档没被修没)");
  check(turnProgress("t-watermark", "s-watermark", longTool, 1_200) === "seen",
    "水位从 454 前进到 1200 → 这一轮产出过(即使进展记号没写成、证明也撤不掉)");
  const burntSpy = spy("t-watermark");
  watchTurnSilence("s-watermark", {}, longTool, burntSpy.actions,
    turnProgress("t-watermark", "s-watermark", longTool, 1_200));
  await sleep(700);
  check(burntSpy.log.trips.length === 0,
    "于是那个正跑长工具的回合不会被杀(F5 实测形状:进展写失败 + 撤销也失败)");
  // 老格式的证明(没记水位)照旧只按记号判 —— 升级不改判据。
  openTurnProgress("t-watermark", "s-legacy", longTool);
  check(turnProgress("t-watermark", "s-legacy", longTool, 9_999) === "none",
    "没记水位的旧证明:仍按记号判「确证零进展」,不因为给了个水位就改口");
}

console.log("③ 换档不许丢掉已经发出去的红环(第 1 轮自由审查 F6)");
{
  // 静默档报警 → 投影出红环 → 来一条错误事件换成错误档 → 在错误档阈值之前恢复输出。
  // 旧代码:新记录 warned=false,close 直接返回,旧 since 对应的红环永久亮着(刷新还在)。
  configure({ warnErrors: 5, warnMs: 300_000, tripMs: 300_000, silentWarnMs: 100, silentTripMs: 600_000, pollMs: 200 });
  const { log, actions } = spy("t-swap");
  const owner = {};
  const turn = new Date(Date.now() - 60_000).toISOString();
  watchTurnSilence("s-swap", owner, turn, actions, "none");
  await sleep(500);
  check(log.warns.length === 1 && log.projects.length === 1, "静默档报了警并把红环投影出去");
  const projectedSince = log.projects[0]!.since;
  check(projectedSince === turn, "红环的身份是回合真实起点(静默档的 since)");

  trackTurnStall("s-swap", owner, turn, notice(), actions);
  check(log.trips.length === 0, "一条重试提示还不到错误档阈值,没熔断");
  trackTurnStall("s-swap", owner, turn, { kind: "text", text: "模型又说话了" } as never, actions);
  check(log.resolves.length === 1, "恢复输出后红环被撤掉了(旧代码:一次都不撤)");
  check(log.resolveSince[0] === projectedSince,
    `撤的是**置上它的那一刻**,CAS 才匹配得上(撤的=${log.resolveSince[0]}, 置的=${projectedSince})`);
  clearTurnStall("s-swap", owner);
}

console.log("④ 熔断之后迟到的错误事件不许把终止义务清零(第 1 轮自由审查 N2)");
{
  configure({ warnErrors: 1, warnMs: 0, tripMs: 0, silentWarnMs: 100, silentTripMs: 300, pollMs: 200 });
  const { log, actions } = spy("t-late");
  const owner = {};
  const turn = new Date(Date.now() - 60_000).toISOString();
  watchTurnSilence("s-late", owner, turn, actions, "none");
  for (let i = 0; i < 20 && log.trips.length === 0; i += 1) await sleep(100);
  check(log.trips.length === 1, "静默档熔断了这一轮");
  // 迟到的错误事件:旧代码在这里 openStall,把 trippedAtMs/escalated 一起清零 —— 同一轮
  // 会被重新警告、重新判决一遍。终止义务只有两个出口,换档不是其中之一。
  trackTurnStall("s-late", owner, turn, notice(), actions);
  await sleep(600);
  check(log.trips.length === 1, `熔断只宣布一次(实际 ${log.trips.length} 次)`);
  clearTurnStall("s-late", owner);
}

if (failures) {
  console.error(`\n✗ ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n✓ 静默档判据全部通过");
process.exit(0);
