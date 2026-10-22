// 哨兵**硬拦资格**的回归:一条命令凭什么被当成「它自己永远不会结束」、在起进程之前就 409。
//
// 从 test-monitor-end-condition.ts 拆出来的（全局约定:单文件不超过 700 行）。那边钉的是结束
// 条件这一块的**运行时行为**（命中就收工、拦下时三条出路给全、读不出来的条件要出声），这边
// 钉的是判据的**资格边界**本身 —— 所以除了最后一节，这边不起进程、也不碰库。
//
// 钉住的立论只有一条（见 shared/src/command-never-exits.ts 文件头 ⑦）:
//
//   **硬拦只用「盖得住整条命令必要执行与退出语义」的那种证明** —— 执行资格（这一条跑不跑得
//   到）、argv（它到底有没有开始跟随）、输入来源（它盯的是谁）、shell 状态（前面那条的退出码
//   管不管得着它）、下游（谁在收它的 stdout）、以及它盯的那个东西在不在，任一项读不出来**就
//   不是硬拦的依据**。
//
// 所以这边的用例一律**成对**:把那一项补齐了就照拦、拿掉就放行。只往某一张表里加一条字符串
// 的预期值验不出这件事 —— 第 1 轮审查 F1 点的正是这个（`printf 'DONE\n' | tail -f` 几毫秒就
// 退出 0，却因为「认出了 `-f`」被 409）。
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { neverExitsOnItsOwn, neverExitsVerdict } from "@ash/shared/command-never-exits";
import { readSource } from "../../scripts/read-source.mjs";
import { HERE, root, startMonitor, stopMonitor, makeTask, teardown } from "./monitors-fixture.js";

/** `[这一条该拦, 判定它的写法, 同一条命令少了那一项 ⇒ 该放行]`。 */
type Pair = readonly [string, string, string];

const blocks = (command: string, hit: string, why: string) =>
  assert.equal(neverExitsOnItsOwn(command), hit, `${why}，这一条必须照拦：${command}`);
const passes = (command: string, why: string) =>
  assert.equal(neverExitsOnItsOwn(command), null, `${why}，这一条不许拦：${command}`);

// ── ① 「它盯的是谁」得写在 argv 里（第 1 轮审查 F1）────────────────────────────────
// 跟随型命令不带那个操作数时盯的是**标准输入**或者干脆打一句用法就退,而「管道那头是什么」
// 不写在命令文本里 —— 这一层答不出来就不是硬拦的依据。
{
  const TARGETS: readonly Pair[] = [
    ["tail -F /var/log/app.log", "tail -f/-F", "tail -F"],
    ["tail -f /var/log/app.log", "tail -f/-F", "tail -f"],
    ["tail -F -n 100 /var/log/app.log", "tail -f/-F", "tail -F -n 100"],
    ["inotifywait -m /tmp", "inotifywait -m", "inotifywait -m"],
    ["fswatch /tmp", "fswatch", "fswatch"],
    ["watch date", "watch", "watch"],
    ["kubectl logs -f pod-1", "kubectl logs -f", "kubectl logs -f"],
    ["docker logs -f app", "docker logs -f", "docker logs -f"],
    ["podman logs -f app", "podman logs -f", "podman logs -f"],
  ];
  for (const [whole, hit, bare] of TARGETS) {
    blocks(whole, hit, "要盯的那个东西写齐了");
    passes(bare, "少了要盯的那个东西 ⇒ 它盯的是标准输入、或者打一句用法就退");
  }
  // 反面:`journalctl -f` 盯的是日志本身,**不要**操作数 —— 这一道不许把它一起放掉。
  blocks("journalctl -f", "journalctl -f", "它盯的东西不靠操作数指定");
  // 真正的操作数要**数对**:带值的开关连值一起吃掉,不然命名空间会被数成「要盯的那个 pod」,
  // 而真 kubectl 少了 pod 名字只会打一句用法就退。
  for (const command of ["kubectl logs -f -n ns", "kubectl logs -f --container=c", "docker logs -f -n 10"]) {
    passes(command, "那个词是开关的值,不是要盯的东西");
  }
  for (const [command, hit] of [
    ["kubectl logs -f -n ns pod-1", "kubectl logs -f"],
    ["docker logs -f -n 10 app", "docker logs -f"],
    ['tail -F "my file"', "tail -f/-F"],                  // 引号里的词也是操作数
  ] as const) blocks(command, hit, "开关的值之外还有真的操作数");
  // 管道那头读完就 EOF（第 1 轮审查 F1 实测:几毫秒,退出 0 并打出 DONE;BSD tail 干脆把 `-f`
  // 忽略掉）。换成 `/dev/null` 或终端它又能一直挂着 —— 正因为答案在命令文本之外,所以降级。
  for (const command of ["printf 'DONE\\n' | tail -f", "printf 'DONE\\n' | tail -F", "tail -f -", "tail -F --"]) {
    passes(command, "它盯的是标准输入,那头是什么这一层答不出来");
  }
  // 真阳对照:同一条管道里 tail 盯的是**文件**,标准输入关不关它的事 ⇒ 照拦。
  blocks("printf 'x\\n' | tail -f /var/log/app.log", "tail -f/-F", "管道里的 tail 盯的是文件");
  blocks("tail -F build.log 2>/dev/null | grep --line-buffered ERROR", "tail -f/-F", "事故的起因命令");
  console.log("✓ 硬拦资格：要盯的那个东西没写在 argv 里 ⇒ 降级；写齐了的照拦");
}
// ── ② 自带出口的开关:白名单只确认「我认识它」是不够的 ──────────────────────────────
// 认得这个开关、**还得知道它不会给这条命令开一条出口**。所以这几个开关一律不在白名单上,
// 带着它的那条 argv 直接落到「读不懂 ⇒ 不拦」。
{
  const EXITS: readonly Pair[] = [
    ["tail -F /dev/null", "tail -f/-F", "tail --pid=123 -F /dev/null"],   // 那个进程一死它就退
    ["tail -F /dev/null", "tail -f/-F", "tail -rf /dev/null"],            // 实测:当场打用法就退
    ["tail -F /dev/null", "tail -f/-F", "tail -r -F /dev/null"],
    ["watch date", "watch", "watch -e date"],                             // 出错就退
    ["watch date", "watch", "watch --errexit date"],
    ["watch date", "watch", "watch -g date"],                             // 有变化就退
    ["watch date", "watch", "watch --chgexit date"],
    ["inotifywait -m /tmp", "inotifywait -m", "inotifywait -m -d /tmp"],  // 转后台,前台这个就退
    ["inotifywait -m /tmp", "inotifywait -m", "inotifywait -m --daemon /tmp"],
    ["kubectl logs -f pod-1", "kubectl logs -f", "kubectl logs -f -p pod-1"],  // 已结束容器的日志
    ["kubectl logs -f pod-1", "kubectl logs -f", "kubectl logs -f --previous pod-1"],
    ["journalctl -f", "journalctl -f", "journalctl -f -e"],                // 跟「一直跟随」对着干
    ["journalctl -f", "journalctl -f", "journalctl -f -r"],
    // 同一道的老用例（第 2 轮审查 F2）:参数不对形状 ⇒ 它在校验那一步就退,根本没开始跟随。
    ["tail -F /dev/null", "tail -f/-F", "tail -F -n not-a-number /dev/null"],
    ["inotifywait -m /tmp", "inotifywait -m", "inotifywait -m -t 60 /tmp"],
  ];
  for (const [base, hit, withExit] of EXITS) {
    blocks(base, hit, "这条 argv 上没有出口");
    passes(withExit, "这个开关给它开了一条出口（或者让它根本没开始跟随）");
  }
  console.log("✓ 硬拦资格：argv 上出现「自带出口」的开关 ⇒ 降级；同一条命令去掉它照拦");
}
// ── ③ shell 状态:`set -e` 之后,`;` 的意思跟 `&&` 一样（第 1 轮审查 F1）──────────────
// `set -e; false; tail -F /dev/null` 实测退出 1,那个 tail **一次都没跑** —— 前一条退出码非零
// 时 shell 当场就走了。所以这个下标往后的每一条都要先证明得出「前一条成功了」,而那是退出码。
{
  for (const command of [
    "set -e; false; tail -F /dev/null",
    "set -eu; false; tail -F /dev/null",
    "set -euo pipefail; false; tail -F /dev/null",
    "set -o errexit; false; tail -F /dev/null",
    "set -e; printf 'A\\n'; tail -F /dev/null",            // printf 也可能失败（EPIPE/磁盘满）
    "set -e\nfalse\ntail -F /dev/null",                    // 换行跟 `;` 同判
    "set -e; false; while true; do :; done",               // 恒真循环同判
  ]) passes(command, "`set -e` 之后前一条的退出码管得着它,而那答不出来");
  for (const [command, hit] of [
    // `set` 自己是个一定成功的内建:拿它当「前一条可能失败」会把这条也放过去（tail 确实会跑）。
    ["set -e; tail -F /dev/null", "tail -f/-F"],
    ["set -eu; tail -F /dev/null", "tail -f/-F"],
    ["set -e; tail -F /dev/null; printf 'x\\n'", "tail -f/-F"],
    // 这道闸是**从那一段起**生效的,不往前追。
    ["tail -F /dev/null; set -e", "tail -f/-F"],
    // `set +e` 是**关掉**它（而且本来就是默认关着的）:后面那条照跑 ⇒ 照拦。
    ["set +e; false; tail -F /dev/null", "tail -f/-F"],
    // 引号里的 `set -e` 不是一条命令,是 printf 的参数。
    ["printf 'set -e'; false; tail -F /dev/null", "tail -f/-F"],
  ] as const) blocks(command, hit, "`set -e` 要么没开、要么管不着这一条");
  // **循环体自己也是一条出路**（新一轮审查 F1 第 2 条）:`set -e; while true; do false; done`
  // 实测退出 1 —— 体里任何一条返回非零,shell 当场走人,而「这一圈里每一条都一定成功」答不
  // 出来。所以这道闸盖到循环的**收尾那一段**。
  for (const command of [
    "set -e; while true; do false; done",
    "set -e; until false; do grep -q DONE log; done",
    "set -euo pipefail; while :; do false; done",
    "while true; do set -e; false; done",                  // 体里才开的那个同样算
  ]) passes(command, "`set -e` 下循环体里任何一条失败都会把 shell 带走");
  // 不往前追这一条对循环同样成立:循环之后才开的那个管不着它。
  blocks("while true; do :; done; set -e", "while true / until false", "`set -e` 开在循环之后");
  console.log("✓ 硬拦资格：`set -e` 之后的可达性按短路算（循环体也算）；`set` 自己那一段和它之前的照拦");
}
// ── ④ 下游:管子那头先退出就把它关了（新一轮审查 F1 第 1 条）────────────────────────────
// `while true; do printf 'DONE\n'; done | head -n 1` 实测打一行 DONE 就退出 0。恒真循环的证明
// 里藏着**「它的 stdout 一直有人收」**:下游先退就把管子关了,循环体下一次往 stdout 写当场吃
// SIGPIPE。而「这个循环体到底往不往 stdout 写」这一层答不出来 —— `while true; do :; done |
// head -n 1` 一个字都不写、`head` 一直等,那一条实测真的挂住（3 秒超时没退,这是本节明写的
// 漏判成本）。
{
  for (const command of [
    "while true; do printf 'DONE\n'; done | head -n 1",
    "while true; do printf x; done | grep ERROR",          // 下游认不认得都一样:它可能先退
    "{ while true; do printf x; done; } | head -n 1",      // 整组被管道接走同判
    "( while true; do printf x; done ) | head -n 1",
    "while true; do printf x; done | head -n 1 | cat",     // 多级管道
  ]) passes(command, "恒真循环一旦有下游,「stdout 一直有人收」就证明不出来了");
  for (const [command, hit] of [
    ["while true; do printf 'x\n'; done", "while true / until false"],
    ["printf 'x\n' | while true; do :; done", "while true / until false"],   // 循环在最后一级
    ["while true; do printf x; done 2>/dev/null", "while true / until false"], // 重定向不是管道
    // **跟随型不走这一道**:它的输出是间歇的,下游退了也可能永远不触发那一次写入 ——
    // `tail -f x | grep -m1 y` 日志一安静就整条挂住（见 command-followers.ts 文件头那段）。
    ["tail -f /var/log/app.log | head -n 1", "tail -f/-F"],
    ["tail -F build.log 2>/dev/null | grep --line-buffered ERROR", "tail -f/-F"],
  ] as const) blocks(command, hit, "这一条的不退出不靠「下游一直在收」");
  console.log("✓ 硬拦资格：恒真循环有下游 ⇒ 降级；没有下游的、以及跟随型照拦");
}
// ── ⑤ 判定的前提:它盯的那个东西在不在（新一轮审查 F1 第 3 条）──────────────────────────
// `tail -f /definitely-missing-ash-review; printf 'DONE\n'` 实测报一句 No such file 就退出、
// 随后打出 DONE。前提不写在命令文本里,所以**判据这一层只交出前提**（它也读不到文件系统:
// 同一份判据跑在浏览器里），由读得出来的那一层核（下面 ⑦ 走真实创建入口）。
{
  for (const [command, assumes] of [
    ["tail -f build.log", ["build.log"]],
    ["tail -f 'build.log'", ["build.log"]],
    ["tail -f -- build.log", ["build.log"]],
    ["tail -f a.log b.log", ["a.log", "b.log"]],           // 全不在才算前提落空
    ["inotifywait -m /tmp/a /tmp/b", ["/tmp/a", "/tmp/b"]],
    ["fswatch /tmp/a", ["/tmp/a"]],
  ] as const) {
    assert.deepEqual(
      neverExitsVerdict(command)?.assumesAnyExists, assumes,
      `这一条的不退出有前提，前提必须交出来：${command}`,
    );
  }
  for (const command of [
    "tail -F build.log",                                   // 没了也一直重试 ⇒ 不要这个前提
    "tail -f --retry build.log",
    "tail -f --follow=name build.log",
    "journalctl -f",                                       // 盯的是日志本身
    "watch date",                                          // 盯的是一条命令,失败也照旧重来
    "kubectl logs -f pod-1",                               // 远端资源名,本机读不出来
    "while true; do :; done",
  ]) {
    assert.deepEqual(
      neverExitsVerdict(command)?.assumesAnyExists, [],
      `这一条的不退出不依赖本地路径，不许凭空长出前提：${command}`,
    );
  }
  console.log("✓ 硬拦资格：判定带着的前提原样交出来，重试型与非路径型不带前提");
}
// ── ⑥ 结构锁:这几道不许悄悄退回去 ──────────────────────────────────────────────────
// 上面几节是「这一批输入的答案对不对」,这一节是「判据的形状还在不在」—— 把 `follows` 改回只
// 收 argv、把那几个开关重新收进白名单、把 `set -e` 或管道那一道摘掉,都是一次改一行就能做到
// 的事。
{
  const JUDGE = readSource(join(HERE, "../../shared/src/command-never-exits.ts"));
  const FOLLOWERS = readSource(join(HERE, "../../shared/src/command-followers.ts"));
  const CREATE = readSource(join(HERE, "../src/monitor-create.ts"));
  assert.match(
    FOLLOWERS, /function operandsIfUnderstood\(/,
    "认 argv 那一趟必须同时交出**真正的操作数**（见该文件头 ③）",
  );
  assert.match(
    FOLLOWERS, /f\.follows\(argv, operands\)/,
    "跟随判定必须拿到真正的操作数：不然「它盯的是谁」这一项又没人问了",
  );
  // 只认**条目**（`{ re: … }`），注释里提这几个名字不算 —— 它们恰恰该写在注释里说明为什么不收。
  for (const [name, re] of [
    ["tail --pid=", /^\s*\{ re: .*--pid/m],
    ["watch -e/-g", /^\s*\{ re: .*(?:errexit|chgexit)/m],
    ["inotifywait -d", /^\s*\{ re: .*daemon/m],
    ["kubectl --previous", /^\s*\{ re: .*previous/m],
  ] as const) {
    assert.doesNotMatch(FOLLOWERS, re, `${name} 自带出口，不许收进白名单（见该文件头 ②）`);
  }
  assert.match(FOLLOWERS, /needsExisting/, "跟随型必须交出「它盯的那个东西得在」这个前提（见该文件头 ④）");
  assert.match(JUDGE, /const errexit = errexitAt\(segs\)/, "`set -e` 那一道必须接在可达性上");
  assert.match(
    JUDGE, /errexit >= 0 && i >= errexit/,
    "`;`/换行 的可达性必须问一句「`set -e` 开了没有」（见该文件头 ⑦）",
  );
  assert.match(
    JUDGE, /errexit >= 0 && errexit <= end/,
    "恒真循环必须问一句「`set -e` 开了没有」—— 开了的话循环体自己就是出路（见该文件头 ⑧）",
  );
  assert.match(
    JUDGE, /case "\|": if \(pipeline\?\.fragile\) pipeline = null/,
    "恒真循环的判定必须在**出现下游**的那一刻作废（见该文件头 ⑧）",
  );
  assert.match(JUDGE, /fragile: true/, "恒真循环的判定经不起下游先退出");
  assert.match(JUDGE, /fragile: false/, "跟随型的判定不怕下游先退出（输出是间歇的）");
  assert.match(
    CREATE, /assumptionsHold\(cwd, forever\.assumesAnyExists\)/,
    "创建闸必须按**真实工作目录**核一遍判定的前提（见该文件的 `assumptionsHold`）",
  );
  console.log("✓ 硬拦资格：六道判据的形状受结构锁保护");
}
// ── ⑦ 真实创建入口:降级之后这几条命令**真的能建**（第 1 轮审查 F1 的现场）───────────
// 判据只是个函数,用户那一侧感受到的是 409。这一节走真实创建路由确认那三条命令现在建得出来,
// 而事故的起因命令照旧拦 —— 不然「降级」很容易变成「把闸整个拆了」。
{
  const taskId = await makeTask();
  for (const command of [
    "printf 'DONE\\n' | tail -f",
    "printf 'DONE\\n' | tail -F",
    "set -e; false; tail -F /dev/null",
    // 新一轮审查 F1 实测的那三条（真 shell 里分别退出 0 / 1 / 0）。
    "while true; do printf 'DONE\\n'; done | head -n 1",
    "set -e; while true; do false; done",
    `tail -f ${join(root, "definitely-missing-ash-review")}; printf 'DONE\\n'`,
    "tail -f definitely-missing-ash-review",               // 相对路径按这条哨兵的工作目录解析
  ]) {
    const made = await startMonitor({ taskId, command, description: "会自己结束的命令", timeoutMs: 4000 });
    assert.equal(made.ok, true, made.ok ? "" : `这条命令会自己结束,不许拦：${command} / ${made.error}`);
    if (made.ok) await stopMonitor(made.monitor.id, "硬拦资格那一节跑完了");
  }
  // 前提**真的成立**时照旧 409:同一条 `tail -f` 指着一个在的文件（这条哨兵的工作目录就是
  // `root`，见台子），以及路径读不出来的那种（`$LOG`、通配）—— 不然「核前提」会变成「把
  // `tail -f` 整类放掉」。
  writeFileSync(join(root, "really-here.log"), "x\n");
  for (const [command, why] of [
    ["tail -f really-here.log", "相对路径指着一个真在的文件"],
    [`tail -f ${join(root, "really-here.log")}`, "绝对路径指着一个真在的文件"],
    ["tail -f really-here.log definitely-missing-ash-review", "多个操作数里有一个真在 ⇒ 前提没落空"],
    ["tail -f $LOG", "路径读不出来 ⇒ 维持原判"],
    ["tail -f *.log", "通配读不出来 ⇒ 维持原判"],
    ["tail -F definitely-missing-ash-review", "`-F` 没了也一直重试 ⇒ 不要这个前提"],
    ["tail -F build.log 2>/dev/null | grep --line-buffered ERROR", "事故的起因命令"],
  ] as const) {
    const denied = await startMonitor({ taskId, command, description: why });
    assert.equal(denied.ok, false, `${why}，照旧要拦:判据降级不是把闸拆了 —— ${command}`);
    assert.equal(denied.ok ? 0 : denied.status, 409, `${why}：${command}`);
  }
  console.log("✓ 硬拦资格：会自己结束的那几条真的建得出来，而前提真成立的、读不出来的、起因命令照旧 409");
}
console.log("✓ 硬拦资格：输入来源 / argv 的出口 / shell 状态 三项任一读不出来就降级 均受回归保护");
await teardown();
