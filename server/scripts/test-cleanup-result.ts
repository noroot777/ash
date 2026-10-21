// **判空的不变量**:根与后代两问都要有正面答案,弃权不算空。
//
// 从 `test-cleanup-debt.ts` 拆出来是因为这一组是**纯代数** —— 不碰数据库、不起真进程,
// 所以它在任何平台上都跑得到、几毫秒就出结果;混在那份带夹具的用例里只会被真进程的
// 现场依赖拖住(那份也已经贴着单文件行数上限)。
//
// 钉的是第 4 轮审查 F1 的机制本身:Windows 真机上两台设备都结构性答不了,各返回「没有
// 残留」,合并出来成了「已经证明清空」,于是一行**记着活根进程**的责任被真的 DELETE 掉
// (settled=1、行 0 笔、同一个 pid 仍 alive、写文件计数 78→83)。
let bad = 0;
const ok = (m: string) => console.log(`   ✓ ${m}`);
const fail = (m: string) => { bad += 1; console.log(`   ✗ ${m}`); };

console.log("1) 判空的不变量:弃权压过「空」,空数组另当别论");
{
  const {
    judgeByClues, mergeCleanupResults, mergeClueAnswers, residueFromProbe,
  } = await import("../src/executors/cleanup-result.js");

  const silent = { kind: "silent", why: "夹具:这台机器答不了" } as const;
  if (mergeCleanupResults([]).kind === "empty") ok("空数组仍然是「空」:压根没有要收的东西");
  else fail("空数组不再是「空」—— 常驻句柄的待收册会永远收不干净");

  if (mergeCleanupResults([silent, { kind: "empty" }]).kind === "silent") {
    ok("一份弃权 + 一份「空」⇒ 结论是弃权(两问之间是合取)");
  } else fail("弃权票被「空」洗掉了 —— 正是 F1 那一下");

  if (mergeClueAnswers([silent, { kind: "empty" }], "夹具").kind === "empty") {
    ok("同一问的两台设备:一台正面答空、一台弃权 ⇒ 这一问答出来了空");
  } else fail("同一问里弃权票把答出来的那台否掉了(那会让 Windows 每个回合都欠一笔债)");

  if (mergeClueAnswers([silent, silent], "夹具").kind === "silent") ok("全体弃权 ⇒ 这一问弃权");
  else fail("全体弃权却得出了结论");

  if (mergeClueAnswers([], "夹具").kind === "silent") ok("一台设备都没有 ⇒ 这一问没有证据来源");
  else fail("没有任何设备却替这一问答了");

  const washed = judgeByClues([
    { subject: "root", answer: silent },
    { subject: "descendants", answer: { kind: "empty" } },
  ]);
  if (washed.kind === "silent") ok("后代答空、根却核验不了 ⇒ 整条结论不是空(不许销账)");
  else fail(`根没核验过却判成 ${washed.kind} —— 正是 F1 的机制`);

  // 「这一次运行没有这条线索」缺的是**资源**不是设备:没有文件就没有东西能握着它。
  if (residueFromProbe("夹具文件", null).kind === "empty") ok("压根没有这个文件 ⇒ 正面答空");
  else fail("把「没有这个文件」也记成了弃权(每个回合都会欠一笔债)");
}

console.log("2) 一条路径线索:半截查询不许读成空");
{
  const { residueFromProbe } = await import("../src/executors/cleanup-result.js");
  // 这一组是纯代数:**不起进程**。用一个必然不存在的号当「已经退出的持有者」,
  // 用自己这个号当「还活着的持有者」—— 真实现场的那一版在 test:holder-scan 里。
  const dead = { pid: 0x7ffffff, fd: 5, mode: "write" } as const;
  const alive = { pid: process.pid, fd: 5, mode: "write" } as const;
  const partial = { fault: "夹具:lsof 退出码 2", retriable: true } as const;

  const washed = residueFromProbe("夹具文件", { scan: partial, found: [dead] });
  if (washed.kind === "unknown") ok("发现的号都退了、但这一问没问全 ⇒ 问不出来,不是空");
  else fail(`判成了 ${washed.kind} —— 没覆盖到的那部分一个字都没被证明过(第 5 轮 F1)`);

  if (residueFromProbe("夹具文件", { scan: partial, found: [] }).kind === "unknown") {
    ok("半截查询连一个持有者都没发现 ⇒ 同样只是没问全");
  } else fail("空的半截回答被当成了确证空");

  const hard = residueFromProbe("夹具文件", { scan: partial, found: [alive] });
  if (hard.kind === "remaining") ok("发现一个活着的写手 ⇒ 确证残留,不因这一问后来出错而作废");
  else fail(`正面证据被出错盖掉了,判成 ${hard.kind}`);

  if (residueFromProbe("夹具文件", { scan: "complete", found: [dead] }).kind === "empty") {
    ok("问全了、发现的号都退了 ⇒ 这才是允许销账的那一档");
  } else fail("问全了也不敢答空,那每一笔账都永远推不动");
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过");
process.exit(bad ? 1 : 0);
