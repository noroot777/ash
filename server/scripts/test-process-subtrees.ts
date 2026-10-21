/**
 * **进程树快照与子树归属** —— 「这棵树凭什么算我们的」(第 1 轮审查 F1、第 2 轮审查 F1/F3)。
 *
 * 跟隔壁 `test-process-identity.ts` 分开住,是因为两边钉的是两个不同的问题,而合起来那一份
 * 已经顶破了 700 行:
 *   · 那边 —— 「**这个号**此刻还是不是它」:身份判据与三层击杀;
 *   · 这边 —— 「**这棵树**凭什么算我们的」:快照的形状、授权依据跟谁走、持有者这一问的三档。
 *
 * 要钉的那几件事:
 *   ⑬ 每个成员都带得出「哪个根把它带进来的」(退场的根不许带出后代);
 *   ⑭ 根授权不成立 ⇒ 它名下的后代一个都不许动,而且这一轮不许自称「确证清空」;
 *   ⑮ 「谁还握着这个文件」:退出码 1 不等于「查全了、没找到」;
 *   ⑯ 快照之后根换了代 ⇒ 整棵来源子树作废;
 *   ⑰ 同一个号来自两种依据时,**后面那些来源不许被挤掉**。
 *
 * 一律用真进程跑(不打模型):旁观者活下来才算判据生效。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-process-subtrees-"));
process.env.ASH_DB = join(root, "ash.db");

const { cleanupAfterRun, markAdoptedChild } = await import("../src/executors/spawn.js");
const { IS_WINDOWS, isPidAlive } = await import("../src/platform.js");
const { inspectProcess } = await import("../src/proc.js");
const {
  processTreeMembers, processTableSnapshot, subtreesOf, stillSameGeneration,
} = await import("../src/process-generation.js");
const {
  probeFileHolders, holderMayOwn, holderScanFault, provenNoHolders,
} = await import("../src/executors/track-evidence.js");
// 建库:⑭ 的清理责任要真的落进 `agent_cleanup_debts`,少了这一步「落库失败」会被读成
// 「这条路本来就不落库」,披露那一半就钉不住。
const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const { recordedGrade } = await import("../src/monitor-reclaim-evidence.js");

/** 拼一个 detached.ts 那种合成句柄:字段齐全,但 exitCode 由回调补写,不是内核答案。 */
function synthetic(pid: number | undefined, fields: Partial<ChildProcess> = {}): ChildProcess {
  return { pid, exitCode: null, signalCode: null, kill: () => true, on: () => {}, ...fields } as unknown as ChildProcess;
}

const strays: ChildProcess[] = [];
/** 只拿到号的那些(别人进程组里的后代):收尾一并清掉,别把 sleep 留在机器上。 */
const strayPids: number[] = [];
/** 用例自己造的临时文件:收尾删掉,别把垃圾留在 /tmp。 */
const tempFiles: string[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── ⑬ 树快照的每个成员都带得出「哪个根授权了它」 ──────────────────────────────────
// 钉的是 F1 的根因:上一版 `processTreeMembers` 交出平铺的 roots/descendants,两者之间
// 没有连线 —— 于是调用方把根按第二次取证过滤掉之后,那棵树的孩子仍然无条件进了击杀名单
// (审查实测:根被复查排除、根自己还活着,它的孩子被生产清理代码关掉)。现在形状按根分组,
// 「拿不到来源根就拿不到成员」是类型上的必然。
if (IS_WINDOWS) {
  console.log("   ~ Windows 的树枚举走另一条(进程表行自带代次),跳过 ⑬");
} else {
  const parent = spawn(process.execPath, [
    "-e", "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],"
      + "{stdio:'ignore'});setTimeout(()=>{},60000)",
  ], { stdio: "ignore", detached: true });
  parent.unref();
  strays.push(parent);
  await wait(700);                                // 等孙子起来

  const dead = 999_998;
  assert.equal(isPidAlive(dead), false, "这条用例要一个确定不存在的根");
  const trees = await processTreeMembers([parent.pid!, dead]);
  assert.ok(trees, "前提:这台机器上问得出进程树");
  assert.equal(trees!.length, 2, "按根分组:给几个种子就回几棵子树");

  const mineTree = trees!.find((t) => t.seed.pid === parent.pid)!;
  assert.ok(mineTree.root, "活着的根在快照里有自己的那一代");
  assert.equal(mineTree.root!.gen, mineTree.seed.gen, "根的代次与种子记下的那一代同源");
  assert.ok(mineTree.descendants.length >= 1, "它的孩子挂在它这棵子树下面");
  for (const member of mineTree.descendants) {
    assert.notEqual(member.pid, parent.pid, "后代名单里不含根自己");
    assert.ok(member.gen, "每个后代都带着与父子关系同源的那一代");
  }

  const deadTree = trees!.find((t) => t.seed.pid === dead)!;
  assert.equal(deadTree.root, null, "根已经不在进程表上 ⇒ 它不是成员");
  assert.equal(deadTree.seed.gen, null, "种子如实记下「这个号此刻不在表上」");
  // **最要紧的一条**:已经退场的那个根,它名下不许冒出别人的孩子来。
  assert.equal(deadTree.descendants.length, 0, "退场的根不许带出任何后代");

  try { process.kill(parent.pid!, "SIGKILL"); } catch { /* 已经没了 */ }
}

// ── ⑭ 根授权不成立时,它名下的后代一个都不许动 ────────────────────────────────────
// 这是 F1 在**生产清理路径**上的那一面:句柄只有号 + 秒级启动时刻(粗档)、拿不出记号也
// 拿不出输出文件 ⇒ 这个根不该当树根,于是它的孩子一个都不该被碰。顺带钉 F2 的结论契约:
// 这一轮不许自称「确证清空」。
if (IS_WINDOWS) {
  console.log("   ~ Windows 的授权依据是另一档(残留 ParentProcessId),跳过 ⑭");
} else {
  const root = spawn(process.execPath, [
    "-e", "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],"
      + "{stdio:'ignore'});setTimeout(()=>{},60000)",
  ], { stdio: "ignore", detached: true });
  root.unref();
  strays.push(root);
  await wait(700);
  const tree = await processTreeMembers([root.pid!]);
  const kidPid = tree?.[0]?.descendants[0]?.pid;
  assert.ok(kidPid, "前提:这个根下面确实挂着一个孩子");

  const startedAt = inspectProcess(root.pid!)?.startedAt ?? null;
  const bare = synthetic(root.pid);
  markAdoptedChild(bare, root.pid!, startedAt);   // 粗档身份,没有记号、没有输出文件
  const verdict = await cleanupAfterRun(bare);
  await wait(2400);                               // 连补刀窗口一起等过去

  if (startedAt && recordedGrade(startedAt) === "exclusive") {
    console.log("   ~ 排他档(win32)上这个根本来就授权得了,⑭ 的前提不成立,跳过");
  } else {
    assert.equal(isPidAlive(root.pid!), true, "根拿不出排他凭证 ⇒ 它自己不许被碰");
    assert.equal(isPidAlive(kidPid!), true,
      "**根授权不成立 ⇒ 整棵来源子树作废**:后代自己的代次照样相等,但那不是归属(F1)");
    assert.notEqual(verdict.kind, "empty", "还有东西活着 ⇒ 清理结论不许是「确证清空」");
  }
  try { process.kill(kidPid!, "SIGKILL"); } catch { /* 已经没了 */ }
  try { process.kill(root.pid!, "SIGKILL"); } catch { /* 已经没了 */ }
}

// ── ⑯ 快照之后根换了代 ⇒ 整棵来源子树作废 ────────────────────────────────────────
// F1 要防的那个真实形态:取快照时根好好的,等到要下刀时它已经退场(或者那个号被别人接手)。
// 它名下那棵子树的孩子**自己的代次照样相等** —— 拿后代代次当归属用就会打在这些孩子身上。
// 归属只来自根,所以这一刻根的复核不通过,整棵来源子树都得作废。
//
// 顺带钉住**读数顺序**:快照在前、归属线索在后。快照里记的是根**那一代**,所以号换主人必然
// 让复核失败。顺序反过来(先问线索、后取快照)这一步就断了:快照读到的可能已经是接手这个
// 号的另一个进程,而它自己从那以后没换过代,复核照样通过(这正是上一版要靠第二次 lsof 去
// 夹、却又分不清「换主人」和「自己松开线索」的原因)。
if (IS_WINDOWS) {
  console.log("   ~ Windows 的树枚举与授权走另一档,跳过 ⑯");
} else {
  const family = spawn(process.execPath, [
    "-e", "const {spawn}=require('node:child_process');"
      + "const kid=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});"
      + "console.log(JSON.stringify({root:process.pid,kid:kid.pid}));setInterval(()=>{},1000);",
  ], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  family.unref();
  strays.push(family);
  const ids = JSON.parse(String(await new Promise<Buffer>((r) => family.stdout!.once("data", r))));
  strayPids.push(ids.root, ids.kid);
  await wait(400);

  const snap = await processTableSnapshot();
  assert.ok(snap, "前提:这台机器上拿得到进程表快照");
  // 来源是对象而不是裸号(依据跟着 `source` 走,见 ⑰ 与 `ProcessSubtree`)。
  const tree = subtreesOf(snap!, [{ pid: ids.root as number }])[0]!;
  assert.ok(tree.root, "前提:快照那一刻根好好的");
  assert.ok(tree.descendants.some((m) => m.pid === ids.kid), "前提:孩子挂在这棵子树下面");
  assert.equal(stillSameGeneration(tree.root!), true, "前提:此刻根还是快照里那一代");

  // 根退场 —— 「快照里那个根实例已经不在」的真实形态。
  try { process.kill(ids.root, "SIGKILL"); } catch { /* 已经没了 */ }
  await wait(700);
  assert.equal(stillSameGeneration(tree.root!), false,
    "根换了代 ⇒ 这一道闸必须答否(授权的落点是快照里那个根实例,不是那个号)");
  // 孩子自己还是原来那一代 —— **正是因此**不能拿它当归属:它此刻已经被重父到 1 号名下,
  // 跟那棵以旧根为根的树再没关系了。
  const kidStill = tree.descendants.find((m) => m.pid === ids.kid)!;
  assert.equal(stillSameGeneration(kidStill), true,
    "后代自己的代次照样相等 —— 所以它证明不了归属(F1 的根因)");
  assert.equal(isPidAlive(ids.kid), true, "来源子树作废 ⇒ 这个孩子一刀都没挨");

  try { process.kill(ids.kid, "SIGKILL"); } catch { /* 已经没了 */ }
}

// ── ⑮ 「谁还握着这个文件」:退出码 1 不等于「查全了、没找到」 ──────────────────────
// F2 的第 6 点:`lsof -t -- <不存在的路径>` 打印 `status error` 之后**也退 1**。上一版把全部
// 退出 1 读成确证空,于是「真的没人握着」(可以销毁证据)和「这一问出错了」(只能重试)
// 长得一模一样。
if (IS_WINDOWS) {
  console.log("   ~ Windows 上没有 lsof 这条路,跳过 ⑮");
} else {
  const absent = join(tmpdir(), `ash-track-absent-${process.pid}-${Date.now()}`);
  assert.equal(existsSync(absent), false, "这条用例要一个确定不存在的路径");
  const missing = await probeFileHolders(absent);
  assert.ok(holderScanFault(missing), "文件不在 ⇒ 线索断了,不是「确证没人握着」");
  assert.equal(holderScanFault(missing)?.lost, true,
    "而且要分得出「再问也没用」这一种,好让清理责任按「追到这里为止」收档");

  // 对照:文件在、真的没人握着 ⇒ 这才是唯一允许销毁证据的那一档。
  const quiet = join(tmpdir(), `ash-track-quiet-${process.pid}-${Date.now()}`);
  writeFileSync(quiet, "");
  tempFiles.push(quiet);
  assert.equal(provenNoHolders(await probeFileHolders(quiet)), true, "文件在、没人握着 ⇒ 确证空");

  // 对照:有人握着 ⇒ held。
  const heldPath = join(tmpdir(), `ash-track-held-${process.pid}-${Date.now()}`);
  const fd = openSync(heldPath, "w");
  tempFiles.push(heldPath);
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "ignore", "ignore", fd], detached: true,
  });
  holder.unref();
  strays.push(holder);
  closeSync(fd);
  await wait(400);
  const held = await probeFileHolders(heldPath);
  assert.equal(held.scan, "complete", "lsof 正常跑完 ⇒ 这一问问全了");
  assert.ok(held.found.some((h) => h.pid === holder.pid), "而且要点出是谁");
  // **还要点出「他是怎么握着的」**(第 3 轮审查 F1):这一问的答案被用来授权整棵子树的击杀,
  // 而裸 pid 列表把「以写模式继承下来的真后代」和「只读打开同一个文件的看客」混成一类。
  // fd 号 + 访问模式是唯一分得开的地方:继承进去的是写模式的那一份。
  const asDescendant = held.found.find((h) => h.pid === holder.pid);
  assert.equal(asDescendant?.fd, 3, "继承进去的就是 3 号 fd:这一问要答得出 fd 号");
  assert.equal(asDescendant?.mode, "write", "以写模式打开再继承 ⇒ 写模式");
  assert.equal(holderMayOwn(asDescendant!), true, "写模式才配当树根");

  // 对照:同一个文件被只读打开 ⇒ 同样是持有者,但**不配当树根**。
  const rfd = openSync(heldPath, "r");
  const viewer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "ignore", "ignore", rfd], detached: true,
  });
  viewer.unref();
  strays.push(viewer);
  closeSync(rfd);
  await wait(400);
  const bothHeld = await probeFileHolders(heldPath);
  const asViewer = bothHeld.found.find((h) => h.pid === viewer.pid);
  assert.equal(asViewer?.mode, "read", "只读打开的要答只读");
  assert.equal(holderMayOwn(asViewer!), false, "只读的看客不配当树根(授权只认写模式)");
  try { process.kill(viewer.pid!, "SIGKILL"); } catch { /* 已经没了 */ }
  try { process.kill(holder.pid!, "SIGKILL"); } catch { /* 已经没了 */ }
}

// ── ⑰ 同一个号来自两种依据时,后面那些来源不许被挤掉 ───────────────────────────────
// 钉的是第 2 轮审查 F3 的根因:这一层曾按 pid 去重、调用方却按原数组下标回取授权依据。
// 有重复项时两边从第一个重复开始整体错位 —— 后面的子树拿着别人的依据判,独立的真实成员
// 被静默过滤掉(实测:三个成员全查到了,下刀名单只剩一个,而且 answered=true、faults=[])。
// 现在依据跟着 `source` 走,错位在类型上不可表达;这一条守住那个形状契约。
//
// 为什么是形状契约而不是端到端:要在真实现场撞出错位,得让重复项**排在**其它来源之前,
// 而生产里的顺序是「fd 持有者 → 句柄 → 记号成员」,只有记号 `ours` 那一档(Linux 的
// `/proc/<pid>/environ`)能在重复项之后再加来源。macOS 给不出那一档,所以这里不冒充
// 端到端实测,直接钉住被错位的那个接口。
if (IS_WINDOWS) {
  console.log("   ~ Windows 的树枚举走另一条,跳过 ⑰");
} else {
  const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore", detached: true,
  });
  alive.unref();
  strays.push(alive);
  const second = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore", detached: true,
  });
  second.unref();
  strays.push(second);
  await wait(400);

  const snap = await processTableSnapshot();
  assert.ok(snap, "前提:拿得到进程表快照");
  // 重复项**排在前面**,后面再跟两个各不相同的来源 —— 正是会错位的那个排法。
  const sources = [
    { pid: alive.pid!, why: "fd" },
    { pid: alive.pid!, why: "handle" },
    { pid: second.pid!, why: "unit" },
    { pid: 999_997, why: "退场的那个" },
  ];
  assert.equal(isPidAlive(999_997), false, "这条用例要一个确定不存在的号");
  const trees = subtreesOf(snap!, sources);

  assert.equal(trees.length, sources.length, "进来几项就出去几项:不去重、不丢项");
  for (const [i, tree] of trees.entries()) {
    // **身份比较,不是值比较**:依据必须是调用方交进来的那一项原物。
    assert.equal(tree.source, sources[i], `第 ${i} 棵树带的是它自己那一项依据`);
    assert.equal(tree.seed.pid, sources[i]!.pid, "种子的号跟来源对得上");
  }
  assert.ok(trees[0]!.root && trees[1]!.root, "同一个号的两份依据各自成树,两棵都有根");
  assert.equal(trees[0]!.root!.gen, trees[1]!.root!.gen, "同一个号 ⇒ 同一代(两棵树读的是同一张快照)");
  assert.ok(trees[2]!.root, "重复项之后那个独立来源照样拿到自己的树(F3 漏掉的就是它)");
  assert.equal(trees[2]!.seed.pid, second.pid, "而且是它自己的号,不是前面那个号");
  assert.equal(trees[3]!.root, null, "退场的号:空树");
  assert.equal(trees[3]!.descendants.length, 0, "退场的号不许带出后代");

  // 非法号也要占一项(丢掉它同样会让「进来 N 项、出去 M 项」重新成为可能),而且不许把
  // init 名下整台机器的进程走成「我们的后代」。
  const withInit = subtreesOf(snap!, [{ pid: 1 }, { pid: 0 }, { pid: alive.pid! }]);
  assert.equal(withInit.length, 3, "非法号照样占一项");
  assert.equal(withInit[0]!.descendants.length, 0, "1 号(init)不许当树根");
  assert.equal(withInit[1]!.root, null, "0 号不是可用的根");
  assert.equal(withInit[2]!.seed.pid, alive.pid, "后面那个正常来源没被非法号挤掉");

  try { process.kill(alive.pid!, "SIGKILL"); } catch { /* 已经没了 */ }
  try { process.kill(second.pid!, "SIGKILL"); } catch { /* 已经没了 */ }
}

for (const child of strays) {
  try { if (child.pid) process.kill(child.pid, "SIGKILL"); } catch { /* 已经没了 */ }
}
for (const pid of strayPids) {
  try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ }
}
for (const path of tempFiles) {
  try { unlinkSync(path); } catch { /* 已经没了 */ }
}
console.log("process-subtree regressions ok");
process.exit(0);
