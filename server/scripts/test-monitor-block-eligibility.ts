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
//   管不管得着它），任一项读不出来**就不是硬拦的依据**。
//
// 所以这边的用例一律**成对**:把那一项补齐了就照拦、拿掉就放行。只往某一张表里加一条字符串
// 的预期值验不出这件事 —— 第 1 轮审查 F1 点的正是这个（`printf 'DONE\n' | tail -f` 几毫秒就
// 退出 0，却因为「认出了 `-f`」被 409）。
import assert from "node:assert/strict";
import { join } from "node:path";
import { neverExitsOnItsOwn } from "@ash/shared/command-never-exits";
import { readSource } from "../../scripts/read-source.mjs";
import { HERE, startMonitor, stopMonitor, makeTask, teardown } from "./monitors-fixture.js";

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
  console.log("✓ 硬拦资格：`set -e` 之后的可达性按短路算；`set` 自己那一段和它之前的照拦");
}
// ── ④ 结构锁:这几道不许悄悄退回去 ──────────────────────────────────────────────────
// 上面三节是「这一批输入的答案对不对」,这一节是「判据的形状还在不在」—— 把 `follows` 改回只
// 收 argv、把那几个开关重新收进白名单、把 `set -e` 那一道摘掉,都是一次改一行就能做到的事。
{
  const JUDGE = readSource(join(HERE, "../../shared/src/command-never-exits.ts"));
  const FOLLOWERS = readSource(join(HERE, "../../shared/src/command-followers.ts"));
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
  assert.match(JUDGE, /const errexit = errexitAt\(segs\)/, "`set -e` 那一道必须接在可达性上");
  assert.match(
    JUDGE, /errexit >= 0 && i >= errexit/,
    "`;`/换行 的可达性必须问一句「`set -e` 开了没有」（见该文件头 ⑦）",
  );
  console.log("✓ 硬拦资格：三道判据的形状受结构锁保护");
}
// ── ⑤ 真实创建入口:降级之后这几条命令**真的能建**（第 1 轮审查 F1 的现场）───────────
// 判据只是个函数,用户那一侧感受到的是 409。这一节走真实创建路由确认那三条命令现在建得出来,
// 而事故的起因命令照旧拦 —— 不然「降级」很容易变成「把闸整个拆了」。
{
  const taskId = await makeTask();
  for (const command of [
    "printf 'DONE\\n' | tail -f",
    "printf 'DONE\\n' | tail -F",
    "set -e; false; tail -F /dev/null",
  ]) {
    const made = await startMonitor({ taskId, command, description: "会自己结束的命令", timeoutMs: 4000 });
    assert.equal(made.ok, true, made.ok ? "" : `这条命令会自己结束,不许拦：${command} / ${made.error}`);
    if (made.ok) await stopMonitor(made.monitor.id, "硬拦资格那一节跑完了");
  }
  const denied = await startMonitor({
    taskId, command: "tail -F build.log 2>/dev/null | grep --line-buffered ERROR", description: "事故的起因命令",
  });
  assert.equal(denied.ok, false, "起因命令照旧要拦:判据降级不是把闸拆了");
  assert.equal(denied.ok ? 0 : denied.status, 409);
  console.log("✓ 硬拦资格：会自己结束的那几条真的建得出来，而起因命令照旧 409");
}
console.log("✓ 硬拦资格：输入来源 / argv 的出口 / shell 状态 三项任一读不出来就降级 均受回归保护");
await teardown();
