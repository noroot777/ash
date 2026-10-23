// **归属证明必须跟「读到它的那一代」绑在一起** —— 第 15 轮审查 F1 的回归。
//
// 审查复现的那一刀:取证分两步做,第一步读两遍进程表的环境、把两遍的**裸 pid** 取并集,
// 第二步才对并集里的号各问一次 `ps` 要启动时刻拼成「成员」。于是第一遍读到记号的那一代退掉、
// 这个号被别人接手时,**新进程的启动时刻被写成了前一个进程的归属证明**,首次信号和两秒后的
// 补刀都据此下刀(`generation.log`:`actualDiagnosticEnvironmentHasUnitKey=false`、
// `diagnosticAliveAfterProductionKill=false`)。
//
// 修在证据产出层:每一次读数自己把代次带出来(process-generation.ts),扫描按「号 + 代次」
// 归堆(monitor-unit-scan.ts),**每一刀之前再拿那个戳重问一遍**(monitor-reclaim-evidence.ts)。
// 这一份把五条边界各钉一遍,外加一条**正向对照** —— 没有它,「永远不下刀」也能让其余五条通过。
//
// ── 这份台子怎么造出 `exact` 那一档(如实说明)─────────────────────────────────────
//
// `exact` 档的前提是 `/proc/<pid>/environ`(NUL 分隔的真实环境项),**macOS 上没有 `/proc`**,
// 而本项目约定不许在 macOS 上替别的平台编结论。所以这里跟审查同一个办法:**只替换
// `node:fs` 的三个读取边界**(`existsSync`/`readdirSync`/`readFileSync`),给被审代码造一个
// 受控的 `/proc` 世界;**被测的扫描、归属判断、代次比较、发信号函数全是产品里那一份,
// 进程、信号、死活都是真的**。它证的是「这套取证逻辑在 exact 档上的行为」,
// **不是**「在原生 Linux 内核上压出了 pid 复用」—— 后者这台机器做不到,报告里也照实写。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { isPidAlive, isProcessGroupAlive, killTree } from "../src/platform.js";
import { processUnitEvidence } from "../src/proc.js";
import { processGenerationSync, processGroupMembersSync } from "../src/process-generation.js";
import { killProvenUnit, reclaimState } from "../src/monitor-reclaim-evidence.js";
import { counters, install, restore, skipWithoutProcWorld, type FakeAnswers } from "./fake-proc-fixture.js";
if (skipWithoutProcWorld("凭证与代次绑定回归")) process.exit(0);


/** 一个真的活着、自成进程组的旁观者:下面每一条都拿它当「可能挨刀的那一个」。 */
function bystander(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH! },
  });
  child.unref();
  return child.pid!;
}

const victims: number[] = [];
function born(): number {
  const pid = bystander();
  victims.push(pid);
  return pid;
}

/** 真实进程 + 真实信号:跑完这一条之后它活着没有。 */
async function stillAliveAfterShot(pid: number): Promise<boolean> {
  await delay(400);
  return isPidAlive(pid);
}

try {
  {
    // ⑭-1 **同一代、两遍读数对不上 ⇒ 这个记号在这一代上不算凭证**(审查注入的正是这一种:
    //     第一遍读到记号、第二遍同号同代读不到)。两种解释都不授权下刀:要么这两次读数里有
    //     一次不是这一代的,要么它中途 `exec` 换了环境(`exec` 不改 pid 也不改 starttime)。
    const pid = born();
    const token = `gen-contradict-${process.pid}`;
    const answers: FakeAnswers = {
      tokensOnEnvRead: (n) => (n === 1 ? [token] : []),
      genOnStatRead: () => "111",
    };
    install(pid, answers);
    const evidence = processUnitEvidence(token, { fresh: true });
    assert.notEqual(evidence.verdict, "ours", "同一代两遍对不上,不许签发归属凭证");
    assert.equal(evidence.verdict, "unprovable", "而且这一遍不算问全:不许冒充「一个都没有」");
    install(pid, answers);
    // 记号那一问落「证不出」之后,这个号自己还活着 ⇒ 退回根的代次那一问,而台子没给记录的
    // 启动时刻 ⇒ `unverifiable`(无从比对)。**两档都不下刀**,这里要的就是这件事。
    assert.equal(reclaimState(pid, null, { unitToken: token }), "unverifiable");
    install(pid, answers);
    killProvenUnit(pid, null, { unitToken: token });
    restore();
    assert.equal(await stillAliveAfterShot(pid), true, "一刀都不许发");
  }

  {
    // ⑭-2 **第一遍有记号、第二遍这个号已经换代** —— 报告里那条主路。旧实现把两遍的裸 pid
    //     取并集、事后补问启动时刻,于是**后来那一代的身份被补给了先前那个事实**,接着挨刀。
    //     现在第一遍是 `(pid, j:111)`、第二遍是 `(pid, j:222)` 两堆:凭证只属于 111 那一代,
    //     而发信号前重问这个号拿到的是 222 ⇒ 不是它,不发。
    const pid = born();
    const token = `gen-handoff-${process.pid}`;
    const answers: FakeAnswers = {
      tokensOnEnvRead: (n) => (n === 1 ? [token] : []),
      genOnStatRead: (n) => (n <= 2 ? "111" : "222"),
    };
    install(pid, answers);
    const evidence = processUnitEvidence(token, { fresh: true });
    assert.equal(evidence.verdict, "ours", "第一遍那次读数是真的:这一代上确实读到了这一项");
    assert.deepEqual(evidence.members, [{ pid, gen: "j:111" }], "凭证只属于读到它的那一代");
    install(pid, answers);
    killProvenUnit(pid, null, { unitToken: token });
    restore();
    assert.equal(await stillAliveAfterShot(pid), true, "号已经换代 ⇒ 接手这个号的进程绝不许挨刀");
  }

  {
    // ⑭-3 **代次在「读这份环境」的前后变了** ⇒ 这份环境是哪一代的证不出来,整行作废。
    //     夹住这一次读就是为了问出这件事:事后再补问一次只会得到「现在这个号上是谁」。
    const pid = born();
    const token = `gen-interleaved-${process.pid}`;
    const answers: FakeAnswers = {
      tokensOnEnvRead: (n) => (n === 1 ? [token] : []),
      genOnStatRead: (n) => (n === 1 ? "111" : "222"),
    };
    install(pid, answers);
    const evidence = processUnitEvidence(token, { fresh: true });
    assert.equal(evidence.verdict, "unprovable", "读取期间换了代 ⇒ 既不是凭证,也不算问全");
    install(pid, answers);
    killProvenUnit(pid, null, { unitToken: token });
    restore();
    assert.equal(await stillAliveAfterShot(pid), true, "一刀都不许发");
  }

  {
    // ⑭-4 **代次一个字都问不出来 ⇒ 不产生可发信号成员**。这里让 `/proc/<pid>/stat` 失败,
    //     而那个号是**已经退干净的**,所以退回 `ps` 的那条路也答不出来 —— 两种问法都失败。
    //     (活着的进程在 `/proc` 失败时会退回 `ps` 的秒级戳,那是刻意的降级:精度变粗,
    //     但仍然是「同源读出来的代次」,见 process-generation.ts 的头注。)
    const gone = spawn("sh", ["-lc", "exit 0"], { detached: true, stdio: "ignore" });
    gone.unref();
    const pid = gone.pid!;
    while (isPidAlive(pid) || isProcessGroupAlive(pid)) await delay(50);
    const token = `gen-unreadable-${process.pid}`;
    const answers: FakeAnswers = { tokensOnEnvRead: () => [token], genOnStatRead: () => null };
    install(pid, answers);
    const evidence = processUnitEvidence(token, { fresh: true });
    restore();
    assert.notEqual(evidence.verdict, "ours", "代次问不出来的号不许当成已证明的成员");
    assert.equal(evidence.verdict, "unprovable");
    assert.equal(processGenerationSync(pid), null, "台子前提:这个号两种问法都答不出代次");
  }

  {
    // ⑭-5 **根在「枚举组成员」那一问期间换了代 ⇒ 组信号不发,而那份名单也不许留到补刀**。
    //     成员名单本身就是一次全表查询,同步 JS 不冻结别的进程 —— 所以授权不能沿用查询之前
    //     那一份。这里把代次在**第三次** `readdir("/proc")`(即那次组成员查询)之后改掉。
    //
    //     **台子要保持到两秒后那一刀结束**(第 16 轮审查 F1-A 指出上一版就差这一下):
    //     上一版等待之前就 `restore()` 了,于是补刀时拿模拟的 `j:999` 跟恢复后的 macOS
    //     `t:<启动时刻>` 比,不相等是必然的 —— 测试通过,却没检验「陌生进程一直稳定保持在
    //     新代次」这个真正的反例。审查用同一形状实测到:第一刀安全,第二刀真实 SIGKILL。
    const pid = born();
    const token = `gen-root-vanished-${process.pid}`;
    const answers: FakeAnswers = {
      tokensOnEnvRead: () => (counters.readdir >= 3 ? [] : [token]),
      genOnStatRead: () => (counters.readdir >= 3 ? "999" : "111"),
    };
    install(pid, answers);
    assert.equal(reclaimState(pid, null, { unitToken: token }), "ours-alive",
      "台子前提:查询之前这是「根自己证明过、而且还活着」那一档");
    install(pid, answers);
    killProvenUnit(pid, null, { unitToken: token });
    assert.ok(counters.readdir >= 3, "台子前提:组成员那一问真的发生过");
    await delay(600);
    assert.equal(isPidAlive(pid), true, "第一刀:根在查询期间换了代 ⇒ 组信号不许发出去");
    // 台子一直开着,这个号从查询那一刻起稳定在 `j:999`:名单里的代次核得过,
    // **唯一拦住这一刀的只能是「这份名单从来没拿到过归属授权」**。
    await delay(2_200);
    const aliveAfterDelayed = isPidAlive(pid);
    restore();
    assert.equal(aliveAfterDelayed, true, "两秒后那一刀:未经原根重核的候选名单不许当落点");
  }

  {
    // ⑭-6 **正向对照** —— 同一套台子,代次前后一致时**必须真的收掉**。
    //     没有这一条,上面五条用「什么都不杀」也能全过。
    const pid = born();
    const token = `gen-positive-${process.pid}`;
    const answers: FakeAnswers = { tokensOnEnvRead: () => [token], genOnStatRead: () => "111" };
    install(pid, answers);
    assert.equal(reclaimState(pid, null, { unitToken: token }), "ours-alive");
    install(pid, answers);
    assert.deepEqual(processGroupMembersSync(pid), [{ pid, gen: "j:111" }],
      "组成员与代次同源:一次 stat 读里一起拿到");
    install(pid, answers);
    killProvenUnit(pid, null, { unitToken: token });
    restore();
    for (let i = 0; i < 40 && isPidAlive(pid); i += 1) await delay(50);
    assert.equal(isPidAlive(pid), false, "代次一致、归属已证明 ⇒ 这一刀必须真的发出去");
  }
  {
    // ⑭-7 **两种不确定不许混成一个布尔**:「别人家的记号证不出代次」只能影响**那个记号**,
    //     不许把这一遍整体说成「没问全」。混成一个的代价是实测到的 —— macOS 上一个进程
    //     `exec` 换掉 argv、或者刚退成僵尸(`ps` 那一行变成 `(node)`、环境段整段消失),它这一代
    //     的两次读数就对不上;那时所有正在收尾的哨兵都会答「证不出」、一条都收不了档
    //     (`test-monitors.ts` ⑪:该判 `lost` 的行被接回成 `unknown`)。
    const pid = born();
    const stranger = `gen-stranger-${process.pid}`;
    const mine = `gen-mine-${process.pid}`;
    const answers: FakeAnswers = {
      tokensOnEnvRead: (n) => (n === 1 ? [stranger] : []),
      genOnStatRead: () => "111",
    };
    install(pid, answers);
    assert.equal(processUnitEvidence(stranger, { fresh: true }).verdict, "unprovable",
      "看见过这个记号、却证不出在哪一代 ⇒ 对它不许说「一个都没有」");
    install(pid, answers);
    assert.equal(processUnitEvidence(mine, { fresh: true }).verdict, "none",
      "另一个记号这一问是问全了的:不许被别人家的那点不确定拖成「证不出」");
    restore();
    killTree(pid, "SIGKILL");
  }

} finally {
  restore();
  for (const pid of victims) if (isPidAlive(pid)) killTree(pid, "SIGKILL");
  await delay(300);
  const leftovers = victims.filter((pid) => isPidAlive(pid) || isProcessGroupAlive(pid));
  if (leftovers.length) console.error(`[台子] 没收干净:${leftovers.join("、")}`);
}

console.log("✓ 归属凭证与读到它的那一代绑死:同代两遍对不上、号已换代、读取期间换代、"
  + "代次问不出来、根在组成员查询期间消失都一刀不发,代次一致时照样收得掉,"
  + "而别人家记号的那点不确定不许拖垮这一遍 均受回归保护");
