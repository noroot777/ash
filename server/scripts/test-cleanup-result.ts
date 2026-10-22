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
// `openResidue` 答的是**一组**发言:行上那份读不出来是一台设备弃权,待投清单里那几个号是
// 另一台设备点着名的活责任 —— 两件事各说一句(第 10 轮审查 F1-C)。下面几组只有一台设备在
// 说话,所以取唯一那条;两条都在说话的那一组见 test-cleanup-ownership.ts。
const only = (r: { answers: readonly { kind: string }[] }) =>
  r.answers.length === 1 ? r.answers[0] : null;

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

console.log("3) 点名了、却排除不掉的号:别的设备的「没有」解除不了这份责任");
{
  const { judgeByClues, mergeCleanupResults, mergeClueAnswers, openOf } =
    await import("../src/executors/cleanup-result.js");
  const { openResidue, serializeOpenMembers } = await import("../src/executors/cleanup-debt-judge.js");

  // 第 8 轮审查 F1-A 的机制:即时清理点名了一个排除不掉的号(这里是 `held`),而持久清扫
  // 手里另一套设备各自答「我这边没有」—— 合出来绝不许是「已经证明清空」。
  const held = { kind: "unknown", detail: "夹具:挂在谁下面问不出来", open: [{ pid: 4242, gen: "t:x", why: "夹具" }] } as const;
  const merged = mergeClueAnswers([held, { kind: "empty" }], "夹具");
  if (merged.kind !== "empty" && openOf(merged).some((o) => o.pid === 4242)) {
    ok("同一问里:一台点了名、一台答空 ⇒ 这一问不算空,而且那个号跟着结论走");
  } else fail(`判成了 ${merged.kind} —— 正是审查实测的那条路(别人的「没有」洗掉了点过的名)`);

  const across = judgeByClues([
    { subject: "root", answer: { kind: "empty" } },
    { subject: "descendants", answer: held },
  ]);
  if (across.kind !== "empty" && openOf(across).some((o) => o.pid === 4242)) {
    ok("两问之间合取时那个号也不会掉");
  } else fail("跨问合并把未排除的号丢了");

  // ── 核销:只有**逐个核过**才算覆盖这份责任 ────────────────────────────────────
  const mine = process.pid;
  const gen = (await import("../src/process-generation.js")).processGenerationSync(mine);

  // 弃权票带着号的那种:`silent` 会被两条合并路各走一次,名单都不许掉。
  //
  // 号要用**真活着而且核得动的那个**(这个进程自己):`sweptClean` 判空之前会先核销一遍,
  // 拿一个随手编的号当夹具时它会被正当地核掉(号上没进程 ⇒ 当初那个一定退了),于是这一组
  // 测的就不再是「名单挡不挡得住判空」,而是「核销管不管用」—— 那是下面几组的事。
  const mute = {
    kind: "silent", why: "夹具:这台机器答不了", open: [{ pid: mine, gen, why: "夹具" }],
  } as const;
  if (openOf(mergeCleanupResults([mute, { kind: "empty" }])).some((o) => o.pid === mine)
    && mergeClueAnswers([mute, { kind: "empty" }], "夹具").kind !== "empty") {
    ok("弃权票身上那个号同样跟着走,而且挡住了判空");
  } else fail("弃权票带的号被洗掉了");
  const dead = openResidue(serializeOpenMembers([{ pid: 0x7ffffff, gen: null, why: "夹具" }]));
  if (only(dead)?.kind === "empty") ok("号上没有进程了 ⇒ 这一笔核销得掉");
  else fail(`退出的号没核销掉(${only(dead)?.kind})`);

  const live = openResidue(serializeOpenMembers([{ pid: mine, gen, why: "夹具" }]));
  if (only(live)?.kind === "unknown" && live.retriable) ok("还是那一代 ⇒ 留着,而且可重试(它迟早会退)");
  else fail(`活着的号被判成了 ${only(live)?.kind}`);

  const reused = openResidue(serializeOpenMembers([{ pid: mine, gen: "t:别的那一代", why: "夹具" }]));
  if (only(reused)?.kind === "empty") ok("号上那一代换了主人 ⇒ 当初那个一定退了,核销得掉");
  else fail(`号换主人也没核销(${only(reused)?.kind})`);

  const blind = openResidue(serializeOpenMembers([{ pid: mine, gen: null, why: "夹具" }]));
  if (only(blind)?.kind === "unknown") ok("当初没记代次、它还活着 ⇒ 核不动,只能留着");
  else fail(`没记代次的活号被判成了 ${only(blind)?.kind}`);

  if (!openResidue(null).answers.length && !openResidue("[]").answers.length) {
    ok("没点过名的行:这台设备压根不发言(老行照旧按原来那几台设备判)");
  } else fail("空名单也发了言 —— 那会给每一行凭空加一问");

  // **坏字段不许吞掉手上还握着的有效身份**(第 10 轮审查 F1-C):这是两件事,要发两条言 ——
  // 行上那份读不出来是一台设备弃权(收档),待投清单里那个活号是另一台设备点着名的责任
  // (留着重试)。上一版把它们挤成一条 silent/不可重试,于是有效身份既挡不住销账(弃权票
  // 压不过别人的「我这边没有」),也等不到下一轮。
  const mixed = openResidue("{不是数组", [{ pid: mine, gen, why: "夹具" }]);
  const merged2 = mergeClueAnswers(mixed.answers, "夹具");
  if (mixed.answers.length === 2 && mixed.retriable && merged2.kind === "unknown"
    && openOf(merged2).some((o) => o.pid === mine)) {
    ok("坏字段 + 活身份:两条言各说一句,合出来是「留着重试」而且号还在");
  } else {
    fail(`坏字段把活身份吞了(${mixed.answers.length} 条言、合成 ${merged2.kind}、`
      + `retriable=${mixed.retriable})`);
  }

  const broken = openResidue("{不是数组");
  if (only(broken)?.kind === "silent" && !broken.retriable) {
    ok("名单读不出来 ⇒ 弃权收档,绝不当成「没有责任」");
  } else fail(`坏名单被判成了 ${only(broken)?.kind}`);
}

console.log("4) 名单只增不减:换代证明必须同源可比,同一个号的两代是两份责任");
{
  const { dischargeOpen, joinOpen, openKey } = await import("../src/executors/cleanup-result.js");
  const { openResidue, serializeOpenMembers } = await import("../src/executors/cleanup-debt-judge.js");
  const { processGenerationSync } = await import("../src/process-generation.js");

  const mine = process.pid;
  const real = processGenerationSync(mine);
  if (!real) throw new Error("这台机器读不出自己的代次,这一组没法测");
  // **另一个坐标系**的戳:本机是 `t:`(ps 文本)就拿 `j:`(Linux 节拍数)当夹具,反之亦然。
  const otherDomain = real.startsWith("j:") ? "t:Thu Oct 22 09:50:48 2026" : "j:123456";

  const cross = dischargeOpen([{ pid: mine, gen: otherDomain, why: "夹具" }]);
  if (!cross.gone.length && cross.left.length === 1) {
    ok("跨坐标系的不等不算换主:这一笔留着,不核销");
  } else fail("把两个证据域的不等当成了「号换了主人」—— 同一个号还活着,责任却被核销了");

  const crossRow = openResidue(serializeOpenMembers([{ pid: mine, gen: otherDomain, why: "夹具" }]));
  if (only(crossRow)?.kind === "unknown") ok("持久清扫那一侧同一判据(两边共用一份核销语义)");
  else fail(`清扫侧把它核销了(${only(crossRow)?.kind})`);

  // 同一个号的两代:集合成员键带代次,否则新责任会被旧项挤掉、再被旧代次的退出证明一起带走。
  const sameDomainStale = `${real.slice(0, 2)}${real.startsWith("j:") ? "1" : "Thu Oct 22 00:00:00 2026"}`;
  const two = joinOpen(
    [{ pid: mine, gen: sameDomainStale, why: "旧那一代" }],
    [{ pid: mine, gen: real, why: "这一代" }],
  );
  if (two.length === 2 && new Set(two.map(openKey)).size === 2) ok("同一个号的两代各占一格");
  else fail(`两代被挤成了 ${two.length} 格 —— 新责任会被旧项顶掉`);

  const split = dischargeOpen(two);
  if (split.gone.length === 1 && split.left.length === 1 && split.left[0]!.gen === real) {
    ok("旧那一代核销掉,这一代照旧欠着(不会两代一起消失)");
  } else fail(`两代没各自核销(核销 ${split.gone.length} 条、留下 ${split.left.length} 条)`);

  const dead = joinOpen([{ pid: 0x7ffffff, gen: "t:x", why: "夹具" }], []);
  if (dischargeOpen(dead).gone.length === 1) ok("号上没人 ⇒ 照旧核销得掉(名单会自己消解)");
  else fail("退出的号也核销不掉了,那会押一笔永远销不掉的债");
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过");
process.exit(bad ? 1 : 0);
