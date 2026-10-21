// 哨兵的**结束条件**（`stopWhen`）这一块的回归:它什么时候算完、谁来保证它一定给得出。
//
// 从 test-monitors.ts 拆出来的（全局约定:单文件不超过 700 行）。台子同一份（见
// monitors-fixture.ts），所以这几节和那边的用例可以互不相干地各自跑。钉住的立论:
//
//  ① 约定的那一行一出现就收工（这是「命令自己永远不会结束」那一类的唯一非到期出路）
//  ② 命令自己不会结束、又没给结束条件 ⇒ **一个字都不许跑**，而且拦下时三条出路给全
//  ③ 判「会不会自己结束」只认**明确**的几种:误判的代价不对称，拦错 = 做得成的事做不成
//  ④ 匹配有计算上界:服务里一条调用方正则都不构造（`^(a+)+$` 能把唯一那条线程卡死）
//  ⑤ 库里存着一条**这一版读不出来**的条件 ⇒ 出声,不静默降级、也不许界面替它背书
//  ⑥ 命中那一行哪怕排在摘要之外,也必须出现在推给 agent 的那条消息里
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  END_CONDITION_HINT, END_CONDITION_SYNTAX,
  endConditionHit, endConditionNote, neverExitsOnItsOwn, parseEndCondition,
} from "@ash/shared/monitor-end-condition";
import { readSource } from "../../scripts/read-source.mjs";
import {
  HERE, root, db, schema, isPidAlive,
  startMonitor, stopMonitor, listMonitors, getMonitor, reattachMonitors, detachAllMonitors,
  until, now, makeTask, pendingOf, teardown,
} from "./monitors-fixture.js";

const { monitors } = schema;

// ── ③c 约定的那一行一出现就收工（用户 2026-10-21 要的「活一结束就唤醒」）────────
// 跟随型命令（`tail -F`、`while true`）自己永远不会结束，于是「命令结束」那条唤醒条件在它
// 身上形同虚设，只剩干等到期。这一节钉住那条非到期出路真的通：命中那一行**照常推给 agent**
// （它多半就是结果本身），哨兵随即落 `matched` 收工，而不是等满时长。
{
  const taskId = await makeTask();
  const feed = join(root, "feed.mjs");
  // 先吐两行无关的，再吐那条约定的行，然后**继续活着**：不这么写的话，进程自己退出也会
  // 让哨兵结束，就分不清是「命中」还是「它自己跑完了」。
  writeFileSync(feed, `console.log("第 1 步");
setTimeout(() => console.log("第 2 步"), 200);
setTimeout(() => console.log("SWEEP_EXIT=0 全跑完了"), 500);
setInterval(() => {}, 1000);
`);
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
    description: "盯到收尾行为止",
    stopWhen: "SWEEP_EXIT=",
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  const monitorId = started.ok ? started.monitor.id : "";
  const pid = started.ok ? started.monitor.pid! : 0;
  assert.equal(started.ok ? started.monitor.stopWhen : null, "SWEEP_EXIT=", "结束条件要带回给调用方");

  await until("命中之后落 matched", async () => (await getMonitor(monitorId))?.status === "matched");
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.match(row.endedReason ?? "", /等到了约定的那一行/, "结束原因要说清是等到了，不是被谁停的");
  assert.match(row.endedReason ?? "", /SWEEP_EXIT=0/, "把命中的那一行带上，省得还要去翻日志");
  // **命中那一行本身必须送到**：收工不能把结果一起吞掉——它正是 agent 要的东西。
  const [queued] = await pendingOf(taskId);
  assert.ok(queued, "命中之后要留一条消息给 agent");
  assert.ok(queued!.text.includes("SWEEP_EXIT=0 全跑完了"), `命中的那一行要推给 agent：${queued!.text}`);
  assert.ok(queued!.text.includes("【哨兵结束】"), "收尾通知紧跟在后面");
  await until("进程真的被收掉", async () => !isPidAlive(pid));
  console.log("✓ 命中约定的那一行：那一行照常送达、哨兵当场收工、进程被收掉");
}
// ── ⑦b 结束条件的**闸**：命令自己不会结束、又没给结束条件 ⇒ 一个字都不许跑 ────────
// 用户 2026-10-21 问的是「你能保证 agent 一定会加吗」——不能，所以不靠自觉靠闸。判据在
// shared（前端表单用的是同一份），三条出路各验一次：改写命令 / 给 stopWhen / 明说盯到到期。
{
  // 判据本身：误判的代价不对称（拦错 = 本来做得成的事做不成），所以只认明确的那几种。
  for (const [command, hit] of [
    ["tail -F build.log | grep --line-buffered ERROR", "tail -f/-F"],
    ["tail -f x.log", "tail -f/-F"],
    ["while true; do sleep 5; done", "while true / until false"],
    ["watch -n 5 ls", "watch"],
    ["inotifywait -m /tmp", "inotifywait -m"],
    // ↓ 第 1 轮审查 F3 实测的漏判，判据改成按结构看之后才认得出来
    ["tail -n 0 -F /dev/null", "tail -f/-F"],            // 开关不紧跟在命令词后面
    ["timeout 1 true; tail -F /tmp/x", "tail -f/-F"],    // 前一条的死线不传染给后一条
    ["stdbuf -oL tail -F build.log", "tail -f/-F"],      // 包一层的词是透明的
    ["/usr/bin/tail --follow=name build.log", "tail -f/-F"], // 带路径、长开关带值
    ["docker logs -f app", "docker logs -f"],
    // 引号里那个 `exit` 不是出路:这条循环真的永远不结束
    ["while true; do echo 'waiting for exit'; sleep 5; done", "while true / until false"],
    // ↓ 第 3 轮审查 F3 之后判据倒过来写（先证明会跑、再问会不会结束），这几条是**赚回来**的:
    //   上一版「条件分支在场 ⇒ 跟随型那一扫整个不做」把它们一起放过了
    ["if false; then :; fi; tail -F x", "tail -f/-F"],            // 分支之后那一条照跑
    ["while true; do tail -F x; break; done", "tail -f/-F"],      // 恒真循环第一圈就挂在它上
    ["for f in a b; do tail -F $f; done", "tail -f/-F"],          // 列表非空 ⇒ 循环体一定跑
    ["exec tail -F x", "tail -f/-F"],                             // 本进程被换成了那个 tail
    ["( tail -F x )", "tail -f/-F"],                              // 子 shell 里的照跑
    ["tail -F x && printf done", "tail -f/-F"],                   // 它自己是这条链的第一个
    ["while :; do sleep 0.2; done", "while true / until false"],  // `while :` 跟 `while true` 同档
    ["true; { tail -F x; }", "tail -f/-F"],                       // 花括号组里的照跑
    // 整组放后台的那一条作废,**组外**这一条照旧拦（判据是收尾这一组的那个符号）
    [": tok; ( while :; do sleep 0.2; done ) & while :; do sleep 0.2; done", "while true / until false"],
  ] as const) assert.equal(neverExitsOnItsOwn(command), hit, `该判成不会自退：${command}`);
  for (const command of [
    "npm test",
    "timeout 600 tail -F build.log", // 自带死线
    "until grep -q DONE log; do sleep 5; done; tail -4 log", // 条件满足就跳出
    "while true; do grep -q DONE log && break; sleep 5; done", // 循环体里有 break
    "tail -20 build.log",
    // ↓ 第 1 轮审查 F3 实测的**误判**:这几条都会自己结束,拦下来等于把做得成的事拦死
    "printf '%s\\n' 'tail -F build.log'",   // 命中的是 printf 的参数
    "grep -rn 'tail -f' src",                // 同上:引号里的字不是执行节点
    "echo \"while true; do :; done\"",        // 同上:引号里的循环没人跑
    "timeout 5 tail -F build.log",           // 死线在同一条简单命令上
    "docker logs app",                       // 没有 -f
    "fswatch -1 ./build",                    // 等第一次事件就退
    // ↓ 第 2 轮审查 F3 实测的**误判**:全部 `/bin/sh` 退出 0,全部被 409 拦掉。共同点是
    //   「切出来的简单命令」里混着不是执行节点的东西 —— 拦的凭据必须是「这一条真的会跑」。
    "cat <<'EOF'\ntail -F build.log\nEOF\nprintf done\n",  // here-doc 的文档体是数据
    "printf done # ; tail -F build.log",                   // `#` 之后到行尾一个字都不跑
    "later() { tail -F /dev/null; }; printf done",         // 函数体定义时不执行
    "if false; then tail -F /dev/null; fi; printf done",   // 走不到的那一支
    "printf 'one\\n' > ./-f; tail -- -f",                   // `--` 之后那个 -f 是文件名
    "tail -- -f -F x",                                     // 同上:两个都是文件名
    "# while true; do :; done\nprintf done",               // 注释里的循环没人跑
    // ↓ 第 3 轮审查 F3 实测的**误判**:三条都在 `/bin/sh` 退出 0（第三条还打了 DONE）,而
    //   创建入口一律 409。共同点是「切出来像命令/循环」被当成了「这件事必定会执行」。
    "false && tail -F /dev/null; printf 'DONE\\n'",          // 短路掉的右边
    "exit 0; tail -F /dev/null",                             // 退出之后的那一条
    "if false; then while true; do :; done; fi; printf 'DONE\\n'", // 走不到的分支里的循环
    // ↓ 同类（判据是「证明不出会跑」，不是这三条写法本身）
    "(cmd) && tail -F x",                                    // `&&` 落在子 shell 收尾那一段上
    "tail -F x & printf done",                               // 放后台:shell 不等它,立刻就结束
    "for f in *.log; do tail -F $f; done",                   // 展开可能是空的 ⇒ 循环体未必跑
    "if x; then exit 0; fi; tail -F y",                      // 那一支真跑了的话后面就到不了
    "while read l; do tail -F $l; done < list",              // 条件未知的循环体
    // ↓ 分组:放不放后台要看**收尾这一组**的那个符号,不是组里那个 `;`
    "{ tail -F x; } & printf done",                          // 整组放后台 ⇒ shell 不等它
    ": tok; ( while :; do sleep 0.2; done ) & sleep 0.6; exit 0", // 同上（回归台子里的真命令）
    "false && { tail -F x; }",                               // 组整个挂在短路右边
    "( tail -F x",                                           // 括号没配上对 ⇒ 读不懂就放行
  ]) assert.equal(neverExitsOnItsOwn(command), null, `不许拦：${command}`);
  // 条件分支**不传染**:循环体里有 `if` 不改变「这个循环没有出路」这件事,照旧要拦。
  assert.equal(
    neverExitsOnItsOwn("while true; do if [ -f x ]; then cat x; fi; sleep 5; done"),
    "while true / until false",
    "分支在循环体里不改变「这个循环没有出路」",
  );
  // 关键字只在**命令词位置**才算关键字:按文本数的话这个 `fi` 会让分支区提前收口,于是
  // 区里那条 `tail -F x` 被当成顶层的、照拦。
  assert.equal(
    neverExitsOnItsOwn("if true; then grep -n fi src; tail -F x; fi; printf done"),
    null,
    "`grep -n fi src` 里那个 fi 是参数，不是分支的收尾词",
  );

  const taskId = await makeTask();
  const follower = "tail -F /tmp/ash-never.log | grep --line-buffered ERROR";
  const denied = await startMonitor({ taskId, command: follower, description: "没有结束条件的跟随器" });
  assert.equal(denied.ok, false, "跟随型命令没给结束条件时不许放行");
  if (!denied.ok) {
    assert.equal(denied.status, 409);
    assert.equal(denied.needsEndCondition, true, "这一档要带出去，前端表单据它长出那个选择");
    // 三条出路一条都不能少：少给一条，那一种合法意图就只能去照抄另一种（比如编一个永远
    // 不命中的正则来绕过闸）。
    assert.match(denied.error, /stopWhen/, "出路②");
    assert.match(denied.error, /untilExpiry/, "出路③");
    assert.match(denied.error, /EXIT=/, "出路①要给出可照抄的写法");
  }
  assert.equal((await listMonitors(taskId)).length, 0, "被拦下时一行都不许留，更不许起进程");

  // 用不了的条件 = 一个永远不会命中的条件，等于没设 —— 当场 400，别让它变成另一条干等的哨兵。
  for (const pattern of ["^(OK", "^(a+)+$", "OK|", "OK$FAILED"]) {
    const bad = await startMonitor({ taskId, command: follower, stopWhen: pattern });
    assert.equal(bad.ok, false, `用不了的结束条件要拒：${pattern}`);
    assert.equal(bad.ok ? 0 : bad.status, 400);
    if (!bad.ok) assert.match(bad.error, /不是正则|不在两头|空的/, `拒绝要说清为什么：${pattern}`);
  }

  // 两头的锚点是**合法**的，别跟上面那种混为一谈（`a$|b` = 行尾是 a 或出现 b）。
  const anchored = parseEndCondition("DONE$|^READY");
  assert.equal(anchored.ok, true, "两头的锚点要收");
  assert.deepEqual(anchored.ok ? anchored.cond : null, [
    { needle: "DONE", atStart: false, atEnd: true },
    { needle: "READY", atStart: true, atEnd: false },
  ]);

  // 出路③：明说「就是要盯到到期」就照原样放行。
  const forever = await startMonitor({ taskId, command: follower, description: "盯错误日志", untilExpiry: true });
  assert.equal(forever.ok, true, forever.ok ? "" : forever.error);
  if (forever.ok) {
    assert.equal(forever.monitor.stopWhen, null, "这一种没有结束条件，不许替它编一个");
    await stopMonitor(forever.monitor.id, "闸的用例跑完了");
  }
  // 不是跟随型的命令一个字都不问（闸不许顺手改掉正常路径）。
  const plain = await startMonitor({ taskId, command: "echo hi", description: "普通命令" });
  assert.equal(plain.ok, true, plain.ok ? "" : plain.error);
  if (plain.ok) await stopMonitor(plain.monitor.id, "闸的用例跑完了");
  console.log("✓ 结束条件闸：判据只认明确的几种、拦下时三条出路给全、三条出路各自真的走得通");
}
// ── ⑦c 结束条件的匹配**有计算上界**（第 1 轮审查 F1）────────────────────────────────
// 上一版收 JS 正则源文，`new RegExp` 编过就拿去 `.test`。编过只证明语法对：`^(a+)+$` 配上
// 41 个字符的一行就能回溯到停不下来，而这一笔跑在服务唯一那条线程上 —— 页面、停止按钮、
// 到期收尾一起卡住（审查实测：隔离子进程 2504ms 还没返回，同时安排的 100ms 定时器没执行）。
// 所以这一节钉两样：那种条件根本进不来（上面 ⑦b 已经拒掉），以及**服务里一条调用方正则都
// 不构造** —— 后者是结构锁，不靠「这次跑得挺快」。
{
  const src = readSource(join(HERE, "../../shared/src/monitor-end-condition.ts"));
  assert.doesNotMatch(
    src,
    /^\s*(?:return |const |let )?.*new RegExp\(/m, // 只认语句，注释里提这个名字不算
    "结束条件不许拿调用方给的串去构造正则：编得过不等于跑得完（见该文件头 ①）",
  );
  // 字面量匹配:同一个在正则下会爆炸的输入，这里必须是线性的。给一个很松的预算（50ms），
  // 它要的只是「不是指数级」——真爆炸的那种在这台机器上 2.5 秒都回不来。
  const parsed = parseEndCondition("^DONE|FAILED$|SWEEP_EXIT=");
  assert.equal(parsed.ok, true);
  const cond = parsed.ok ? parsed.cond! : [];
  const nasty = `${"a".repeat(40)}!`;
  const lines = Array.from({ length: 200 }, () => nasty);
  const t0 = Date.now();
  assert.equal(endConditionHit(lines, cond), null, "没命中就是没命中");
  assert.ok(Date.now() - t0 < 50, `匹配必须是线性的，实际 ${Date.now() - t0}ms`);
  // 三种锚点各自的语义（锚点错了会把「行首是」读成「出现过」，那是另一个条件）。
  assert.equal(endConditionHit(["xx DONE"], cond), null, "^DONE 只认行首");
  assert.equal(endConditionHit(["DONE now"], cond), "DONE now", "行首命中");
  assert.equal(endConditionHit(["FAILED xx"], cond), null, "FAILED$ 只认行尾");
  assert.equal(endConditionHit(["went FAILED"], cond), "went FAILED", "行尾命中");
  assert.equal(endConditionHit(["log: SWEEP_EXIT=1 done"], cond), "log: SWEEP_EXIT=1 done", "不带锚点的在任意位置");

  // **行尾那个 `\r` 不是正文**（第 3 轮审查 F2）。CRLF 的日志里每一行末尾都挂着一个回车,
  // 而 `$` / `^…$` 恰恰是按行尾比的 —— 实测:`printf 'READY\n'` ⇒ matched,
  // `printf 'READY\r\n'` ⇒ 事件已经送到、输出窗口里看得见 READY,状态一直 running 到到期。
  const exact = parseEndCondition("^READY$");
  const atEnd = parseEndCondition("DONE$");
  assert.ok(exact.ok && exact.cond && atEnd.ok && atEnd.cond);
  const exactCond = exact.ok ? exact.cond! : [];
  const endCond = atEnd.ok ? atEnd.cond! : [];
  assert.equal(endConditionHit(["READY\r"], exactCond), "READY\r", "CRLF 的整行要命中");
  assert.equal(endConditionHit(["all DONE\r"], endCond), "all DONE\r", "CRLF 的行尾要命中");
  // 回显是**原文那一行**（带着它的回车）:调用方要拿它去跟缓冲里那一行对位（见 `linesBody`）。
  assert.equal(endConditionHit(["READY\r"], exactCond)?.endsWith("\r"), true, "命中回显不许改写原文");
  // 只摘掉换行自己带的那一个回车,不是 `trim()`:正文两头真实的空格是正文。
  assert.equal(endConditionHit(["READY "], exactCond), null, "`trim()` 会把条件语义一起改写掉");
  assert.equal(endConditionHit([" READY"], exactCond), null, "行首那个空格同理");

  // **界面不许替一个读不出来的条件背书**（第 2 轮审查 F2）。库里那个值可能出自上一版语义
  // （正则源文）、跨版本接力、或者手改 —— 运行时对它的处置是「当没有结束条件」，那卡片就
  // 不能照旧念「…就收工」。两边共用 `endConditionNote` 这一份判据。
  assert.equal(endConditionNote("^DONE"), "行首是「DONE」就收工", "读得出来的照常说人话");
  for (const legacy of ["^(READY|FAILED)$", "[0-9]+ failed", "OK|"]) {
    assert.match(
      endConditionNote(legacy),
      /读不出来，不会提前收工/,
      `读不出来的条件不许被说成「就收工」：${legacy}`,
    );
  }
  // 语法这件事只在 shared 说一遍（第 2 轮审查 N1）：元字符是**拒掉**而不是当字面量，
  // 两份措辞（agent 侧 markdown / 人侧纯文本）都必须把这半句说出来。
  for (const copy of [END_CONDITION_SYNTAX, END_CONDITION_HINT]) {
    assert.match(copy, /拒掉/, "元字符会被拒掉这件事不许漏说——它决定用户要不要改写输入");
    assert.match(copy, /DONE/, "要给得出照抄的改法");
  }
  assert.doesNotMatch(
    END_CONDITION_HINT, /\*\*|`/,
    "表单那一份不渲染 markdown，星号和反引号会被原样画出来",
  );

  // **放回缓冲那一步不许展开传参**（第 2 轮审查 F1-B）：`unshift(...lines)` 按参数个数吃栈，
  // 18 万行就是一次 RangeError，而排重试那一句排在它后面 —— 连重试都排不上。结构锁，
  // 不靠「这次那一批恰好不大」。
  const rtSrc = readSource(join(HERE, "../src/monitor-consume.ts"));
  assert.doesNotMatch(rtSrc, /\.unshift\(\.\.\./, "放回缓冲不许展开传参（见 returnToBuffer）");
  assert.match(rtSrc, /splice\(0, MONITOR_MAX_LINES_PER_FLUSH\)/, "一批必须有上界");
  console.log("✓ 结束条件的匹配有计算上界：服务里不构造调用方正则，锚点语义各自正确，读不出来的不许背书");
}
// ── ⑦g 库里存着一条**这一版读不出来**的结束条件 ⇒ 出声，不静默降级（第 2 轮审查 F2）──
// 结束条件的语义换过一轮（上一版收 JS 正则源文，这一版是字面量候选）。`^(READY|FAILED)$`
// 在旧语义下合法、今天解析不出来，而运行时对它的处置是「当没有结束条件」—— 静默降级之后
// 库里明明记着一条结束条件、卡片照旧念「…就收工」，哨兵却只会盯到到期（审查实测：READY
// 已经吐出来、status 仍是 running、events=1）。
{
  const taskId = await makeTask();
  const feed = join(root, "legacy.mjs");
  // **自毁兜底**：这一节会在进程内走一遍真实接回（`detachAllMonitors` + `reattachMonitors`），
  // 而接回那一刻身份未必认得回来（pid 边条核实不了就按设计不下刀，责任留在账上）—— 于是
  // 点停只写状态、台子 teardown 也收不走它，一个 `setInterval` 就永远留在机器上了（实测:
  // 跑完这节之后 `pgrep` 还能看到它）。活 30 秒足够这节用，之后它自己退。
  writeFileSync(feed, `setTimeout(() => console.log("READY"), 120);
const keep = setInterval(() => {}, 1000);
setTimeout(() => { clearInterval(keep); process.exit(0); }, 30000);
`);
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
    description: "旧语义的结束条件",
    stopWhen: "^READY",
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  const monitorId = started.ok ? started.monitor.id : "";
  // 创建闸不会放这种值进来，所以只有一种来源：**从库里接回来的**。照这个来源造现场。
  await db.update(monitors).set({ stopWhen: "^(READY|FAILED)$" }).where(eq(monitors.id, monitorId));
  await detachAllMonitors();
  const errs: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  try {
    await reattachMonitors();
  } finally {
    console.error = realErr;
  }
  assert.ok(
    errs.some((e) => /读不出来的结束条件/.test(e)),
    `接回一条读不出来的条件必须出声：${errs.join(" | ") || "（一声没出）"}`,
  );
  // 处置照旧是「当它没有结束条件」：READY 照常推给任务，但**不许猜一个语义**替它收工。
  await until("READY 照常送到", async () =>
    (await pendingOf(taskId)).some((m) => m.text.includes("READY")));
  assert.equal((await getMonitor(monitorId))?.status, "running", "读不出来 ⇒ 不提前收工，而不是瞎猜");
  await stopMonitor(monitorId, "⑦g 用例跑完了");
  console.log("✓ 读不出来的旧结束条件：接回时当场出声，处置仍是「当没有条件」而不是瞎猜");
}
// ── ⑦h 命中那一行排在第 41 行往后，也必须在消息里（第 2 轮审查 N2）──────────────────
// 单批只列前 40 行，而命中那一行多半就是 agent 要的结果本身。它被省略掉的话，agent 只会
// 收到一句「等到了约定的那一行」加一批看不出所以然的开头几行。
{
  const taskId = await makeTask();
  const feed = join(root, "deep-hit.mjs");
  writeFileSync(feed, `for (let i = 0; i < 60; i++) console.log("noise " + i);\nconsole.log("SWEEP_EXIT=0");\nsetInterval(() => {}, 1000);\n`);
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
    description: "命中那一行排在很后面",
    stopWhen: "^SWEEP_EXIT=",
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  const monitorId = started.ok ? started.monitor.id : "";
  await until("等到了就收工", async () => (await getMonitor(monitorId))?.status === "matched");
  const texts = (await pendingOf(taskId)).map((m) => m.text).join("\n");
  assert.match(texts, /SWEEP_EXIT=0/, "命中那一行一个字都不能被摘要吃掉");
  assert.match(texts, /约定的那一行在后面/, "要说清它为什么单独列出来");
  if (started.ok) await until("进程被收掉", async () => !isPidAlive(started.ok ? started.monitor.pid! : 0));
  console.log("✓ 命中那一行排在摘要之外时，照旧出现在推给 agent 的那条消息里");
}
console.log("✓ 结束条件：一出现就收工 / 没有出路的命令一个字都不跑 / 判据只认明确的几种 / 匹配有上界 / 读不出来的不静默降级 / 命中那一行不被摘要吃掉 均受回归保护");
await teardown();
