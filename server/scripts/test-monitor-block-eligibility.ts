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
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { neverExitsOnItsOwn, neverExitsVerdict } from "@ash/shared/command-never-exits";
import { readSource } from "../../scripts/read-source.mjs";
import { HERE, root, startMonitor, stopMonitor, makeTask, teardown } from "./monitors-fixture.js";
import { IS_WINDOWS, userShellLaunch } from "../src/platform.js";

/** `[这一条该拦, 判定它的写法, 同一条命令少了那一项 ⇒ 该放行]`。 */
type Pair = readonly [string, string, string];

const blocks = (command: string, hit: string, why: string) =>
  assert.equal(neverExitsOnItsOwn(command), hit, `${why}，这一条必须照拦：${command}`);
const passes = (command: string, why: string) =>
  assert.equal(neverExitsOnItsOwn(command), null, `${why}，这一条不许拦：${command}`);
/**
 * 「**判成了**这个写法」—— 不问它够不够资格硬拦。
 *
 * 两件事从本轮起分得开（见 ⑤b）:远端跟随器（`kubectl logs -f`）判得出形状,但它的前提谁都核
 * 不了,所以只配做提示。而「它盯的是谁有没有写在 argv 里」（① 那一节）问的恰恰是形状本身 ——
 * 拿 `blocks` 去问它，等于把两件事又黏回一起。
 */
const judged = (command: string, what: string, why: string) =>
  assert.equal(neverExitsVerdict(command)?.what ?? null, what, `${why}，这一条必须判出形状：${command}`);

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
    // 问形状而不是问资格:远端那三个的前提谁都核不了（见 ⑤b），它们判得出形状却只配做提示。
    judged(whole, hit, "要盯的那个东西写齐了");
    assert.equal(
      neverExitsVerdict(bare)?.what ?? null, null,
      `少了要盯的那个东西 ⇒ 它盯的是标准输入、或者打一句用法就退：${bare}`,
    );
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
  ] as const) judged(command, hit, "开关的值之外还有真的操作数");
  // 管道那头读完就 EOF（第 1 轮审查 F1 实测:几毫秒,退出 0 并打出 DONE;BSD tail 干脆把 `-f`
  // 忽略掉）。换成 `/dev/null` 或终端它又能一直挂着 —— 正因为答案在命令文本之外,所以降级。
  for (const command of ["printf 'DONE\\n' | tail -f", "printf 'DONE\\n' | tail -F", "tail -f -", "tail -F --"]) {
    passes(command, "它盯的是标准输入,那头是什么这一层答不出来");
  }
  // 真阳对照:同一条管道里 tail 盯的是**文件**,标准输入关不关它的事 ⇒ 判得出来。`-f` 压着
  // 「那个文件执行到那一句时还在」这个没人核得了的前提,所以落在提示那一档（见 ⑤b）;`-F`
  // 连这个前提都不要 ⇒ 硬拦。
  judged("printf 'x\\n' | tail -f /var/log/app.log", "tail -f/-F", "管道里的 tail 盯的是文件");
  blocks("printf 'x\\n' | tail -F /var/log/app.log", "tail -f/-F", "`-F` 没了也重试 ⇒ 不要前提");
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
    // 这一节问的是**形状**（这条 argv 有没有给它开一条出口），所以用 `judged`:远端那几个判得出
    // 形状却只配做提示（前提没人核得了，见 ⑤b），拿「够不够资格硬拦」去问它就把两件事黏回去了。
    judged(base, hit, "这条 argv 上没有出口");
    assert.equal(
      neverExitsVerdict(withExit)?.what ?? null, null,
      `这个开关给它开了一条出口（或者让它根本没开始跟随）：${withExit}`,
    );
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
  // `-u` 那一类是**明知的误降级**（见判据文件头 ⑪ 的 `setShaken`）:它只在命令里真的引用了未
  // 定义变量时才改变结局,而那一层答不出来 —— 于是这一条从硬拦降成提示,代价方向是对的那一侧。
  passes("set -eu; tail -F /dev/null", "`-u` 改不改得着这一条，要看有没有未定义变量，答不出来");
  for (const [command, hit] of [
    // `set` 自己是个一定成功的内建:拿它当「前一条可能失败」会把这条也放过去（tail 确实会跑）。
    ["set -e; tail -F /dev/null", "tail -f/-F"],
    ["set -ex; tail -F /dev/null", "tail -f/-F"],         // xtrace 一个字的执行语义都不改
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
// ── ④ 下游:管子那头会不会**一直读到头**（两轮审查 F1）────────────────────────────────
// 三轮实测把这件事钉成了一条判据,而不是按工具名分的特例:
//  · `while true; do printf 'DONE\n'; done | head -n 1` 打一行就退出 0;
//  · `tail -f -n +1 large.log | head -n 1`（预填 350KB）同样退出 0 —— 所以「跟随型不怕下游先
//    退」不成立:tail 当场把前几 KB 写进管子,head 打一行就把管子关掉;
//  · 而 `while true; do :; done | head -n 1` 一个字都不写、`head` 一直等,那一条真的挂住。
// 第 2 轮审查又把判据本身掀了一层:**光看「剥掉开关后剩几个操作数」不够**,得按**参数角色**读
// —— `grep -e one reader.log` 的模式已经由 `-e` 给了,剩下那个操作数是文件,它读完就退、压根不
// 碰管子（实测 7ms、退出 0、参数合法无错误输出）;`tr`/`tr ab`/`cut`/`sort -t xx`/`nl -w nope`/
// `grep '['` 则是在**读管子之前**就打一句用法或参数错误退出。
{
  for (const command of [
    "while true; do printf 'DONE\n'; done | head -n 1",
    "tail -f /var/log/app.log | head -n 1",                  // 跟随型同判（第 1 轮审查实测那一条）
    "tail -F build.log | grep -m1 READY",                    // 「够了就走」的开关不在白名单里
    "tail -F build.log | grep -q READY",
    "tail -F build.log | grep -l ERROR",
    "tail -F build.log | grep ERROR file.txt",               // 给了文件操作数 ⇒ 根本不读管子
    "tail -F build.log | timeout 5 grep ERROR",              // 自带死线 ⇒ 到点把管子关掉
    "tail -F build.log | sed -u 's/a/b/'",                   // 认不出来的下游一律算「可能先走」
    "tail -F build.log | ./my-filter.sh",
    "{ while true; do printf x; done; } | head -n 1",        // 整组被管道接走同判
    "( while true; do printf x; done ) | head -n 1",
    "while true; do printf x; done | head -n 1 | cat",       // 多级:任一级可能先走就够
    "while true; do printf x; done | cat | head -n 1",
    // ── 第 2 轮审查 F1 实测的那七条:全在读管子之前就退出 0 ──────────────────────────
    "while true; do printf x; done | grep -e one reader.log", // `-e` 给过模式 ⇒ 操作数是文件
    "tail -F build.log | grep --regexp=one reader.log",       // 长写法同理
    "tail -F build.log | grep -f patterns.txt",               // 模式写在文件里 ⇒ 全读不出来
    "while true; do printf x; done | grep '['",               // 模式编译失败 ⇒ 报错就退
    "tail -F build.log | grep -E 'a|b'",                      // 带结构的模式一律不算证明
    "while true; do printf x; done | tr",                     // 字符集一个都没给 ⇒ 用法错误
    "while true; do printf x; done | tr ab",                  // 少给一个 ⇒ 同上
    "tail -F build.log | tr -s a",                            // `-s` 一个两个都合法 ⇒ 数不出来
    "tail -F build.log | tr '[:bogus:]' x",                   // 非法字符集 ⇒ 报错就退
    "while true; do printf x; done | cut",                    // 没给 `-b/-c/-f` ⇒ 用法错误
    "while true; do printf x; done | sort -t xx",             // 分隔符要单字符 ⇒ 参数错误
    "tail -F build.log | sort -k2",                           // `-k` 的字段语法这一层判不了
    "while true; do printf x; done | nl -w nope",             // 宽度要数字 ⇒ 参数错误
    "tail -F build.log | tee out.log",                        // 写不进那个文件就报错
    "tail -F build.log | cat x.log",                          // 给了文件 ⇒ 不读管子
    "tail -F build.log | wc -l x.log",
  ]) passes(command, "下游会不会一直读到头，这一层读不出来");
  for (const [command, hit] of [
    ["while true; do printf 'x\n'; done", "while true / until false"],
    ["printf 'x\n' | while true; do :; done", "while true / until false"],   // 循环在最后一级
    ["while true; do printf x; done 2>/dev/null", "while true / until false"], // 重定向不是管道
    ["while true; do printf x; done | grep ERROR", "while true / until false"],
    // 事故的起因命令落在这一档:`grep` 不带那几个「够了就走」的开关、模式纯字面、没有文件
    // 操作数 ⇒ 读到 EOF 才退。**这一条是闸的牙**,两轮重写都没把它放掉。
    ["tail -F build.log 2>/dev/null | grep --line-buffered ERROR", "tail -f/-F"],
    ["tail -F build.log | grep -e ERROR", "tail -f/-F"],                       // `-e` 给模式、无文件
    ["tail -F build.log | grep -i -A3 ERROR", "tail -f/-F"],                   // 带值开关值形状对得上
    ["tail -F build.log | tee", "tail -f/-F"],                                 // 不带文件 ⇒ 只写 stdout
    ["tail -F build.log | wc -l", "tail -f/-F"],
    ["tail -F build.log | cut -d: -f1", "tail -f/-F"],
    ["tail -F build.log | tr -d abc", "tail -f/-F"],                           // `-d` 要一个集合,给齐了
    ["tail -F build.log | tr abc xyz", "tail -f/-F"],                          // 默认要两个,给齐了
    ["tail -F build.log | sort | uniq -c", "tail -f/-F"],                      // 多级都证明得出
    ["tail -F build.log | stdbuf -oL grep ERROR", "tail -f/-F"],               // 包装层剥掉还是 grep
  ] as const) blocks(command, hit, "下游证明得出读到 EOF 才退 ⇒ 上游那个判定站得住");
  console.log("✓ 硬拦资格：下游按参数角色判「会不会一直读到头」，判不出来的一律降级");
}
// ── ⑤ 判定压着的那个前提:它要盯的那个东西**执行到那一步时**还在不在（第 2 轮审查 F1）────
// 上一版把这个前提交出去（`assumesAnyExists`）、让创建闸拿 `existsSync` 核一遍,**那条路被证伪
// 了**:它读得到的是「创建这一刻在不在」,判定要的是「执行到那一句时在不在」,中间隔着这条命令
// 前面的每一段 —— `rm ./doomed.log; tail -f doomed.log; printf 'DONE\n'` 实测 9ms 退出 0,却被
// 409。拿「这个路径词出现过几次」去补那个缝也不行:`./doomed.log` 与 `doomed.log` 是同一个文件、
// 不是同一个词,那是在穷举拼写。所以**这一整档移出硬拦**,一律只配做提示。
{
  for (const [command, why] of [
    ["tail -f build.log", "本地路径也一样:核得到的是此刻，要的是执行到那一句时"],
    ["tail -f 'build.log'", "引号不改变这件事"],
    ["tail -f -- build.log", "`--` 之后同理"],
    ["tail -f a.log b.log", "多个操作数同理"],
    ["tail -f /abs/build.log", "绝对路径同理 —— 时刻不对，不是路径写法不对"],
    ["cd sub; tail -f /abs/build.log", "换没换目录都不改变「时刻不对」这件事"],
    ["rm ./doomed.log; tail -f doomed.log", "第 2 轮审查实测:创建时在、跑到那句时已经没了"],
    ["inotifywait -m /tmp/a /tmp/b", "要盯的目录同理"],
    ["fswatch /tmp/a", "同上"],
    ["tail -f $LOG", "路径这一层就读不出来"],
    ['tail -f "$LOG"', "引号里照样读不出来"],
    ["tail -f *.log", "通配读不出来"],
    ["tail -f ~/x.log", "`~` 由 shell 展开"],
    ["cd sub; tail -f really-here.log; printf 'DONE\n'", "第 1 轮审查实测退出 0"],
    ["kubectl logs -f pod-1", "远端那个 pod 在不在，谁都核不了"],
    ["docker logs -f web", "远端那个容器同理"],
    ["podman logs -f web", "同上"],
  ] as const) passes(command, `压着一个没人核得了的前提 ⇒ 只配做提示（${why}）`);
  // **闸剩下的牙在「一个前提都不压」的那一档** —— 少了这一组,上面那一整节等于把闸拆了。
  for (const command of [
    "tail -F build.log",                                   // 没了也一直重试 ⇒ 不要这个前提
    "tail -f --retry build.log",
    "tail -f --follow=name build.log",
    "journalctl -f",                                       // 盯的是日志本身
    "watch date",                                          // 盯的是一条命令,失败也照旧重来
    "while true; do :; done",
    "until false; do :; done",
  ]) {
    assert.equal(
      neverExitsVerdict(command)?.unprovable ?? null, null,
      `这一条一个前提都不压，不许凭空长出一个来把闸放掉：${command}`,
    );
  }
  console.log("✓ 硬拦资格：要盯的那个东西在不在一律只配做提示；一个前提都不压的那一档照旧硬拦");
}
// ── ⑤b 那句提示要**指到是哪一环核不了** ───────────────────────────────────────────────
// 一句泛泛的「可能不会结束」等于没说:人得据此判断要不要现在就补一个结束条件。
{
  for (const [command, note] of [
    ["tail -f build.log", /build\.log/],
    ["tail -f $LOG", /\$LOG/],
    ["cd sub; tail -f rel.log", /rel\.log/],
    ["kubectl logs -f pod-1", /pod/],
    ["docker logs -f web", /容器/],
    ["inotifywait -m /tmp", /\/tmp/],
    ["tail -F x | head -n 1", /下游/],
    ["tail -F x | grep -e one reader.log", /下游/],
    ["while true; do printf x; done | tr", /下游/],
  ] as const) {
    assert.match(
      neverExitsVerdict(command)?.unprovable ?? "",
      note, `那句提示要指到核不了的那一环：${command}`,
    );
  }
  // 它要么是一句话、要么压根没有 —— 不许是空串（界面拿它当文案,空串会渲染成一句残句）。
  for (const command of ["tail -f build.log", "kubectl logs -f p", "tail -F x | head -n 1"]) {
    assert.ok(
      (neverExitsVerdict(command)?.unprovable ?? "").length > 8,
      `提示不许是空串或一个字：${command}`,
    );
  }
  console.log("✓ 硬拦资格：提示里指明是哪一环核不了，而且不是空串");
}
// ── ⑤c 执行环境这个前提:命令自己就能把它掀翻（第 1 轮审查 F1）─────────────────────────
// 硬拦的证明压着一个一直没说出口的前提:shell 按常规语义执行每一段、那个工具启动得起来、没人
// 把这个进程结束掉。那个前提**不是待证项** —— 否则磁盘满、外部信号、ulimit 都能让任何命令退
// 出,闸直接归零。可**命令自己**就能把它掀翻,而那几种写法全写在 argv 里、这一层本来就看得见。
//
// 这一节钉的是**资格**而不是一张反例表（审查明确点掉了「分别添加 eval、kill、set 的字符串特
// 判」那条路:补一条它就再长出第四种）。所以主体是一组**对照**:同一条铁定该拦的命令,逐类把
// 那个前提掀翻,每一类都必须把硬拦取消 —— 验的是「未知能往上取消硬拦」这个机制本身。
{
  // 本轮审查实测的四条（真 shell 下分别退出 0 / 0 / SIGTERM / 127，对账见 ⑧）。
  for (const [command, why] of [
    ["while true; do eval 'break'; done; printf 'DONE\\n'", "`break` 在引号里，词表扫不进 eval 的字符串"],
    ["set -n; while true; do :; done", "`-n` 是「读完一条都不执行」，这一层只登记过 `set -e`"],
    ["while true; do kill -TERM $$; done", "能终止这个 shell 的不只有 break/exit/return 三个词"],
    ["PATH=/definitely-missing-ash-review; tail -F /dev/null", "跟随型的「不退出」压着「那个工具找得到」"],
  ] as const) passes(command, `执行语义这一层读不懂 ⇒ 只配做提示（${why}）`);

  // **机制**:一条铁定该拦的命令（事故的起因命令本体）,逐类掀翻那个前提。
  const BASE = "tail -F build.log 2>/dev/null | grep --line-buffered ERROR";
  assert.equal(
    neverExitsVerdict(BASE)?.unprovable ?? null, null,
    "这一节的台子前提:基线那一条本来就该硬拦，不然下面每一条都验不出东西",
  );
  for (const [command, which] of [
    [`eval 'printf x'; ${BASE}`, "另开一层这边读不进去的执行"],
    [`source ./env.sh; ${BASE}`, "把另一个文件的内容当代码跑"],
    [`trap 'exit 0' ALRM; ${BASE}`, "挂一段收到信号才跑的代码"],
    [`ulimit -t 1; ${BASE}`, "改掉这条命令自己的资源上限"],
    [`set -n; ${BASE}`, "改掉后面每一条的执行语义"],
    [`shopt -s extglob; ${BASE}`, "改掉 shell 的执行选项"],
    [`PATH=/nope; ${BASE}`, "动过工具查找路径"],
    [`${BASE}; kill -TERM $$`, "能把这条命令自己结束掉 —— 哪一段里出现都算"],
    [`if false; then eval x; fi; ${BASE}`, "连「它跑不到」这个结论都得先读懂 eval ⇒ 偏放行那一侧"],
  ] as const) {
    const note = neverExitsVerdict(command)?.unprovable ?? null;
    assert.notEqual(note, null, `这一类掀翻了执行环境那个前提，不许再硬拦（${which}）：${command}`);
    assert.ok((note ?? "").length > 8, `那句提示要说清是哪一处读不懂（${which}）：${command}`);
  }

  // **口径是命令词位置,不是搜文本**（见判据文件头 ①）:同一个词出现在**参数位**上什么都不改
  // —— 这一组要是跟着放行,闸就被一条 `grep kill` 顺手拆了。
  for (const command of [
    "tail -F x.log | grep kill",                 // `kill` 是 grep 的模式
    "tail -F x.log | grep -e eval",              // 同上
    "tail -F set",                               // `set` 是 tail 的操作数
    "find . -name '*.log' | xargs tail -F; tail -F y.log",   // `.` 是 find 的操作数
    "while true; do printf 'PATH=1\\n'; done",     // 引号里的字永远不是执行节点
  ]) {
    assert.equal(
      neverExitsVerdict(command)?.unprovable ?? null, null,
      `这几个词都在参数位上，执行语义一点没变，不许凭它把闸放掉：${command}`,
    );
  }
  console.log("✓ 硬拦资格：命令自己掀翻执行环境那个前提时，硬拦一律降级；参数位上的同名词不算");
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
    FOLLOWERS, /function parseIfUnderstood\(/,
    "认 argv 那一趟必须同时交出**真正的操作数和开关**（见该文件头 ③⑥）",
  );
  assert.match(
    FOLLOWERS, /f\.follows\(argv, parsed\.operands\)/,
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
  // **路径前提不许再交给别人去 `stat`**（第 2 轮审查 F1）:那一档没了,`tail -f FILE` 跟远端那
  // 几个走同一条路 —— 交出一句「没人核得了」。留着旧出口就等于留着那次误拦。
  assert.doesNotMatch(
    FOLLOWERS, /needsExisting/,
    "「交出路径让创建闸去 stat」这条路已被实测证伪（时刻不对），不许回来（见该文件头 ④）",
  );
  assert.doesNotMatch(
    // 只认**调用**（`existsSync(`）:注释里提这个名字不算 —— 它恰恰该写在注释里说明为什么不用。
    CREATE, /existsSync\(/,
    "创建闸不许再自己核文件系统:它读得到的是创建这一刻,判定要的是执行到那一句时（第 2 轮审查 F1）",
  );
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
    JUDGE, /readsToEof\(next\.name, next\.argv\)/,
    "有下游时必须问一句「它会不会一直读到头」—— 按工具名分两套的那版已被实测推翻（见该文件头 ⑨）",
  );
  assert.match(
    FOLLOWERS, /export function readsToEof\(/,
    "「下游读到头型」是一张**目录**:认不出来的下游要算「可能先走」（见该文件头 ⑤）",
  );
  assert.match(
    JUDGE, /provableBlocker\(scanOf\(segs\)\)/,
    "判据这一层不许再按「哪个路径 + 谁动过它」做拼写分析:那是穷举拼写（见该文件头 ⑩）",
  );
  // **执行环境那个前提必须由命令自己能推翻**（第 1 轮审查 F1）。这三条锁的是机制的形状:一张
  // 目录（不是散落的 if）、接在判定之后、而且**只改硬拦那一档**（已经降级的那一句更具体）。
  assert.match(
    JUDGE, /const SHAKERS = new Map/,
    "掀翻执行环境的那几种写法是一张**目录**:散落成 if 就会变成「每轮审查补一条」（见该文件头 ⑪）",
  );
  assert.match(
    JUDGE, /const shaken = perturbed\(segs\)/,
    "判定走完还要过一道「这条命令的执行语义我还读得懂吗」（见该文件头 ⑪）",
  );
  assert.match(
    JUDGE, /if \(!found \|\| found\.unprovable\) return found/,
    "扰动只改硬拦那一档:压根没判定 ⇒ 没什么可提示的，已经降级 ⇒ 它自己那句话更具体（见该文件头 ⑪）",
  );
  assert.match(
    JUDGE, /const SET_HANDLED = new Set/,
    "`set` 的开关走**白名单**:列「哪几个危险」就是列反例，一张黑名单永远差下一个（见该文件头 ⑪）",
  );
  assert.match(
    FOLLOWERS, /assumesOpaque/,
    "压着前提的跟随型必须把那句话交出来，而不是装作没有前提（见该文件头 ④⑤）",
  );
  assert.match(
    CREATE, /forever\?\.unprovable/,
    "核不了的那一种在创建闸只提示、不 409（见该文件的 `advice`）",
  );
  // 下游那张表必须按**角色**读,不许退回只数操作数个数（第 2 轮审查 F1）。
  assert.match(
    FOLLOWERS, /const given = p\.switches\.filter/,
    "grep 的模式从哪来决定了操作数是不是文件:只数个数的那版已被实测推翻（见该文件头 ⑥）",
  );
  assert.match(
    FOLLOWERS, /STRUCTURED_PATTERN/,
    "带结构的模式可能编译失败、读之前就退 ⇒ 不算证明（见该文件头 ⑥）",
  );
  console.log("✓ 硬拦资格：七道判据的形状受结构锁保护");
}
// ── ⑦ 真实创建入口:降级之后这几条命令**真的能建**（第 1 轮审查 F1 的现场）───────────
// 判据只是个函数,用户那一侧感受到的是 409。这一节走真实创建路由确认那几条命令现在建得出来,
// 而事故的起因命令照旧拦 —— 不然「降级」很容易变成「把闸整个拆了」。
{
  const taskId = await makeTask();
  // 这一节和 ⑧ 的工作目录都是 `root`（台子给的 cwd）。`sub/` 里**故意没有**那个日志:
  // `cd sub; tail -f really-here.log` 正是靠这一点立刻退出的（新一轮审查 F1）。
  writeFileSync(join(root, "really-here.log"), "x\n");
  writeFileSync(join(root, "doomed.log"), "x\n");
  writeFileSync(join(root, "doomed2.log"), "x\n");       // `rm ./doomed2.log` 那一条会真的删掉它
  writeFileSync(join(root, "reader.log"), "one\n");      // `grep -e one reader.log` 读的那个有限文件
  mkdirSync(join(root, "sub"), { recursive: true });
  // 350KB:`tail -f -n +1 large.log | head -n 1` 要靠「一开口就写满管子」才会吃上 SIGPIPE。
  writeFileSync(join(root, "large.log"), `${"x".repeat(80)}\n`.repeat(4400));
  for (const command of [
    "printf 'DONE\\n' | tail -f",
    "printf 'DONE\\n' | tail -F",
    "set -e; false; tail -F /dev/null",
    // 新一轮审查 F1 实测的那三条（真 shell 里分别退出 0 / 1 / 0）。
    "while true; do printf 'DONE\\n'; done | head -n 1",
    "set -e; while true; do false; done",
    `tail -f ${join(root, "definitely-missing-ash-review")}; printf 'DONE\\n'`,
    "tail -f definitely-missing-ash-review",               // 相对路径按这条哨兵的工作目录解析
    // 新一轮审查 F1 实测的那几条:前提谁都核不了 ⇒ 只配做提示（见 ⑤b）。
    "tail -f $LOG",
    "tail -f *.log",
    "cd sub; tail -f really-here.log; printf 'DONE\\n'",      // 换过目录 ⇒ 核的不是它要打开的那个
    // 同一条命令里别的段动过它。**用一个专门的文件**:这一条会真的跑起来,拿 `really-here.log`
    // 去演等于把下面那几条 409 用例的前提删掉（初版就踩了这一脚，闸没拆也会报假阳）。
    "rm -f doomed.log; tail -f doomed.log",
    "kubectl logs -f pod-1",                               // 远端那个 pod 在不在,谁都核不了
    "tail -f -n +1 large.log | head -n 1",                 // 下游可能先把管子关掉
    // ── 第 2 轮审查 F1 实测的八条:真 shell 里全部退出 0,而上一版全部 409 ────────────
    // 路径那一档:**指着一个真在的文件也一样**放行 —— 核得到的是创建这一刻,判定要的是执行
    // 到那一句时（`rm ./doomed.log` 那条就活在这两个时刻的缝里,拼写上还换了个 `./`）。
    "tail -f really-here.log",
    `tail -f ${join(root, "really-here.log")}`,
    "rm -f ./doomed2.log; tail -f doomed2.log; printf 'DONE\\n'",
    // 下游那一档:读管子之前就退出的那几种。
    "while true; do printf x; done | grep -e one reader.log",
    "while true; do printf x; done | tr",
    "while true; do printf x; done | tr ab",
    "while true; do printf x; done | cut",
    "while true; do printf x; done | sort -t xx",
    "while true; do printf x; done | nl -w nope",
    "while true; do printf x; done | grep '['",
  ]) {
    const made = await startMonitor({ taskId, command, description: "会自己结束的命令", timeoutMs: 4000 });
    assert.equal(made.ok, true, made.ok ? "" : `这条命令会自己结束,不许拦：${command} / ${made.error}`);
    if (made.ok) await stopMonitor(made.monitor.id, "硬拦资格那一节跑完了");
  }
  // **放行不等于沉默**:核不了的那一环要随这次创建一起说出来（`endConditionAdvice`）——
  // 不然 `tail -f $LOG` 这种十有八九真会一直跟下去的命令又变回「挂上去白等 30 分钟」。
  {
    const made = await startMonitor({ taskId, command: "tail -f $LOG", description: "提示要回出来" });
    assert.equal(made.ok, true, made.ok ? "" : made.error);
    if (made.ok) {
      assert.match(made.notice ?? "", /可能.*永远不会结束/, "核不了的那一种要回一句提示");
      assert.match(made.notice ?? "", /读不出来/, "提示里要指明核不了的是哪一环");
      assert.match(made.notice ?? "", /stopWhen|untilExpiry/, "提示要给得出出路");
      await stopMonitor(made.monitor.id, "硬拦资格那一节跑完了");
    }
  }
  // **一个前提都不压**的那一档照旧 409 —— 闸剩下的牙全在这里,少了这一组上面那一整节就是
  // 「把闸拆了」。判据是「这边自己证明得出」,不是「那个文件在不在」（后者没人核得了）。
  for (const [command, why] of [
    ["tail -F definitely-missing-ash-review", "`-F` 没了也一直重试 ⇒ 不压前提"],
    ["tail -F really-here.log", "`-F` 指着真在的文件也一样 ⇒ 不压前提"],
    ["while true; do :; done", "恒真循环什么都不要"],
    ["until false; do :; done", "同上"],
    ["journalctl -f", "盯的是日志本身"],
    ["tail -F build.log 2>/dev/null | grep --line-buffered ERROR", "事故的起因命令"],
    ["tail -F really-here.log | wc -l", "下游证明得出读到头才退"],
    ["tail -F really-here.log | grep -e ERROR", "`-e` 给模式、没有文件操作数 ⇒ 读到头"],
    ["tail -F really-here.log | tr -d abc", "`-d` 要一个集合,给齐了 ⇒ 不会用法错误"],
    ["while true; do printf x; done | grep ERROR", "真 shell 实测挂住"],
  ] as const) {
    const denied = await startMonitor({ taskId, command, description: why });
    assert.equal(denied.ok, false, `${why}，照旧要拦:判据降级不是把闸拆了 —— ${command}`);
    assert.equal(denied.ok ? 0 : denied.status, 409, `${why}：${command}`);
  }
  console.log("✓ 硬拦资格：压着前提的那几条真的建得出来（还带着提示），一个前提都不压的照旧 409");
}
// ── ⑧ 真 shell 对账:判据说的那件事,交给 shell 量一遍（新一轮审查 F1 的根因）───────────
// 前七节量的都是「判据怎么答」,而连着两轮审查点中的是同一件事:**判据跟真实退出语义脱节**,
// 并且每次都是「预期表里又抄了一条字符串」漏出来的 —— golden 全绿和缺陷同时成立,所以「全绿」
// 本身证不了资格。这一节不信判据也不信我:把命令**真的交给用户那把 shell 跑一遍**（起壳走的是
// 产品同一个 `userShellLaunch`）,按它到底退不退出来定预期。
//
// 只有一个方向是不变量:**真 shell 里它自己退了 ⇒ 不许硬拦**。反方向不是 —— 挂住了也允许放行
// （漏判 = 今天的行为;硬拦错了是把能做的事变成做不成,代价对不上,见判据文件头）。所以下面
// 「照旧该拦」的那几条是我们**选定要留**的真阳性,不是从「它挂住了」推出来的;明写的漏判也单
// 列一组钉住,免得哪天有人把它当缺陷顺手「修」成硬拦。
if (IS_WINDOWS) {
  console.log("✓ 硬拦资格：真 shell 对账这一节只在 POSIX 壳上跑（这批命令语料是 sh 的）");
} else {
  /**
   * 把命令真的跑一遍：`ms` 毫秒内自己退出了就是 `true`。这几条要么几毫秒就退、要么永远不退，
   * 所以窗口给得紧；判错也不会悄悄过去 —— 下面每一组都先断言自己的前提。
   *
   * 超时就把**整组**杀掉，这一节自己造的进程自己收（`detached` 让子进程当组长，于是
   * `kill(-pid)` 连管道里那几个成员一起收）。
   */
  const shellExits = (command: string, ms = 1500): Promise<boolean> => {
    const launch = userShellLaunch(command);
    return new Promise((resolve) => {
      // **工作目录跟这些哨兵真实的那个一样**（台子给的 `root`）:相对路径、`cd sub` 那几条的
      // 退出语义全靠它 —— 探针换个目录跑就不是同一件事了。
      const child = spawn(launch.file, launch.args, { cwd: root, detached: true, stdio: "ignore" });
      const reap = () => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* 已经没了 */ }
      };
      const timer = setTimeout(() => { reap(); resolve(false); }, ms);
      child.on("exit", () => { clearTimeout(timer); reap(); resolve(true); });
      // 起不起来另说（壳都没跑成），反正不是「它挂在那儿」。
      child.on("error", () => { clearTimeout(timer); resolve(true); });
    });
  };
  const measured = async (command: string, exits: boolean) =>
    assert.equal(
      await shellExits(command), exits,
      `这一组的前提:它该在真 shell 里${exits ? "自己退出" : "挂住"} —— ${command}`,
    );

  const taskId = await makeTask();
  const missing = join(root, "definitely-missing-ash-review");
  // 这一节的 `rm` 用例**真的会删文件**,而每条命令要跑两趟(真 shell 一趟、创建闸一趟)——
  // 所以每趟之前重建一次,不然第二趟核的就不是同一个初始状态（审查那份探针也是这么做的）。
  const reseed = (): void => {
    for (const name of ["doomed3.log", "doomed4.log", "really-here.log", "reader.log"]) {
      if (!existsSync(join(root, name))) writeFileSync(join(root, name), name === "reader.log" ? "one\n" : "x\n");
    }
  };

  // 真 shell 里自己退出 ⇒ 创建闸必须放行。
  for (const command of [
    "while true; do printf 'DONE\\n'; done | head -n 1",
    "set -e; while true; do false; done",
    `tail -f ${missing}; printf 'DONE\\n'`,
    "printf 'DONE\\n' | tail -f",
    "set -e; false; tail -F /dev/null",
    // 第 1 轮审查 F1 实测的两条:换过工作目录、以及下游先把管子关掉。
    "cd sub; tail -f really-here.log; printf 'DONE\\n'",
    "tail -f -n +1 large.log | head -n 1",
    // ── 第 2 轮审查 F1 实测的八条。前三条是**路径那一档**:指着一个真在的文件、被前一段删掉
    //    的、以及换了个 `./` 拼写的 —— 它们证的是同一件事:**创建那一刻的文件系统不是判据**。
    //    `rm` 那两条每跑一遍都真的删文件,所以各用一个专门的文件(见下面重建那一句)。
    //    「指着一个真在的文件」那一条在真 shell 里是**挂住**的,所以它在下面那组漏判里。
    "rm ./doomed3.log; tail -f doomed3.log; printf 'DONE\\n'",
    "rm doomed4.log; tail -f doomed4.log; printf 'DONE\\n'",
    // 后几条是**下游那一档**:全在读管子之前就退出(参数合法的那条在第一位 —— 它不是拿非法
    // 命令代替正常行为,`grep -e one reader.log` 打出 one 和 DONE、退出 0、stderr 为空)。
    "while true; do printf x; done | grep -e one reader.log; printf 'DONE\\n'",
    "while true; do printf x; done | tr; printf 'DONE\\n'",
    "while true; do printf x; done | tr ab; printf 'DONE\\n'",
    "while true; do printf x; done | cut; printf 'DONE\\n'",
    "while true; do printf x; done | sort -t xx; printf 'DONE\\n'",
    "while true; do printf x; done | nl -w nope; printf 'DONE\\n'",
    "while true; do printf x; done | grep '['; printf 'DONE\\n'",
    // ── 本轮审查 F1 实测的四条:**执行环境那个前提被命令自己掀翻**。前三条退出 0/0/SIGTERM,
    //    第四条 127（`sh: tail: command not found`）。`kill -TERM $$` 只打到这一趟自己起的那
    //    个壳（`spawn` 带 `detached`，它就是组长），不向外发信号;`PATH=` 只改这个子壳的环境。
    "while true; do eval 'break'; done; printf 'DONE\\n'",
    "set -n; while true; do :; done",
    "while true; do kill -TERM $$; done",
    "PATH=/definitely-missing-ash-review; tail -F /dev/null",
  ]) {
    reseed();
    await measured(command, true);
    reseed();
    const made = await startMonitor({ taskId, command, description: "真 shell 里自己退了", timeoutMs: 4000 });
    assert.equal(made.ok, true, made.ok ? "" : `真 shell 实测它自己退了,不许硬拦：${command} / ${made.error}`);
    if (made.ok) await stopMonitor(made.monitor.id, "真 shell 对账那一节跑完了");
  }

  // 真 shell 里挂住、而且我们**选定要拦**的那几条:降级不许把这几条一起放掉。
  for (const command of [
    "tail -F /dev/null",
    "while true; do :; done",
    `tail -F ${join(root, "really-here.log")}`,              // `-F`:不压那个前提
    "tail -F build-nope.log 2>/dev/null | grep --line-buffered ERROR",
    // 下游证明得出读到 EOF 才退 ⇒ 整条真的挂住（这几条都是本轮重写之后仍然咬住的）。
    "while true; do printf x; done | grep ERROR",
    "while true; do printf x; done | grep -e ERROR",
    "while true; do printf x; done | tr -d abc",
    "while true; do printf x; done | tr abc xyz",
    "while true; do printf x; done | cut -f1",
  ]) {
    reseed();
    await measured(command, false);
    const denied = await startMonitor({ taskId, command, description: "真 shell 里挂住了" });
    assert.equal(denied.ok, false, `这一条是选定要留的真阳性,不许放行：${command}`);
    assert.equal(denied.ok ? 0 : denied.status, 409, command);
  }

  // **明写的漏判**:恒真循环一旦有下游,「有人一直在读我的 stdout」这条前提就没了（下游先退
  // 出它当场收 SIGPIPE）—— 而「下游到底会不会一直读」判据读不出来,于是整条放行。它在真
  // shell 里确实挂住,这里把这件事钉成文档:哪天想收它,得先拿出那份证明,而不是把闸改回去。
  for (const command of [
    "while true; do :; done | head -n 1",
    // **`tail -f` 指着一个此刻真在的文件**:真 shell 里它一直跟着,而判据放行它 —— 因为「执行
    // 到那一句时它还在不在」没有哪一层核得了(第 2 轮审查 F1:上一版让创建闸拿 `existsSync`
    // 去核,而 `rm ./doomed.log; tail -f doomed.log` 就活在「创建这一刻」与「执行那一刻」的缝
    // 里)。于是这一条成了明写的漏判:代价是挂上去白等到期,而赌错的那一边是一件做得成的事
    // 做不成。要收它得先拿出「执行到那一句时文件还在」的证明,而不是把时刻不对的核查装回去。
    "tail -f really-here.log",
  ]) {
    reseed();
    await measured(command, false);
    const made = await startMonitor({ taskId, command, description: "明写的漏判", timeoutMs: 4000 });
    assert.equal(made.ok, true, made.ok ? "" : `这是明写的漏判,不是硬拦：${command} / ${made.error}`);
    if (made.ok) await stopMonitor(made.monitor.id, "真 shell 对账那一节跑完了");
  }
  console.log("✓ 硬拦资格：每条预期都跟真 shell 的退出语义对过账（它自己退了的一律放行）");
}
console.log("✓ 硬拦资格：输入来源 / argv 的出口 / shell 状态 三项任一读不出来就降级 均受回归保护");
await teardown();
