// **半截查询不许当查全** —— 第 5 轮审查 F1 的机制本身。
//
// 「谁还握着这次运行的文件」这一问以前把两件事压在一条轴上:发现了谁、问全了没有。于是
// 「发现了两个、随后 lsof 自己出错」这种回答无法表达,只能挑一档 —— 挑的是「确证有人握着」,
// 而下游把它读成「正好这些」:逐个探活、都退了就答「空」,于是证据释放、责任销账。
//
// 审查者用真实故障 `lsof`(先把自己报成持有者、再退 2)实测:活后代心跳 21→33,库里那一行
// 被真的 DELETE 了。这份脚本按同一手法钉住四处:
//
//  ① 取证层:半截回答要同时说出「发现了谁」和「没问全」,不许塌成任何一档;
//  ② 即时清理:同样的半截回答下,结论不许是「空」,责任要留着;
//  ③ 持久清扫:同一行再扫一遍不许销账、不许收档(文件还在 ⇒ 下一轮还问得出来);
//  ④ 整张进程表:`ps` 退非零但吐了半截 ⇒ 整问作废,不拿半截表当一棵进程树。
//
// 第 6 轮审查又实测了同一个类的另外两种来源事实被丢掉,再加两组:
//
//  ⑤ **外部工具正常退出、但自己声明输出不完整**:lsof 扫不动某个挂载时打一句
//     `Output information may be incomplete.` 然后退 0 —— 上一版的完整性判断排在
//     「它报错了吗」之后,于是这种回答被构造成「问全了」,活后代的责任被真的 DELETE;
//  ⑥ **进程表里的活节点缺代次**:它在表上、父子关系也在,只是启动时刻读不出来。上一版
//     建树时整行丢掉,于是「核验不了」被读成「没有后代」,连它下面的分支一起从遍历里消失。
//     审查在 Windows 真机上验的是同一处(活后代缺 `CreationDate` ⇒ 结论 empty、一笔债都没落);
//     这里用 `ps` 夹具在 macOS 上验同一层:**存在 / 可核验 / 不存在是三件事**。
//
// 故障只注入在**系统工具边界**(PATH 前置一个真实可执行的夹具),生产代码、SQL 与进程身份
// 都是真的 —— 跑的是 `cleanupAfterRun` / `sweepAgentCleanupDebts` 本体。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IS_WIN = process.platform === "win32";
if (IS_WIN) {
  console.log("   ~ Windows 上没有 lsof / ps 这两条路(见 track-evidence.ts 顶部),整份跳过");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "ash-holder-scan-"));
process.env.ASH_DB = join(root, "ash.db");
const ORIGINAL_PATH = process.env.PATH;

const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const { mintUnitToken, registerUnitToken, registerRunOutPath } = await import("../src/executors/unit-token.js");
const { cleanupAfterRun } = await import("../src/executors/kill.js");
const { probeFileHolders, holderScanFault, provenNoHolders } = await import("../src/executors/track-evidence.js");
const { listAllCleanupDebts, sweepAgentCleanupDebts } = await import("../src/executors/cleanup-debt.js");
const { processUnitEvidence } = await import("../src/proc.js");
const { isPidAlive } = await import("../src/platform.js");
const { processTableSnapshot } = await import("../src/process-generation.js");
const { subtreesOf } = await import("../src/process-subtrees.js");
const { collectEscapees } = await import("../src/executors/escapees.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beats = (path: string) => Number(readFileSync(path, "utf8") || "0");
let orphan = 0;

/**
 * PATH 前置一个夹具,**真实可执行**(不是 monkey patch:要让生产那句 `execFile` 自己去撞)。
 *
 * lsof 夹具先把**自己**报成这个文件的写持有者(`p`/`f`/`a`/`n` 四行,与 `-F pfan` 同形),
 * 然后退 2 并写一句它自己的定型故障 —— 这正是「吐了一半再出错」的最小形状。它自己随即退出,
 * 所以那个被报出来的号在调用方探活时已经死了:上一版据此判「空」。
 */
function installShim(name: string, body: string): string {
  const dir = mkdtempSync(join(root, `shim-${name}-`));
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}`, { mode: 0o755 });
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  return dir;
}
const restorePath = () => { process.env.PATH = ORIGINAL_PATH; };

/**
 * **退 0、但自己声明输出不完整**的 lsof(第 6 轮审查 F1 的那一下)。
 *
 * 它照样把自己报成这个文件的写持有者(所以「发现了谁」这一半是真的),同时打出官方实现里
 * 那句结论(`Output information may be incomplete.`),然后**正常退出**。
 */
const INCOMPLETE_LSOF = 'for argument do target="$argument"; done\n'
  + 'exec 5>>"$target"\n'
  + 'printf "p%s\\nf5\\naw\\nn%s\\n" "$$" "$target"\n'
  + 'printf "lsof: WARNING: can\x27t stat() nfs file system /mnt/stale\\n" >&2\n'
  + 'printf "      Output information may be incomplete.\\n" >&2\n'
  + "exit 0\n";

const PARTIAL_LSOF = 'for argument do target="$argument"; done\n'
  + 'exec 5>>"$target"\n'
  + 'printf "p%s\\nf5\\naw\\nn%s\\n" "$$" "$target"\n'
  + 'printf "lsof: status error: simulated incomplete scan\\n" >&2\n'
  + "exit 2\n";

let bad = 0;
const strays: number[] = [];                      // 这一轮自己起的、不归 cleanup 管的活进程
const ok = (m: string) => console.log(`   ✓ ${m}`);
const fail = (m: string) => { bad += 1; console.log(`   ✗ ${m}`); };

try {
  // ── 现场:根进程退出,一个脱离的真后代继续握着这次运行的输出文件并写心跳 ──────────
  const out = join(root, "run.out");
  const beat = join(root, "beat");
  const pidFile = join(root, "orphan.pid");
  const token = mintUnitToken();
  const outFd = openSync(out, "a");
  const parent = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const kid = spawn(process.execPath, ["-e",
      "let n=0;setInterval(()=>{require('fs').writeFileSync(process.argv[1],String(++n))},50)",
      ${JSON.stringify(beat)}], { detached: true, stdio: ["ignore", 1, "ignore"], env: {} });
    require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
    kid.unref();
    setTimeout(() => process.exit(0), 150);
  `], { stdio: ["ignore", outFd, "ignore"], env: { ...process.env, ASH_MONITOR_UNIT: token } });
  closeSync(outFd);
  registerUnitToken(parent, token);
  registerRunOutPath(parent, out);
  await new Promise<void>((r) => parent.once("close", () => r()));
  await wait(300);
  orphan = Number(readFileSync(pidFile, "utf8"));
  assert.ok(orphan > 1 && isPidAlive(orphan), "这条用例要一个真的、还活着的脱离后代");
  // 它把环境洗掉了(`env: {}`),所以记号这一问确证空 —— 只剩输出文件这一条线索。
  assert.equal(processUnitEvidence(token, { fresh: true }).verdict, "none", "记号这一问该确证空");

  console.log("1) 取证层:半截回答要同时说出「发现了谁」和「没问全」");
  {
    const real = await probeFileHolders(out);
    if (real.scan === "complete" && real.found.some((h) => h.pid === orphan)) {
      ok("真实 lsof:问全了,而且点出了那个活后代");
    } else fail("真实 lsof 都没把活后代报出来,后面几组的前提不成立");

    const shim = installShim("lsof", PARTIAL_LSOF);
    const partial = await probeFileHolders(out);
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const fault = holderScanFault(partial);
    if (fault?.retriable) ok(`半截回答:如实说没问全、而且文件还在 ⇒ 值得重试(${fault.fault})`);
    else fail("出错的那一次 lsof 被当成问全了 —— 正是 F1 那一下");
    if (partial.found.length) ok("已经发现的那个持有者照样带上去(正面线索不因出错作废)");
    else fail("半截里的正面线索被一起丢掉了(逃逸枚举就少了树根)");
    if (!provenNoHolders(partial)) ok("它不是「确证空」那一档 —— 不允许据此销毁证据");
    else fail("半截回答被读成确证空");
  }

  console.log("2) 即时清理:同样的半截回答下,不许宣布清空");
  {
    const first = await cleanupAfterRun(parent);
    const noted = await listAllCleanupDebts();
    if (first.kind !== "empty" && noted.ok && noted.debts.length === 1) {
      ok(`真实取证:结论 ${first.kind},责任落下 1 笔`);
    } else fail(`前提不成立:结论 ${first.kind}、账 ${noted.ok ? noted.debts.length : "读不出"} 笔`);

    const shim = installShim("lsof", PARTIAL_LSOF);
    const again = await cleanupAfterRun(parent);
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const after = await listAllCleanupDebts();
    if (again.kind !== "empty") ok(`半截取证:结论仍是 ${again.kind},没有宣布清空`);
    else fail("半截取证把这一次运行判成了清空(F1 的生产后果)");
    if (after.ok && after.debts.length === 1) ok("那一行责任还在");
    else fail(`责任被销掉了(现在 ${after.ok ? after.debts.length : "读不出"} 笔)`);
  }

  console.log("3) 持久清扫:同一行再扫一遍,不许销账也不许收档");
  {
    const before = beats(beat);
    const shim = installShim("lsof", PARTIAL_LSOF);
    const swept = await sweepAgentCleanupDebts();
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const rows = await listAllCleanupDebts();
    if (swept.ok && swept.settled === 0) ok("一笔都没销");
    else fail(`销了 ${swept.ok ? swept.settled : "?"} 笔`);
    if (swept.ok && swept.closed === 0) ok("也没收档:文件还在 ⇒ 下一轮还问得出来 ⇒ 该重试");
    else fail(`收了 ${swept.ok ? swept.closed : "?"} 笔的档 —— 收过档的行不再进重试名单`);
    if (rows.ok && rows.debts.length === 1) ok("行还在");
    else fail("行没了");
    await wait(200);
    if (isPidAlive(orphan) && beats(beat) > before) {
      ok(`而那个后代确实还在写(心跳 ${before} -> ${beats(beat)})`);
    } else fail("后代已经不在了,这一组没测到东西");
  }

  console.log("4) 整张进程表:退非零但吐了半截 ⇒ 整问作废");
  if (existsSync("/proc")) {
    console.log("   ~ 这台机器有 /proc,进程表走的不是 ps 那条路,跳过");
  } else {
    const shim = installShim("ps", 'printf "    1     0 Mon Jan  1 00:00:00 2024\\n"\nexit 2\n');
    const table = await processTableSnapshot();
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    if (table === null) ok("半截表不是一棵进程树:这一问答「没问出来」");
    else fail(`半截表被解析成了一棵树(${table.gens.size} 项)—— 缺席会被读成「不在树上」`);
  }
  console.log("5) 正常退出、但来源自己声明输出不完整 ⇒ 不许读成问全了");
  {
    const shim = installShim("lsof", INCOMPLETE_LSOF);
    const declared = await probeFileHolders(out);
    const fault = holderScanFault(declared);
    if (fault) ok(`如实说没问全(${fault.fault.slice(0, 40)}…)`);
    else fail("它退 0 就被当成问全了 —— 第 6 轮审查 F1 的那一下");
    if (fault && !fault.retriable) {
      ok("而且是不可重试那一档:扫不动的那个挂载还在,下一次是同一句 ⇒ 收档而不是无穷重试");
    } else if (fault) fail("被判成可重试:那会让这笔账每轮都重问、永不收敛");

    const judged = await cleanupAfterRun(parent);
    const kept = await listAllCleanupDebts();
    if (judged.kind !== "empty") ok(`即时清理结论仍是 ${judged.kind}`);
    else fail("即时清理据此宣布清空(实测过的那条路:责任 1 -> 0,后代还在写)");
    if (kept.ok && kept.debts.length === 1) ok("责任还在");
    else fail(`责任被销掉了(现在 ${kept.ok ? kept.debts.length : "读不出"} 笔)`);

    const swept = await sweepAgentCleanupDebts();
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const rows = await listAllCleanupDebts();
    if (swept.ok && swept.settled === 0) ok("持久清扫一笔没销");
    else fail(`清扫销了 ${swept.ok ? swept.settled : "?"} 笔`);
    if (swept.ok && swept.closed === 1) ok("按「追到这里为止」收档,行留着等人处置");
    else fail(`收档 ${swept.ok ? swept.closed : "?"} 笔:不可重试的没答全该收档,不该挂着空转`);
    if (rows.ok && rows.debts.length === 1) ok("行还在(收档不等于销账)");
    else fail("行没了");
  }

  console.log("6) 进程表里的活节点缺代次:存在 / 可核验 / 不存在是三件事");
  if (existsSync("/proc")) {
    console.log("   ~ 这台机器有 /proc,进程表走的不是 ps 那条路,跳过");
  } else {
    // 现场:父进程活着,它下面一个**脱离进程组**的活孩子,孩子再带一个孙子。
    // 孩子把环境洗掉、不继承任何运行专属文件 —— 于是唯一看得见它的设备就是 ppid 树,
    // 跟审查在 Windows 真机上那一组同形(那边父进程退出后 ppid 仍指向它)。
    const beat2 = join(root, "beat2");
    const kidPidFile = join(root, "kid.pid");
    const grandPidFile = join(root, "grand.pid");
    const kidSrc = 'const { spawn } = require("node:child_process");\n'
      + 'const fs = require("node:fs");\n'
      + 'const grand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],'
      + ' { detached: false, stdio: "ignore" });\n'
      + "fs.writeFileSync(process.argv[2], String(grand.pid));\n"
      + "let n = 0; setInterval(() => fs.writeFileSync(process.argv[1], String(++n)), 50);\n";
    const token2 = mintUnitToken();
    const live = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const kid = spawn(process.execPath,
        ["-e", ${JSON.stringify(kidSrc)}, ${JSON.stringify(beat2)}, ${JSON.stringify(grandPidFile)}],
        { detached: true, stdio: "ignore", env: {} });
      require("fs").writeFileSync(${JSON.stringify(kidPidFile)}, String(kid.pid));
      kid.unref();
      setInterval(() => {}, 1000);
    `], { stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: token2 } });
    registerUnitToken(live, token2);
    await wait(700);
    const kidPid = Number(readFileSync(kidPidFile, "utf8"));
    const grandPid = Number(readFileSync(grandPidFile, "utf8"));
    strays.push(kidPid, grandPid);
    assert.ok(isPidAlive(kidPid) && isPidAlive(grandPid), "这一组要一个活着的孩子和孙子");

    // 夹具只改一件事:把**这个孩子**那一行的启动时刻抹掉(pid/ppid/其它行全部原样)。
    // 这就是 Windows 上 `ConvStart` 给不出时刻、以及 `ps` 偶发缺字段时的真实输入形状。
    const shim = installShim("ps",
      `/bin/ps "$@" | awk -v t=${kidPid} '{ if ($1 == t) printf "%s %s \\n", $1, $2; else print }'\n`);
    const snap = await processTableSnapshot();
    const tree = snap ? subtreesOf(snap, [{ pid: live.pid! }])[0]! : null;
    const swept = await collectEscapees(live);
    const judged = await cleanupAfterRun(live);
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const rows = await listAllCleanupDebts();

    if (snap?.unverified.has(kidPid)) ok("快照把它记成「在表上、核验不了这一代」");
    else fail("缺代次的活节点被整行丢掉了 —— 它于此刻起等于不存在");
    if (snap?.kids.get(live.pid!)?.includes(kidPid)) ok("父子关系照记(丢掉这条边等于整条分支消失)");
    else fail("连父子关系一起丢了");
    if (tree?.unverified.includes(kidPid)) ok("子树如实报出它");
    else fail("子树没报它");
    if (!tree?.descendants.some((m) => m.pid === kidPid)) ok("但不进成员名单:没有代次就没有下刀凭证");
    else fail("给了一个核验不了的号下刀凭证");
    if (tree?.descendants.some((m) => m.pid === grandPid)) ok("遍历穿过它继续往下走:孙子还在名单里");
    else fail("它下面整条分支也从遍历里消失了(第 6 轮审查 F1 的后半段)");
    if (!swept.answered) ok("收口处如实说「这一轮没问清楚」");
    else fail("仍自称问清楚了 —— 据此就会释放证据、销掉责任");
    if (judged.kind !== "empty") ok(`清理结论是 ${judged.kind},不是清空`);
    else fail("清理宣布清空(Windows 真机上实测的那一下:一笔债都没落)");
    if (rows.ok && rows.debts.length === 2) ok("这一次运行的责任落了库");
    else fail(`责任没落库(库里 ${rows.ok ? rows.debts.length : "读不出"} 笔)`);
    await wait(200);
    const before = beats(beat2);
    await wait(250);
    if (isPidAlive(kidPid) && beats(beat2) > before) {
      ok(`而那个孩子确实还活着、还在写(心跳 ${before} -> ${beats(beat2)})`);
    } else fail("孩子已经不在了,这一组没测到东西");
  }

  console.log("7) 进程表里有行连号都没认出来 ⇒ 这一轮不算问清楚");
  if (existsSync("/proc")) {
    console.log("   ~ 这台机器有 /proc,进程表走的不是 ps 那条路,跳过");
  } else {
    // 现场:整张表照原样出,只多一行**开头像个号、却认不出号**的垃圾(真实诱因是输出被截断、
    // 或者 Windows 那边某一行字段缺位)。它跟「有号没代次」那一档的区别是连名字都没有,
    // 所以收口处只能按「这张表有几行没进来」如实报,而不能当它不存在 —— 缺席在这条路上
    // 读作「不在树上」。
    const beat3 = join(root, "beat3");
    const token3 = mintUnitToken();
    const live = spawn(process.execPath, ["-e", `
      const fs = require("fs");
      let n = 0; setInterval(() => fs.writeFileSync(${JSON.stringify(beat3)}, String(++n)), 50);
    `], { stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: token3 } });
    registerUnitToken(live, token3);
    strays.push(live.pid!);
    await wait(400);

    const shim = installShim("ps",
      '/bin/ps "$@"\n'
      + 'case " $* " in *" -A "*) printf "9999999\\n" ;; esac\n');
    const snap = await processTableSnapshot();
    const swept = await collectEscapees(live);
    const judged = await cleanupAfterRun(live);
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const rows = await listAllCleanupDebts();

    if (snap && snap.unnamed >= 1) ok(`快照如实数出没认下来的行(${snap.unnamed} 行)`);
    else fail("认不出来的行被静默丢掉了:那一行自此等于不存在");
    if (snap?.gens.has(live.pid!)) ok("认得出来的行照旧成表(不是整问作废,还杀得动已证明的目标)");
    else fail("连认得出来的行也没进表");
    if (!swept.answered) ok("收口处如实说「这一轮没问清楚」");
    else fail("仍自称问清楚了 —— 据此就会释放证据、销掉责任");
    if (swept.faults.some((f) => f.includes("连号都没认出来"))) ok("而且说得出是哪一问没答全");
    else fail(`没把这一条写进事由:${swept.faults.join(" / ") || "(一条都没有)"}`);
    if (judged.kind !== "empty") ok(`清理结论是 ${judged.kind},不是清空`);
    else fail("清理宣布清空 —— 有行没进表,这个结论没有证据来源");
    if (rows.ok && rows.debts.length === 3) ok("这一次运行的责任落了库");
    else fail(`责任没落库(库里 ${rows.ok ? rows.debts.length : "读不出"} 笔)`);
  }

  console.log("8) 根已经被 reap 掉之后,不许把号上**现在**那个进程的代次写进账");
  if (existsSync("/proc")) {
    console.log("   ~ 这台机器有 /proc,这一组的 ps 夹具不适用,跳过");
  } else {
    // 现场:自己 spawn 的孩子已经退出并被 reap(于是这个号随时可能被系统分给别人),
    // 收尾那一刻才去落账。夹具把「这个号现在是谁」答成**一个陌生进程**(给它编一个启动
    // 时刻)—— 这就是号被复用那一瞬间的真实输入形状,线上那个窗口只有几百毫秒,但它会把
    // 账上的「根这一代」永久写歪:下一次清扫拿它去核身份,陌生进程的代次当然对得上,
    // 于是那一行永远停在「根进程还活着」,既销不掉,还把别人的进程指成我们的残留。
    const token4 = mintUnitToken();
    const gone = spawn(process.execPath, ["-e", "process.exit(0)"],
      { stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: token4 } });
    registerUnitToken(gone, token4);
    const deadPid = gone.pid!;
    await new Promise<void>((resolve) => gone.once("exit", () => resolve()));
    await wait(100);

    const fakeStart = "Mon Oct 20 10:00:00 2026";   // 正好 24 字,`inspectProcessSync` 认的那个形状
    const shim = installShim("ps",
      `case " $* " in *" -p ${deadPid} "*) printf "${fakeStart} /usr/bin/someone-elses-process\\n"; exit 0 ;; esac\n`
      + '/bin/ps "$@"\n'
      // 顺带让这一轮答不清楚,好逼出一行账来看它记了什么(这一问本身见第 7 组)
      + 'case " $* " in *" -A "*) printf "9999999\\n" ;; esac\n');
    const judged = await cleanupAfterRun(gone);
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const rows = await listAllCleanupDebts();
    const row = rows.ok ? rows.debts.find((d) => d.rootPid === deadPid) : undefined;

    if (judged.kind !== "empty") ok(`这一轮没问清楚,结论是 ${judged.kind}`);
    else fail("这一组的前提没成立:没有账可看");
    if (row) ok("账记下来了");
    else fail("这一次运行的账没落库,看不到它记的根代次");
    if (row && row.rootStartedAt === null) {
      ok("根这一代如实留空:孩子已经被 reap,现查到的那个不是它");
    } else if (row) {
      fail(`把号上现在那个进程的代次写进了账(${String(row.rootStartedAt)})—— 第 6 轮审查 N10`);
    }
  }

  console.log("9) 活后代挂不到树上:「这棵树里没看到」不等于「已经排除了它」");
  if (existsSync("/proc")) {
    console.log("   ~ 这台机器有 /proc,进程表走的不是 ps 那条路,跳过");
  } else {
    // 现场与第 6 组同形(活父进程 + 脱离进程组的活孩子),但夹具这次动的是**父子那一列**:
    // 把孩子那一行的父号改成它自己 —— 这条边指不到任何别的节点,等于「它挂在谁下面问不
    // 出来」。审查在 Linux 上用一次 stat 读失败(EACCES)复现的是同一个输入形状:节点在表上、
    // 没有任何边,于是任何子树都遍历不到它,收口却答「问清楚了、没有后代」。
    const beat4 = join(root, "beat4");
    const kidPidFile = join(root, "kid4.pid");
    const kidSrc = 'const fs = require("node:fs");\n'
      + "let n = 0; setInterval(() => fs.writeFileSync(process.argv[1], String(++n)), 50);\n";
    const token5 = mintUnitToken();
    const live = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const kid = spawn(process.execPath,
        ["-e", ${JSON.stringify(kidSrc)}, ${JSON.stringify(beat4)}],
        { detached: true, stdio: "ignore", env: {} });
      require("fs").writeFileSync(${JSON.stringify(kidPidFile)}, String(kid.pid));
      kid.unref();
      setInterval(() => {}, 1000);
    `], { stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: token5 } });
    registerUnitToken(live, token5);
    await wait(700);
    const kidPid = Number(readFileSync(kidPidFile, "utf8"));
    strays.push(kidPid);
    assert.ok(isPidAlive(kidPid), "这一组要一个活着的孩子");

    const before = await listAllCleanupDebts();
    const shim = installShim("ps",
      `/bin/ps "$@" | awk -v t=${kidPid} '{ if ($1 == t) { s=""; for (i=3; i<=NF; i++) s = s $i " ";`
      + ` printf "%s %s %s\\n", $1, $1, s } else print }'\n`);
    const snap = await processTableSnapshot();
    const swept = await collectEscapees(live);
    const judged = await cleanupAfterRun(live);
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const rows = await listAllCleanupDebts();

    if (snap?.unlinked.has(kidPid)) ok("快照把它记成「挂在谁下面问不出来」");
    else fail("这一行被当成了普通行 —— 它从此既不在任何树上、也没人替它说话");
    if (!(snap?.kids.get(live.pid!) ?? []).includes(kidPid)) ok("前提成立:它确实不在父进程名下了");
    else fail("夹具没生效,这一组没测到东西");
    if (!swept.answered) ok("收口处如实说「这一轮没问清楚」");
    else fail("仍自称问清楚了 —— 据此就会释放证据、销掉责任(第 7 轮审查 F1)");
    if (swept.faults.some((f) => f.includes(String(kidPid)) && f.includes("挂在谁下面问不出来"))) {
      ok("而且点出了是哪个号、哪一问没答全");
    } else fail(`没把这一条写进事由:${swept.faults.join(" / ") || "(一条都没有)"}`);
    if (judged.kind !== "empty") ok(`清理结论是 ${judged.kind},不是清空`);
    else fail("清理宣布清空、一笔债都没落(审查实测的那条路)");
    if (rows.ok && before.ok && rows.debts.length === before.debts.length + 1) ok("这一次运行的责任落了库");
    else fail(`责任没落库(之前 ${before.ok ? before.debts.length : "?"} 笔,现在 ${rows.ok ? rows.debts.length : "?"} 笔)`);
    await wait(200);
    const beats0 = beats(beat4);
    await wait(250);
    if (isPidAlive(kidPid) && beats(beat4) > beats0) {
      ok(`而那个孩子确实还活着、还在写(心跳 ${beats0} -> ${beats(beat4)})`);
    } else fail("孩子已经不在了,这一组没测到东西");
  }

  console.log("10) 反过来也得成立:别人家那个挂不上树的老进程不许拖着我们欠债");
  if (existsSync("/proc")) {
    console.log("   ~ 这台机器有 /proc,进程表走的不是 ps 那条路,跳过");
  } else {
    // 「挂不上树 ⇒ 不许判空」如果不带排除路,就会变成另一个方向的错:表上任何一个读不出父号
    // 的**陌生**进程都会让每一次正常收尾压一笔永远销不掉的债(第 3 轮审查 N2 要堵的那种)。
    // 这一组把 1 号(开机起就在的 launchd)那一行的父号改成它自己 —— 它确实挂不上树,但它
    // 明显早于本次运行开工,所以必须被排除掉,结论照样是「空」。
    const before = await listAllCleanupDebts();
    const outPath = join(root, "clean.out");
    writeFileSync(outPath, "");
    const token6 = mintUnitToken();
    const clean = spawn(process.execPath, ["-e", "process.exit(0)"],
      { stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: token6 } });
    registerUnitToken(clean, token6);
    registerRunOutPath(clean, outPath);
    await new Promise<void>((resolve) => clean.once("exit", () => resolve()));

    const shim = installShim("ps",
      `/bin/ps "$@" | awk '{ if ($1 == 1) { s=""; for (i=3; i<=NF; i++) s = s $i " ";`
      + ` printf "%s %s %s\\n", $1, $1, s } else print }'\n`);
    const snap = await processTableSnapshot();
    const swept = await collectEscapees(clean);
    const judged = await cleanupAfterRun(clean);
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const rows = await listAllCleanupDebts();

    if (snap?.unlinked.has(1)) ok("前提成立:1 号这一行确实挂不上树了");
    else fail("夹具没生效,这一组没测到东西");
    if (swept.answered) ok("它明显早于本次运行开工 ⇒ 按时间排除,这一轮算问清楚了");
    else fail(`陌生老进程把这一轮拖成了「没问清楚」:${swept.faults.join(" / ")}`);
    if (judged.kind === "empty") ok("结论照样是「空」");
    else fail(`结论成了 ${judged.kind} —— 每次正常收尾都会压一笔追不动的债`);
    if (rows.ok && before.ok && rows.debts.length === before.debts.length) ok("没多出一笔账");
    else fail(`多压了账(之前 ${before.ok ? before.debts.length : "?"} 笔,现在 ${rows.ok ? rows.debts.length : "?"} 笔)`);
  }

} finally {
  restorePath();
  for (const pid of [orphan, ...strays]) {
    if (pid > 1) { try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ } }
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过:半截查询不会再被当成查全");
process.exit(bad ? 1 : 0);
