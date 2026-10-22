// **内核圈定**这台设备的回归(`executors/kernel-confine.ts` / `confine-job.ts`)。
//
// 分五组,前三组是纯代数/纯判据(任何平台都跑得到),后两组要真进程(只有圈建得出来的
// 机器才跑,否则**如实跳过并说出为什么** —— 跳过不许静默,那会让一条没验过的路看起来验过了)。
//
//   1) 判据代数:它什么时候说话、说什么、什么时候一个字都不说
//   2) **核销判据没被放松**:集合空了也不许把别人点过的名洗掉
//   3) 平台诚实:弃权与披露面是一对一的(弃权就一定说得出为什么)
//   4) 真进程:三条线索全断的后代,仍然枚举得到、杀得掉(含躲进子 cgroup 那一层)
//   5) **答不出来就退回原路**:同一个现场跑两遍(设备开/关),两边结论都如实
//
// 现场机件(计分板、线索尽断的后代怎么造、两个平台各自的圈定时机)在 `confine-scene-fixture.ts`;
// 这边只留「问什么、答什么」。
//
// 第 4 组钉的就是这台设备存在的理由:`env -i` 洗掉记号 + 关掉继承 fd + `setsid` 脱离进程树
// 之后,既有那四台设备(ppid 树、代次、追踪 fd、资源记号)一台都看不见它 —— 用例自己先把
// 这一点验出来(`clue_check`),再验内核那一台看得见。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IS_WINDOWS as IS_WIN, isPidAlive, killTree, runningPids } from "../src/platform.js";
import { processUnitEvidence } from "../src/proc.js";
import {
  cleanupDetail, confinedResidue, dischargeOpen, openLedger, provenGone, type CleanupOpen,
} from "../src/executors/cleanup-result.js";
import { inspectProcessSync } from "../src/platform.js";
import { processGenerationSync } from "../src/process-generation.js";
import { pidRunStillAlive } from "../src/executors/child-identity.js";
import { runningIdentity } from "../src/proc.js";
import {
  CONFINE_ENROLL_CMD, confineAbstention, openConfinement, reopenConfinement, type ConfineRead,
} from "../src/executors/kernel-confine.js";
import {
  cleanEnv, fail, failCount, firstPidFrom, nestInsideConfinement, ok, plantStaleCredential,
  readPpid, scene, skip, sleep, staleCredential, stillRunning,
} from "./confine-scene-fixture.js";

const members = (pids: number[], coverage: "whole-run" | "since-enroll"): ConfineRead =>
  ({ kind: "members", members: pids.map((pid) => ({ pid, gen: "j:1" })), coverage });
const DEAD_PID = 0x7ffffff;                       // 必然不存在的号(纯代数用)

console.log("1) 判据代数:答得出来才说话");
{
  if (confinedResidue(null, []) === null) ok("没有圈 ⇒ 一个字都不说(调用方原样走既有判据)");
  else fail("没有圈却替判定说了话 —— 那就不是「新增一台设备」了");

  if (confinedResidue({ kind: "absent", why: "夹具" }, []) === null) {
    ok("圈不在了(弃权)⇒ 不说话");
  } else fail("弃权却说了话");

  const unq = confinedResidue({ kind: "unqueryable", why: "夹具:这一刻读不出来" }, []);
  if (unq?.kind === "unknown") ok("圈在、这一刻读不出来 ⇒ unknown(下一轮还问得出来 ⇒ 留着重试)");
  else fail(`读不出来判成了 ${unq?.kind} —— 它既不是「没有」也不是弃权`);

  const live = confinedResidue(members([process.pid], "whole-run"), []);
  if (live?.kind === "remaining") ok("集合里有活着的号 ⇒ remaining(内核记着的归属,最硬的那种)");
  else fail(`集合非空却判成 ${live?.kind}`);
  if (live?.kind === "remaining" && live.open.some((o) => o.pid === process.pid)) {
    ok("而且**按号点名**:这份责任跟着结论落库,只有退出证据能让它消失");
  } else fail("集合里的成员没进责任名单 —— 下一轮清扫就不知道有号要核");

  if (confinedResidue(members([DEAD_PID], "whole-run"), [])?.kind === "empty") {
    ok("集合里只剩退了的号 + 罩住整段运行 ⇒ 正面答空");
  } else fail("内核已经证明空了却答不出空来,那每个回合都会平白欠一笔债");

  if (confinedResidue(members([], "since-enroll"), []) === null) {
    ok("集合空、但只罩住「圈定之后」那一段 ⇒ 不说话(那一档的空不构成证明)");
  } else fail("把一个有窗口的集合的「空」当成了证明 —— Windows 恒在这一档");

  if (confinedResidue(members([process.pid], "since-enroll"), [])?.kind === "remaining") {
    ok("同一档的「非空」照样算证据(弱的是「空」,不是「非空」)");
  } else fail("连正面的残留证据都不要了,那这台设备在 Windows 上就白装了");
}

console.log("2) 核销判据一个字没放松:集合空也洗不掉别人点过的名");
{
  // 这一条是整台设备的边界:它再权威,也不去改 `dischargeOpen` 的语义(约束原话)。
  // 现场:别的设备点了一个**还活着**的号(我们自己),内核这边集合是空的。
  const open: CleanupOpen[] = [{ pid: process.pid, gen: null, why: "夹具:别的设备点的名" }];
  const verdict = confinedResidue(members([], "whole-run"), open);
  if (verdict?.kind === "unknown") {
    ok("集合空 + 名单上还剩一条活着的 ⇒ unknown,不是 empty");
  } else fail(`判成了 ${verdict?.kind} —— 那等于拿新设备去放松核销判据`);
  if (verdict?.kind === "unknown" && verdict.open.length === 1) {
    ok("那一条原样留在名单上(出口只有 dischargeOpen)");
  } else fail("名单被新设备抹掉了");

  const settled = confinedResidue(members([], "whole-run"), [
    { pid: DEAD_PID, gen: "j:1", why: "夹具:已经退了的" },
  ]);
  if (settled?.kind === "empty") ok("名单上那条已经有退出证据 ⇒ 照旧销得掉(走的是同一份核销)");
  else fail(`能核销的名单却卡住了(${settled?.kind})`);

  // 账本那一侧也要能把内核认下的成员收进去(kill.ts 的 confineOwn 走的就是这条路)。
  const ledger = openLedger();
  ledger.own([{ pid: DEAD_PID, gen: "j:1" }], "夹具:内核圈定认下的成员");
  if (ledger.verdict().kind === "empty" && dischargeOpen(ledger.left()).left.length === 0) {
    ok("内核认下的成员进得了账本,也照旧按同一份判据核销");
  } else fail("账本收不下内核认的成员");
}

console.log("2c) 跨等待不许把成员降成裸号:号换了主人就不是它了");
{
  // 第 2 轮审查 F1 的那条判据。现场:圈成员被整圈一刀杀掉,**号同时空出一批**,而收尾还要
  // 等两秒 —— 那两秒里内核把同一个号发给了别的程序。按「这个号上有没有进程」问,那个无关
  // 进程就被报成「本次运行下过刀仍活着」,Windows 上那笔债还会一直挂到它自己退出。
  //
  // 这里钉的是**判据本身**:收尾那两段等待(kill.ts 的 `waitForGone`)与账本核销用的是
  // 同一个 `provenGone`,所以在这里钉住它就等于把两处一起钉住。真正抢到同一个号的人造
  // 复现做不到(要精确命中内核的分配),所以反过来构造:号活着、代次是另一代。
  const real = processGenerationSync(process.pid);
  if (!real) {
    skip("这台机器问不出代次,这一条没有对象");
  } else {
    const other = `${real.slice(0, real.indexOf(":") + 1)}1`;   // 同一坐标系、另一代
    if (provenGone({ pid: process.pid, gen: other, why: "夹具:号被复用了" })) {
      ok("号还占着、可代次换了 ⇒ 算退了(占着这个号的已经是别人)");
    } else fail("号换了主人还被当成本次运行的成员 —— 那就会把一个无关进程报成残存者");
    if (!provenGone({ pid: process.pid, gen: real, why: "夹具:还是它" })) {
      ok("代次对得上 ⇒ 照旧算还在(判据没被放松到「有代次就放过」)");
    } else fail("同一代也被核销了");
    if (provenGone({ pid: DEAD_PID, gen: null, why: "夹具:没代次、号也空了" })) {
      ok("没代次只能等号彻底空掉 —— 那是更保守的一侧,照旧成立");
    } else fail("号都空了还没核销");
  }
}

console.log("2d) 「还在跑」这一问成批问,僵尸与空号都分得清");
{
  // 收尾那两秒每 50 ms 要问一遍整份名单,逐个问在 macOS 上就是每个号一个 `ps`(第 2 轮审查
  // 把它记成新增延迟)。批量那一份是唯一入口,所以在这里钉住它的三档答案。
  const live = runningPids([process.pid, DEAD_PID]);
  if (live.has(process.pid)) ok("在跑的号在结果里");
  else fail("自己这个号都没算在跑");
  if (!live.has(DEAD_PID)) ok("不存在的号不在结果里");
  else fail("空号被算成在跑");
  if (runningPids([]).size === 0) ok("空名单不发任何系统调用,直接空集");
  else fail("空名单答出了东西");
}

console.log("2b) 塞进 shell 的那一句:两条生产路径的拼法都得是合法脚本");
if (IS_WIN) {
  skip("Windows 上那两条路都不经 shell(spawnForRun 走管道那条),这一句本来就不存在");
} else {
  // 这一条是拿真事故换来的:这个常量原先自带结尾 `;`,而 FIFO 那条路把各句 `join("; ")`,
  // 于是拼出 `;;` —— `sh` 当场语法错误,CLI 一条指令都没跑起来。闸很便宜(一次 `sh -n`),
  // 而漏掉的代价是整条生产路径静默失效,所以放在这里长钉着。
  if (!/[;&|]\s*$/.test(CONFINE_ENROLL_CMD)) ok("常量自己不带结尾分隔符(分隔符归拼它的那一侧)");
  else fail(`常量自带结尾分隔符(${JSON.stringify(CONFINE_ENROLL_CMD.slice(-3))})—— 拼进 join 就会撞出 ;;`);

  const shapes: Array<[string, string]> = [
    ["模板串那条路(spawnDetachedAgent)", `${CONFINE_ENROLL_CMD}; "$@" >>/dev/null 2>>/dev/null; printf %s $? >/dev/null`],
    ["数组 join 那条路(spawnControllableDetachedAgent)",
      [CONFINE_ENROLL_CMD, 'trap \'rm -f "$ASH_IN"\' EXIT', 'exec 3<>"$ASH_IN"', '"$@" <&3', 'exit $?'].join("; ")],
  ];
  for (const [label, script] of shapes) {
    const check = spawnSync("/bin/sh", ["-n", "-c", script], { encoding: "utf8" });
    if (check.status === 0) ok(`${label}:sh -n 通过`);
    else fail(`${label}:sh 认为这不是合法脚本 —— ${(check.stderr || "").trim().split("\n")[0]}`);
  }
}

console.log("3) 平台诚实:弃权与披露面一对一");
{
  const why = confineAbstention();
  const device = openConfinement(`probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    if ((device === null) === (why !== null)) {
      ok(device === null
        ? `这台机器上这台设备不可用,而且说得出为什么:${why}`
        : "这台机器上这台设备可用,披露面也没谎称弃权");
    } else {
      fail(device === null
        ? "弃权了却说不出为什么 —— 那会让使用者以为自己有内核那一档的保证"
        : `设备明明建出来了,披露面却说弃权(${why})`);
    }
    if (process.platform === "darwin") {
      if (device === null && /macOS/.test(why ?? "")) {
        ok("macOS 如实弃权(没有等价物,判据原样退回进程组 + reparent 那一套)");
      } else fail("macOS 上冒出了一台不该存在的设备");
    }
  } finally {
    device?.dispose();
  }

  if (reopenConfinement("不是一个圈号") === null) ok("打不开的圈号 ⇒ null,不替它读成空");
  else fail("随便一个字符串都能当圈号打开");
}

// ── 真进程那两组 ─────────────────────────────────────────────────────────────
const token = `ash-agent-test-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const confine = openConfinement(token);

console.log("3b) 僵尸算退出证据:账本核销得掉,不会每轮重押同一笔");
{
  // 为什么这一条跟这台设备有关:圈里的成员**一律进账本**(kill.ts 的 `confineOwn`),而
  // 「被整圈杀掉、父进程没来收割」的后代恰好停在 `Z` 上 —— 旧那几台设备点到的号都是活的,
  // 所以这个组合是新设备带出来的。按「号还占着吗」问,那一笔永远核销不掉:每一轮清扫都
  // 重押同一笔债(容器里 PID 1 不是 init 时实测过,2026-10-22)。
  //
  // 僵尸造法:`perl` 的 `fork` **不自动收割**(Node 的 libuv 会,所以拿 node 造不出来)。
  // 不带 `--init` 的容器是同一现场的另一种形态,这里选 perl 是因为它在 macOS/Linux 上
  // 都跑得到,不必额外起容器。
  const hasPerl = !IS_WIN && spawnSync("perl", ["-e", "1"]).status === 0;
  if (!hasPerl) {
    skip(IS_WIN ? "Windows 没有僵尸这一档(进程退出即消失)" : "这台机器上没有 perl,造不出僵尸");
  } else {
    const parent = spawn("perl", ["-e",
      // `$| = 1`:管道上 perl 默认块缓冲,不冲刷的话这个号 30 秒后才出来。
      '$| = 1; my $pid = fork(); if ($pid == 0) { exit 0 } print "$pid\\n"; sleep 30;'], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const zombie = await firstPidFrom(parent, "僵尸的父进程");
    try {
      for (let i = 0; i < 40 && stillRunning(zombie); i += 1) await sleep(50);
      if (isPidAlive(zombie) && !stillRunning(zombie)) {
        ok(`前置条件:${zombie} 这个号上是一个僵尸(号还占着、状态 Z)`);
      } else {
        fail(`前置条件不成立:${zombie} 没变成僵尸(alive=${isPidAlive(zombie)})`);
      }
      const { gone, left } = dischargeOpen([{ pid: zombie, gen: null, why: "夹具:圈里认下的成员" }]);
      if (gone.length === 1 && !left.length) ok("僵尸 ⇒ 核销掉(它 exit 过了,不会再写一行、也收不到信号)");
      else fail(`僵尸没核销掉(left=${left.length}) —— 这一笔会每轮重押`);
      const read: ConfineRead = { kind: "members", members: [{ pid: zombie, gen: null }], coverage: "whole-run" };
      if (confinedResidue(read, [])?.kind === "empty") ok("而且不把它算成「圈里还有成员在跑」");
      else fail("僵尸被算成了还在跑的成员 —— 收尾会为一个已经退出的号白等 2 秒并记成残留");
      if (!runningPids([zombie]).has(zombie)) ok("批量那一问也把它排除在「在跑」之外(同一份判据)");
      else fail("批量那一问把僵尸算成在跑");

      // **同一判据的另外两个落点**(第 2 轮审查「类问题」):债表的根那一问、根探活那一问。
      // 它们走的是身份那一层(`processIdentity`),僵尸的启动时刻照旧对得上 ⇒ 不接这一档的话
      // 永远答「还活着」:没人收割的 PID 1 下,一笔已经退出的责任每轮重押、永远推不动。
      const startedAt = inspectProcessSync(zombie)?.startedAt ?? null;
      if (runningIdentity(zombie, startedAt) === "exited") {
        ok("身份那一层多出的那一档:僵尸答 exited(身份还对得上,可它已经 exit 过了)");
      } else fail(`身份那一层把僵尸答成了 ${runningIdentity(zombie, startedAt)}`);
      if (pidRunStillAlive(zombie, startedAt) === "gone") ok("根探活那一问据此答 gone");
      else fail(`根探活把僵尸答成 ${pidRunStillAlive(zombie, startedAt)}`);
    } finally {
      parent.kill("SIGKILL");
    }
  }
}

console.log("3c) `whole-run` 这一档由内核那一侧确认,不由这边声明得来");
if (!confine || IS_WIN) {
  skip(IS_WIN
    ? "Windows 没有 `exec` 前圈定这条路(`preExecEnv()` 恒为 null、恒是 since-enroll)"
    : "这台机器上没有这台设备");
} else {
  // 钉的是**反面**:取过 `preExecEnv()`(= 声明「我会在目标程序跑起来之前把自己圈进去」)
  // 之后,那一句**没真的跑成**时读数必须退回 `since-enroll` —— 而不是照着声明自称罩住整段
  // 运行。上一版就是在发环境变量那一刻直接把档位设成 `whole-run` 的,于是一个推断出来的
  // 空会压过别的设备(第 1 轮审查 F3)。正面那一半由第 4 组钉(真跑那一句 ⇒ whole-run)。
  const dev = openConfinement(`${token}-declared`);
  if (!dev) {
    fail("前置条件:第二个圈建不出来");
  } else {
    try {
      const env = { ...process.env, ...(dev.preExecEnv() ?? {}) };
      // **故意不把那一句拼进脚本**:等价于「写失败」/「脚本在 exec 之前就挂了」——
      // 凭据永远不会出现,而父进程这一侧照旧补圈(跟生产路径一样)。
      const child = spawn("/bin/sh", ["-c", 'exec "$@"', "sh",
        process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        env, detached: true, stdio: ["ignore", "ignore", "ignore"],
      });
      assert.ok(child.pid, "前置条件:根进程起得来");
      dev.enroll(child.pid);
      for (let i = 0; i < 40; i += 1) {
        const r = dev.read();
        if (r.kind === "members" && r.members.some((m) => m.pid === child.pid)) break;
        await sleep(50);
      }
      const read = dev.read();
      if (read.kind === "members" && read.coverage === "since-enroll") {
        ok("那一句没跑成 ⇒ 档位退回 since-enroll(声明不作数,凭据才作数)");
      } else {
        fail(`那一句没跑成,档位却是 ${read.kind === "members" ? read.coverage : read.kind}`);
      }
      if (read.kind === "members" && read.members.some((m) => m.pid === child.pid)) {
        ok("同时圈本身照旧成立:父侧补的那一笔把根圈住了(弱一档,不是没有)");
      } else fail("父侧补圈也没成 —— 这个现场说明不了档位那件事");
      killTree(child.pid, "SIGKILL");
      for (let i = 0; i < 40 && stillRunning(child.pid); i += 1) await sleep(50);
      if (confinedResidue(dev.read(), []) === null) {
        ok("成员都退干净了也**一个字都不说** —— since-enroll 的空不构成证明");
      } else {
        fail(`没确认过的圈替判定答了话:${cleanupDetail(confinedResidue(dev.read(), [])!)}`);
      }
    } finally {
      dev.dispose();
    }
  }
}

console.log("4) 真进程:线索尽断的后代仍然是确定集合里的一员");
if (!confine) {
  skip(`这台机器上建不出圈(${confineAbstention()})—— 第 4、5 组的真进程用例在这里没有对象`);
} else {
  const { root, descendant, coverage } = await scene(confine);
  try {
    // 根先走掉:POSIX 上后代于是被重父到 1 号名下,ppid 树这台设备从此看不见它。
    //
    // **只杀根那一个**,不能用 `killTree`:Windows 上它是 `taskkill /T /F`,会把整棵树
    // 一起带走 —— 那就不是「根死了、后代活着」这个现场了(实测:后代当场被一起收掉,
    // 前置条件直接不成立)。`process.kill` 在那边走 `TerminateProcess`,只动这一个号。
    if (IS_WIN) process.kill(root, "SIGKILL");
    else killTree(root, "SIGKILL");
    await sleep(IS_WIN ? 1_500 : 600);
    assert.equal(isPidAlive(descendant), true, "前置条件:后代在根退出之后仍然活着");

    // ① 先证明这个现场**真的**是那个硬场景:既有几台设备认不出它。
    const unit = processUnitEvidence(token, { fresh: true });
    if (unit.verdict === "none" || unit.verdict === "unprovable") {
      ok(`记号那台设备看不见它(${unit.verdict})—— 它的环境里一项 ASH_ 都没有`);
    } else fail(`现场不成立:记号那台设备仍然认得出它(${unit.verdict}),那就不是线索断掉的场景`);
    const ppid = readPpid(descendant);
    if (IS_WIN) {
      // Windows 上这条**本来就不断**:父进程退出之后 ParentProcessId 仍保留旧号,所以
      // 既有那条路还能顺着走(代价是号被复用之后会指错人)。这台设备在这个平台上补的
      // 不是「看不见」,而是**「看见的是不是我的」** —— 集合由内核记着,不靠号的推断。
      ok(`Windows 上 ppid 边不断(父退出后仍保留,读到 ${ppid ?? "读不出"})`
        + " —— 这台设备在这里补的是「确定」而不是「可见」");
    } else if (ppid === 1 || ppid === 0) {
      ok(`ppid 树那台设备看不见它(已被重父到 ${ppid} 号名下)`);
    } else fail(`现场不成立:它还挂在 ${ppid} 下面`);

    // ② 内核圈定这台设备看得见。
    const read = confine.read();
    if (read.kind === "members" && read.members.some((m) => m.pid === descendant)) {
      ok("内核圈定枚举得到它 —— 这正是既有那套结构性答不出来的那一类");
    } else fail(`内核圈定也没枚举到它:${JSON.stringify(read)}`);
    if (read.kind === "members" && read.coverage === coverage) {
      ok(coverage === "whole-run"
        ? "coverage 是 whole-run(exec 之前就圈住了),所以它的「空」才有资格压过别的设备"
        : "coverage 是 since-enroll(assign 只能在 spawn 之后)—— 这一档只拿「非空」当证据,"
          + "「空」一个字都不说");
    } else fail(`coverage 不是 ${coverage} —— 这条路声称的罩住范围跟实际不符`);
    // **成员必须带着代次**(第 2 轮审查 F1):整圈一刀杀掉之后号会同时空出一批,只有代次
    // 能把「这个号后来换了主人」跟「本次运行的成员还活着」分开。Windows 那边这一份是一次
    // 批量读数取回来的(`processGenerationsSync`),不是逐个起 PowerShell。
    const mine = read.kind === "members" ? read.members.find((m) => m.pid === descendant) : null;
    if (mine?.gen) ok(`成员带着代次(${mine.gen})—— 号被复用时才分得出「已经不是它」`);
    else fail("成员只有裸号,没有代次 —— 号一被复用就会把无关进程报成本次运行的残留");

    // ③ **躲进子 cgroup 也躲不掉**:圈是我们自己的子树,里面的进程有权再往下建一层。
    //    这一条钉的是 `cgroupMembers` 的递归(只读最上面一层就会把它当成不存在)。
    const nested = nestInsideConfinement(confine.id, descendant);
    if (nested === "skipped") skip("这个平台上没法手搓子 cgroup(递归那一条由上面那次枚举间接覆盖)");
    else if (nested === "ok") {
      const deeper = confine.read();
      if (deeper.kind === "members" && deeper.members.some((m) => m.pid === descendant)) {
        ok("它往下躲了一层子 cgroup,枚举照旧找得到(递归)");
      } else fail("躲进子 cgroup 就枚举不到了 —— 那个集合就不是确定集合");
    } else fail(`子 cgroup 这一步出错:${nested}`);

    // ④ 整圈下刀。
    //
    // 判「收掉了」用的是 `stillRunning` 而不是 `isPidAlive`:孤儿被杀之后要等 1 号把它收走,
    // 号才会消失,而**1 号会不会收**取决于这台机器上 1 号是谁 —— systemd/launchd 会,
    // `docker run` 不加 `--init` 时那个 1 号(用户自己的命令)不会,于是号一直占着僵尸位。
    // 僵尸执行不了任何指令,算已经收掉;这只是夹具层面把「活着」说准,判据那一侧没动
    // (内核那边本来就不把僵尸算在 `cgroup.procs` 里,下面那条「集合是空的」同时验了这点)。
    confine.killAll("SIGKILL");
    for (let i = 0; i < 40 && stillRunning(descendant); i += 1) await sleep(100);
    if (!stillRunning(descendant)) {
      ok(IS_WIN
        ? "整圈下刀把它收掉了(TerminateJobObject:一次调用,不按号逐个点)"
        : "整圈 SIGKILL 把它收掉了(cgroup.kill:一次写入,没有竞态)");
    } else fail("整圈下刀之后它还在跑");

    const after = confine.read();
    if (after.kind === "members" && after.members.length === 0) {
      ok("收完之后集合是空的 —— 这一档才是允许销账的那个「空」");
    } else fail(`收完之后集合不是空的:${JSON.stringify(after)}`);

    // ⑤ 圈号打得开:**落库之后**清扫侧就能这么把圈接回来。注意这里钉的只是「按号打得开」
    // 这一件事 —— 圈号现在**没有落库**,所以跨 server 重启那一档是未接的,钉不了。
    if (reopenConfinement(confine.id)) ok("按圈号把同一个圈重新打开(落库之后接回就走这条路)");
    else fail("圈号打不开 —— 那重启之后这台设备就没了");

    // ⑥ 过期凭据那道年龄门真的在扫(第 2 轮审查点名的测试缺口)。判定没落在 `empty` 的那些
    // 运行不会走到 `dispose()`,凭据会一直攒 —— 钉的就是这一点。两边凭据不同、埋点也不同,
    // 见 `plantStaleCredential`。
    const stale = staleCredential ?? plantStaleCredential("enrolled");
    try {
      if (!IS_WIN) openConfinement(`${token}-sweep`)?.dispose();     // cgroup:开圈时顺手扫
      if (!existsSync(stale)) {
        ok(IS_WIN
          ? "两天前的就绪信号被扫掉了(守圈进程第一次拉起来时顺手扫,一天的年龄门)"
          : "两天前的入圈凭据被扫掉了(开圈时顺手扫,同 cgroup 那道年龄门)");
      } else fail("过期凭据没扫掉 —— 它会一直攒在临时目录下");
    } finally {
      try { rmSync(stale, { force: true }); } catch { /* 已经扫掉了 */ }
    }
  } finally {
    if (isPidAlive(descendant)) killTree(descendant, "SIGKILL");
    if (isPidAlive(root)) killTree(root, "SIGKILL");
    confine.killAll("SIGKILL");
    confine.dispose();
  }
}

/** 4b 搭起来的那条生产路径,4c 复用它(同一个 DB、同一套 spawn/cleanup)。 */
let e2e: null | {
  runOnce: (deviceOn: boolean, kidCode?: string) => Promise<{
    descendant: number; verdict: { kind: string }; tookMs: number; alive: boolean;
  }>;
  TOUGH_KID: string;
} = null;

console.log("4b) 生产路径端到端:同一个现场,设备开着收得掉、关掉只能如实说没答出来");
if (!confine) {
  skip("这台机器上没有这台设备 —— 端到端那一对对照在这里没有对象");
} else {
  // 走的是生产那条 detached 路径(`spawnForRun` + `cleanupAfterRun`),不是夹具自己拼的圈:
  // 那条路里 `sh` 在 `exec` 之前把 `$$` 写进 `cgroup.procs`(CONFINE_ENROLL_CMD),
  // 所以 CLI 的第一条指令就已经在圈里 —— 这是 `whole-run` 这一档的来历。
  //
  // 同一个现场跑两遍(设备开 / `ASH_KERNEL_CONFINE=0`),对照的是**后代的实际存亡**,
  // 不是判定的措辞:措辞会随判据演进,「它到底还在不在跑」不会。这一对就是验收里
  // 「答不出来时退回原路径」那条的可执行形态 —— 关掉之后既有那四台设备在这个现场
  // 结构性地看不见它,于是它活下来;而两边的结论都如实,没有一边冒充清理完成。
  const home = mkdtempSync(join(tmpdir(), "ash-confine-e2e-"));
  process.env.ASH_DB = join(home, "ash.db");
  process.env.ASH_ALLOW_REAL_AGENT = "1";
  const { ensureSchema } = await import("../src/db/index.js");
  await ensureSchema();
  const { detachedPathsFor, spawnForRun } = await import("../src/executors/detached.js");
  const { cleanupAfterRun } = await import("../src/executors/kill.js");

  // 根进程:甩出一个三条线索全断的后代,报出它的号,然后**自己走掉**(于是后代成了孤儿)。
  // `kidCode` 是那个后代自己跑的代码 —— 换一句就换一个现场(下面第二个现场用它把 TERM 吃掉)。
  const e2eRoot = (kidCode: string) => `
const { spawn } = require("node:child_process");
setTimeout(() => {
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(kidCode)}], {
    detached: true, env: ${JSON.stringify(cleanEnv())}, windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (!child.pid) process.exit(2);
  process.stdout.write(String(child.pid) + "\\n");
  child.unref();
  setTimeout(() => process.exit(0), 200);
}, ${IS_WIN ? 4_000 : 0});
`;
  const IDLE_KID = "setInterval(() => {}, 1000)";
  /** 把 SIGTERM 吃掉的后代:只有整圈那一刀(SIGKILL)带得走它。 */
  const TOUGH_KID = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';

  const runOnce = async (deviceOn: boolean, kidCode = IDLE_KID) => {
    if (deviceOn) delete process.env.ASH_KERNEL_CONFINE;
    else process.env.ASH_KERNEL_CONFINE = "0";
    const dir = mkdtempSync(join(home, deviceOn ? "on-" : "off-"));
    const paths = detachedPathsFor(dir, "s1", "2026-10-22T00:00:00Z");
    const child = spawnForRun(dir, process.execPath, ["-e", e2eRoot(kidCode)], "", undefined, paths);
    let descendant = 0;
    for (let i = 0; i < 100 && !descendant; i += 1) {
      await sleep(100);
      try {
        const n = Number(readFileSync(paths.out, "utf8").trim().split("\n")[0]);
        if (Number.isInteger(n) && n > 1) descendant = n;
      } catch { /* 文件还没出来 */ }
    }
    assert.ok(descendant, "根进程没把后代的号报出来(前置条件)");
    for (let i = 0; i < 60 && isPidAlive(child.pid ?? 0); i += 1) await sleep(100);
    const t0 = Date.now();
    const verdict = await cleanupAfterRun(child);
    const tookMs = Date.now() - t0;
    for (let i = 0; i < 30 && stillRunning(descendant); i += 1) await sleep(100);
    return { descendant, verdict, tookMs, alive: stillRunning(descendant) };
  };

  e2e = { runOnce, TOUGH_KID };

  const on = await runOnce(true);
  try {
    // 收尾耗时如实报出来:Windows 上这一段要起 PowerShell、还可能等守圈进程,
    // 代价得能量到而不是凭感觉(第 1 轮审查 F4)。
    console.log(`     · 设备开着,一次 cleanupAfterRun 耗时 ${on.tookMs} ms`);
    if (!on.alive) ok(`设备开着:生产路径把这个后代收掉了(判定 ${on.verdict.kind})`);
    else fail(`设备开着却没收掉 ${on.descendant}(判定 ${on.verdict.kind})`);
    if (!IS_WIN) {
      if (on.verdict.kind === "empty") ok("而且敢正面答「收干净了」—— 内核证明的空,不是推断的空");
      else fail(`收掉了却答 ${on.verdict.kind}:${cleanupDetail(on.verdict)}`);
    } else {
      // Windows 恒是 `since-enroll`:那一档的**空不构成证明**,所以这台设备在那边不参与
      // 「敢不敢答空」这件事,答空与否仍由既有那几台设备决定 —— 这正是「不许因为新设备
      // 存在就放松判据」的样子,如实记下它的档位而不是要求它给出 Linux 那一档的结论。
      ok(`Windows:这台设备不替「空」背书(since-enroll),判定仍由既有那几台给出 ——`
        + ` 本轮判定 ${on.verdict.kind}`);
    }
  } finally {
    if (isPidAlive(on.descendant)) killTree(on.descendant, "SIGKILL");
  }

  const off = await runOnce(false);
  try {
    delete process.env.ASH_KERNEL_CONFINE;
    console.log(`     · 设备关掉,同一段耗时 ${off.tookMs} ms(差值就是这台设备的收尾代价)`);
    if (off.alive) {
      ok(`设备关掉:同一个现场,既有那四台设备结构性看不见它,它活了下来(${off.descendant})`
        + ` —— 这正是这台设备被加进来的理由;判定 ${off.verdict.kind}`);
    } else {
      // 不算失败:若哪天别的设备也能覆盖这个现场,这条会在这里如实提示,
      // 而不是让「设备关掉也收得掉」悄悄冒充成「新设备没必要」。
      ok(`设备关掉时它也被收掉了(判定 ${off.verdict.kind})—— 现场被别的设备覆盖到了,照实记下`);
    }

    // ★ 这一对才是整台设备的意义所在,也是实测出来的那条边界,所以单独钉住:
    //
    //   两轮的**判定词是同一个 empty**,但一轮是真的空、另一轮残留还在跑。
    //
    // 这不是既有判据写错了:没有内核圈定的机器上,这个后代把记号、继承 fd、ppid 树、
    // 输出文件四条线索一次全断,它与一个**陌生进程**在原理上不可区分 —— 四台设备各自
    // 都确证「我这一问下没有」,没有一台说谎,合起来只能得出「没有能认下的残留」。
    // 要它在这种现场改口答 unknown 等于要它永远不敢答空,那每一次运行都会平白欠一笔债,
    // 是另一个方向的错。所以这里**不把它记成失败**,而是记成能力边界:
    //
    //   没有这台设备的机器(macOS 恒定如此)上,「收干净了」这句话是**推断**的;
    //   有这台设备、且罩住整段运行时,同一句话背后才有内核给的证明。
    //
    // 本轮一个字都没去放松既有判据,改变的只是「这类现场可不可判」。
    if (!on.alive && off.alive) {
      ok("★ 同一个现场、同一句「收干净了」:有这台设备时是内核证明的空,没有时是推断的空"
        + " —— 这条差别就是本轮加它的全部理由,也是 macOS 拿不到的那一档");
    } else if (!on.alive && !off.alive) {
      ok("两轮都收掉了 —— 这个现场不再属于「四条线索全断」那一类,照实记下");
    } else {
      fail("设备开着反而没收掉 —— 那这台设备就没接上生产路径");
    }
  } finally {
    if (isPidAlive(off.descendant)) killTree(off.descendant, "SIGKILL");
  }
}

console.log("4c) 吃掉 SIGTERM 的圈内成员:生产收尾之后必须 gone");
if (!confine) {
  skip("这台机器上没有这台设备");
} else if (!e2e) {
  fail("4b 那一段没建起来,这一条没法跑(它复用那条生产路径)");
} else {
  // 这一条钉的是**整圈那一刀到底发不发得出去**(第 1 轮审查 F1)。现场:后代把 TERM 吃掉,
  // 而旧那几台设备一个都点不到它的名(记号洗了、fd 关了、`setsid` 脱了组、根已经走了)。
  // 上一版的收尾里「等 2 秒」和「补 SIGKILL」都挂在**旧设备点到的号**上,于是它们一个都
  // 没点到名时 `stubborn` 必然为空、整段直接 settle —— 补刀一刀都没发出去,这个后代就这么
  // 活着,而判定那一侧照旧答 `empty`(圈里读到的成员**都还活着**也只会被算成 remaining,
  // 可那次读数发生在「已经放弃补刀」之后)。所以这里只问一件事:收尾之后它还在不在。
  const tough = await e2e.runOnce(true, e2e.TOUGH_KID);
  try {
    if (!tough.alive) {
      ok(`吃掉 TERM 的后代在生产收尾之后 gone(判定 ${tough.verdict.kind},耗时 ${tough.tookMs} ms)`
        + " —— 这一刀只能来自整圈那一发");
    } else {
      fail(`吃掉 TERM 的后代活下来了(${tough.descendant},判定 ${tough.verdict.kind})`
        + " —— 整圈的 SIGKILL 没发出去");
    }
  } finally {
    if (isPidAlive(tough.descendant)) killTree(tough.descendant, "SIGKILL");
  }
}

console.log("5) 关掉这台设备 ⇒ 原样退回既有那套");
{
  // 这一组钉的是「答不出来时退回原路」这条**可执行**的保证:同一台机器、同一个现场,
  // 把设备关掉之后 `openConfinement` 必须答 null、披露面必须说得出为什么,而判定那一摊
  // 一个字都不改(上面第 1 组已经钉过:read 为 null ⇒ confinedResidue 不说话)。
  const prev = process.env.ASH_KERNEL_CONFINE;
  process.env.ASH_KERNEL_CONFINE = "0";
  try {
    const off = openConfinement(`${token}-off`);
    if (off === null) ok("显式关掉之后建不出圈(ASH_KERNEL_CONFINE=0)");
    else { fail("关了还是建出来了"); off.dispose(); }
    const why = confineAbstention();
    if (why && /ASH_KERNEL_CONFINE/.test(why)) ok(`披露面如实说出弃权的理由:${why}`);
    else fail(`关掉之后披露面没说清为什么弃权(${why})`);
    if (reopenConfinement("/whatever") === null) ok("关掉之后也不去打开任何既有的圈");
    else fail("关了还在打开圈");
  } finally {
    if (prev === undefined) delete process.env.ASH_KERNEL_CONFINE;
    else process.env.ASH_KERNEL_CONFINE = prev;
  }
}

const bad = failCount();
console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过");
process.exit(bad ? 1 : 0);
