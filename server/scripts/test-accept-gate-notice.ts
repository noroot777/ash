import assert from "node:assert/strict";
import { gateCommandMissNotice, type GateMissOrigin } from "../src/accept-gate-miss.js";
import { gateFailurePrompt } from "../src/accept-gate-messages.js";
import type { AcceptGateMissAttribution } from "@ash/shared/accept-gate";

/** 起跑前那一层核过的**是什么**：措辞里到处要引它,所以由这里导出给命令级那份用。 */
export const PROBE_BY = "被测快照 package.json 的 scripts";

/**
 * 结论和回流模板的**措辞**:全是纯函数,不碰进程、不碰临时目录 —— 所以从
 * test-accept-gate-command.ts 里拆出来（那份已经顶到 700 行的约定上限）。
 * 由命令级那份在同一个进程里调用,回归入口不必多列一条。
 */
export function testGateNoticeWording(): void {
  // ── 结论的措辞：三件事（没启动 / 目标分支上的情形 / 出路）要齐,而且**出路必须跟核实
  //    档位对上**。存在性只认定义级/文件级判据,文字命中只是线索（审查二 F2）。
  const entryMiss = { kind: "entry" as const, name: "test:accept", entryResolved: false,
    evidence: '起跑前核过：被测快照 package.json 的 scripts里没有 test:accept', by: PROBE_BY };
  const origin = (patch: Partial<GateMissOrigin>): GateMissOrigin => ({
    targetBranch: "main", targetCommit: "cf182e15bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", behind: 80,
    holders: [], absent: null, removedByTask: null, targetAddedIt: true, unverified: false, ...patch });
  const notice = (patch: Partial<Parameters<typeof gateCommandMissNotice>[0]>) => gateCommandMissNotice({
    command: "npm run test:accept", miss: entryMiss, sourceCommit: "de91d6c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    origin: null, ...patch });
  const holder = { commit: "968c5de45ab4ebde5252f6cc0a5e16fc690d49a2",
    date: "2026-10-24T17:24:52+08:00", subject: "Move frontend regression from push to acceptance" };

  // ① 定义级：读出目标分支那份 manifest 核过。这一档敢直说,也敢给合入建议。
  const defined = notice({ origin: origin({ holders: [{ file: "package.json", how: "definition", ...holder }] }) });
  assert.match(defined, /一行都没跑到/, "① 命令点名要跑的东西没解析出来");
  assert.match(defined, /起跑前核过/, "① 判据是起跑前那份事实");
  assert.match(defined, /是有定义的/, "② 定义级事实可以直说");
  assert.match(defined, /968c5de4/, "② 最早写进那个文件的是哪次提交");
  assert.match(defined, /落后 main 80 个提交/, "② 任务分支落后目标分支多少");
  assert.match(defined, /把 main 合进任务分支/, "③ 核实过目标分支上有,才给合入建议");
  // 「目标上有」推不出「合进来就有」（第 8 轮审查 F3：自定义合并驱动让干净合并后照旧缺它）。
  assert.match(defined, /合完先核一眼这条命令在不在树里/, "③ 合入建议必须带上「合完自己核一眼」");
  assert.match(defined, /合并策略/, "③ 说清为什么不能保证");
  assert.equal(/就在树里了/.test(defined), false, "不许保证合进来它就在树里（审查八 F3）");
  assert.match(defined, /跳过前置命令/, "③ 出路之二：这次显式跳过");
  assert.match(defined, /都要你自己定/, "两条出路都是用户的决定,ash 不许自己做");
  assert.equal(/文字命中/.test(defined), false, "定义级不该退回文字命中那一档的对冲");
  assert.equal(/\*\*|`/.test(defined), false, "结论要纯文本：日志和 MCP 回执都不渲染 markdown");

  // ② 文字命中只是线索 —— 措辞必须说破,否则就是拿检索结果冒充命令定义（审查一 F3）。
  // 文字线索那一档真跑时 targetAddedIt 必然是 null（它压根没走定义级那条查询）。
  const byText = notice({ origin: origin({ targetAddedIt: null, holders: [{ file: "docs/ci.md", how: "text", ...holder }] }) });
  assert.match(byText, /文字命中，不等于它就是那条命令的定义/, "② 不许把文字命中冒充命令定义");
  assert.match(byText, /把 main 合进任务分支/, "② 线索也算正面证据,出路照给但要带条件");
  assert.match(byText, /仍然报同样的错/, "② 并且要说清合完可能还是不行");
  assert.match(byText, /合完先核一眼这条命令在不在树里/, "② 这一档也要带上「合完自己核一眼」");

  // ③ 文件级（命令点名的就是个文件）：确定事实,不必对冲。
  const byPath = gateCommandMissNotice({
    command: "./kb.sh test full", sourceCommit: "de91d6c0",
    miss: { kind: "entry", name: "./kb.sh", entryResolved: false, by: "被测快照里的文件",
      evidence: "起跑前核过：被测快照里的文件里没有 ./kb.sh" },
    origin: origin({ behind: 4, holders: [{ file: "kb.sh", how: "path", ...holder }] }),
  });
  assert.match(byPath, /只有目标分支上有/, "文件级事实可以直说");
  assert.match(byPath, /新加的/, "文件级事实可以说清它是目标分支新加的");
  assert.match(byPath, /合完先核一眼这条命令在不在树里/, "但合并结果照样不许保证（审查八 F3）");
  assert.equal(/文字命中/.test(byPath), false, "路径模式不许套用文字命中的对冲");

  // ④ 目标分支上**确实**也没有（定义级核出来的）：合分支解决不了,绝不许给合入建议。
  const absent = notice({ origin: origin({ behind: 3, absent: "definition" }) });
  assert.match(absent, /上也找不到/, "如实说目标分支上也没有");
  assert.match(absent, /合目标分支进来也不会让它出现/, "要说破合分支解决不了");
  assert.match(absent, /核对项目设置里这条验收前置命令本身/, "换成真正的出路");
  assert.equal(/合进任务分支/.test(absent), false, "目标分支上也没有时,不许保证合入能解决");

  // ⑤ 没核对出来。**文字检索查空也落在这一档**（审查二 F2：基线 description 里提过一句,
  //    就足以让「出现这个名字的文件集合」差集为空,而定义明明在目标分支上）。
  for (const unverifiedOrigin of [null, origin({ behind: 3, unverified: true }),
    origin({ behind: 3, unverified: false, holders: [], absent: null })]) {
    const unknown = notice({ origin: unverifiedOrigin });
    assert.match(unknown, /在目标分支上是什么情形，这次没能核对出来/, "如实说目标分支那件事没核对出来");
    assert.match(unknown, /不能保证/, "明说不能保证合入就解决");
    assert.equal(/把 main 合进任务分支/.test(unknown), false, "没核实过就不许给确定的合入建议");
    assert.equal(/上也找不到/.test(unknown), false, "更不许反过来说目标分支上也没有（审查二 F2）");
    // 归因未知 ≠ 归因为「不是你删的」。结论里必须留着这一步,否则 agent 读到的是免修令
    // （第 3 轮审查 F2：任务真把验收脚本删了、而目标 ref 又读不到时，它会被按住不许修）。
    assert.match(unknown, /先核一眼这件事/, "归因没核出来,就得让它先去核");
  }

  // ⑤' 核实过「不是这次改动弄没的」：这一档才不必再去核归因。
  const notMine = notice({ origin: origin({ behind: 3, removedByTask: false,
    holders: [{ file: "package.json", how: "definition", ...holder }] }) });
  assert.equal(/先核一眼这件事/.test(notMine), false, "核过不是它删的,就不该再让它去核一遍");

  // ⑥ 是**这次改动**把它弄没的：缺失推不出「与本次改动无关」（审查二 F1 末条）。
  const mine = notice({ origin: origin({ behind: 2, removedByTask: true }) });
  assert.match(mine, /开工基线上/, "要说清它在基线上是有的");
  assert.match(mine, /删掉或改名/, "要指出最可能的原因");
  assert.match(mine, /要改代码的一种/, "这一档的出路就是去改代码");
  assert.equal(/都要你自己定/.test(mine), false, "这一档不该先摆成「用户拍板」那两条出路");

  // ⑦ 存在性核实了、但「哪次提交带进来的」追不出来：**只丢时间,不丢那条事实**。旧版本
  //    在这种情形下把整个 holder 丢掉,于是核实过的存在性退回到「没核对出来」那一档,
  //    合入建议也一起消失了（第 3 轮审查 F3）。
  const noTime = notice({ origin: origin({ behind: 5,
    holders: [{ file: "package.json", how: "definition", commit: null, date: null, subject: null }] }) });
  assert.match(noTime, /是有定义的/, "存在性已经核实了,不许因为缺个时间一起丢掉");
  assert.match(noTime, /哪次提交带进来的，这次没追出来/, "追不出来就如实说,不许编一个");
  assert.match(noTime, /把 main 合进任务分支/, "存在性这一档的出路照给");
  // 这里要钉的是**第二件事**（目标分支上的情形）没退化成「没核对出来」。归因那句用的是同
  // 一个词，所以断言得指名道姓 —— 这条 origin 的归因默认是未知的,归因那句本来就该在。
  assert.equal(/在目标分支上是什么情形，这次没能核对出来/.test(noTime), false, "缺时间不等于没核对出来");

  // ⑧ 「目标分支上有」推不出「合它进来就有」（第 7 轮审查 F3）：共同祖先上本来就有、而任务
  //    这一侧把它删了的时候，合并会保留那个删除 —— 那时给合入保证，照着做只会再撞同一个错。
  const kept = notice({ origin: origin({ behind: 0, targetAddedIt: false, removedByTask: false,
    holders: [{ file: "package.json", how: "definition", ...holder }] }) });
  assert.match(kept, /是有定义的/, "存在性照说");
  assert.match(kept, /一般保留这个删除/, "明说合进来一般恢复不了");
  assert.match(kept, /共同祖先上就有/, "说清为什么：删除在任务这一侧");
  assert.match(kept, /把那个定义取回来/, "给真正能解决的那条出路");
  assert.match(kept, /跳过前置命令/, "另一条出路照给");
  assert.equal(/把 main 合进任务分支/.test(kept), false,
    "恢复不了就不许摆出「合进来再点验收」那条出路");
  assert.equal(/就在树里了/.test(kept), false, "更不许给「那时它就在树里了」这种保证");

  // ⑧' 合入能不能恢复**没核出来**：只能给条件句,不许保证。
  const maybe = notice({ origin: origin({ targetAddedIt: null,
    holders: [{ file: "package.json", how: "definition", ...holder }] }) });
  assert.match(maybe, /把 main 合进任务分支/, "存在性核过了,出路照给");
  assert.match(maybe, /没核出它是目标分支新加的/, "但要说破:这次没核出它是谁加的/谁删的");
  assert.match(maybe, /合完先核一眼这条命令在不在树里/, "这一档同样要带上「合完自己核一眼」");
  assert.equal(/就在树里了/.test(maybe), false, "没核出来就不许给「合进来它就在树里了」那句保证");
  for (const [what, text] of [["恢复不了", kept], ["没核出来", maybe]] as const) {
    assert.equal(/\*\*|`/.test(text), false, `结论要纯文本:日志和 MCP 回执都不渲染 markdown（${what} 那一档）`);
  }

  // ── inner 四种措辞：命令整体有没有跑起来,只许照起跑前那份事实说（审查二 F1、审查八 F1）──
  const innerOf = (patch: Partial<Parameters<typeof gateCommandMissNotice>[0]["miss"]>) => gateCommandMissNotice({
    command: "npm run test:accept", sourceCommit: "de91d6c0", origin: null,
    miss: { kind: "inner", name: "./regressed-helper.cjs", by: "node", entryResolved: null,
      evidence: "Cannot find module './regressed-helper.cjs'", ...patch },
  });
  const inner = innerOf({ entryResolved: true });
  assert.match(inner, /不是「它不在树里」那一种/, "核过入口在树里,只敢排除这一种");
  // 在树里 ≠ 跑起来了：权限位（126）、解释器缺失都挡在前面（第 3 轮审查 F1 实测）。
  assert.match(inner, /这一层说不了/, "存在性推不出执行,这一句必须留着");
  assert.equal(/确实跑起来了|跑起来了。/.test(inner), false, "存在性不许被抬成「它跑起来了」");
  assert.match(inner, /也可能是这次改动把名字写错了/, "inner 不许排除「是你改出来的」");
  assert.equal(/一行都没跑到|跳过前置命令|合进任务分支/.test(inner), false, "inner 不许摆那两条出路,也不许说测试没跑");

  // 第四种（第 8 轮审查 F1）：起跑前读到「它不在」，但另两件必要条件缺一件。措辞必须说清
  // **缺的是哪一件** —— 那是用户唯一能据以自己去看一眼的线索；三种都不许说「没启动」。
  for (const [withheld, expected] of [
    ["ran-elsewhere", /读的是另一份 manifest/],
    ["foreign-output", /有别的程序写过东西/],
    ["no-runner-claim", /并没说它解析不出这个名字/],
    ["unreadable", /核不出来是谁写的/],
  ] as const) {
    const held = innerOf({ name: "test:accept", by: "被测快照 package.json 的 scripts",
      entryResolved: false, withheld, evidence: "起跑前核过 被测快照 package.json 的 scripts：没有 test:accept" });
    assert.match(held, expected, `${withheld}: 要说清缺的是哪一件`);
    assert.match(held, /起跑前在 被测快照 package.json 的 scripts 里没找到/, `${withheld}: 核到的那件照说`);
    assert.match(held, /不敢说它没启动/, `${withheld}: 明说这一层不敢下那个结论`);
    assert.match(held, /更不敢说这条红不用你修/, `${withheld}: 也不许暗示可以不修`);
    assert.equal(/一行都没跑到，这不是断言失败|跳过前置命令|合进任务分支/.test(held), false,
      `${withheld}: 不许摆出免修那一档的结论和出路`);
    assert.equal(/去掉再点一次验收/.test(held), false,
      `${withheld}: 命令里没有堵嘴的开关就别让人去掉什么`);
    assert.equal(/\*\*|`/.test(held), false, `${withheld}: 结论要纯文本`);
  }

  // ②拿不到是**命令自己**造成的那一种（第 8 轮实测：`npm run --silent nosuch` 一个字都不打印）：
  // 判据照旧不放松，但要多给一句用户自己就能拿到确切结论的出路。只在 no-runner-claim 这一档给
  // —— 另两档缺的不是 runner 的嘴，去掉开关也补不上。
  for (const flag of ["--silent", "-s", "--quiet", "--loglevel=silent", "--loglevel silent"]) {
    const silenced = gateCommandMissNotice({
      command: `npm run ${flag} test:accept`, sourceCommit: "de91d6c0", origin: null,
      miss: { kind: "inner", name: "test:accept", by: "被测快照 package.json 的 scripts",
        entryResolved: false, withheld: "no-runner-claim",
        evidence: "起跑前核过 被测快照 package.json 的 scripts：没有 test:accept" },
    });
    assert.ok(silenced.includes(`把这条命令里的「${flag}」去掉再点一次验收`),
      `${flag}: 要指名是哪个开关堵的嘴`);
    assert.equal(/\*\*|`/.test(silenced), false, `${flag}: 结论要纯文本,开关名也不许裹反引号`);
    assert.match(silenced, /并没说它解析不出这个名字/, `${flag}: 缺的那一件照说`);
    assert.equal(/workspace 和 location/.test(silenced), false,
      `${flag}: 缺的不是落点那一件,别把别档的出路搬过来`);
    assert.match(silenced, /更不敢说这条红不用你修/, `${flag}: 判据不许因为给了出路就松一档`);
    const otherTier = gateCommandMissNotice({
      command: `npm run ${flag} test:accept`, sourceCommit: "de91d6c0", origin: null,
      miss: { kind: "inner", name: "test:accept", by: "被测快照 package.json 的 scripts",
        entryResolved: false, withheld: "foreign-output",
        evidence: "起跑前核过 被测快照 package.json 的 scripts：没有 test:accept" },
    });
    assert.equal(/去掉再点一次验收/.test(otherTier), false,
      `${flag}: 缺的不是 runner 的嘴时，去掉开关也补不上，别乱给`);
  }

  const unknownStart = innerOf({ entryResolved: null });
  assert.match(unknownStart, /这一层核不出来/, "没核到就不许说它跑起来了");
  assert.equal(/确实跑起来了/.test(unknownStart), false, "没核到就不许说它跑起来了");

  const sameName = innerOf({ name: "test:accept", entryResolved: null, sameName: true,
    evidence: 'npm error Missing script: "test:accept"' });
  assert.match(sameName, /可能不是一回事/, "同名那一条必须说破两件事可能不是一回事");
  assert.match(sameName, /不敢断定它有没有跑起来/, "没核实到就明说不敢断定");
  assert.equal(/一行都没跑到/.test(sameName), false, "同名不等于顶层缺失（审查二 F1 反例①）");

  // ── 回流模板三副面孔。两件事分开授权（第 1 轮审查 F2 + 第 3 轮审查 F2）：
  //    ① 测试有没有启动 → 看 failure,不看「有没有诊断文字」;
  //    ② 该不该让 agent 改代码 → 看归因。免修只许由**核实过**的 not-mine 授权。
  const promptOf = (failure: "command_missing" | "exit_code", diagnosis: string,
    missAttribution?: AcceptGateMissAttribution | null) => gateFailurePrompt({
    command: "npm run test:accept", summary: "未通过", logPath: "/tmp/gate.log", tail: "…",
    cwd: "/tmp/snap", sourceCwd: "/tmp/ws", failure, diagnosis, missAttribution,
  });
  const innerPrompt = promptOf("exit_code", inner);
  assert.match(innerPrompt, /定位到底是哪一条红的/, "inner 走的是普通「去修」那一版");
  assert.equal(innerPrompt.includes("不要为这件事改任何代码"), false, "inner 不许被交成「不许修」");
  assert.ok(innerPrompt.includes(inner), "inner 的那段观察仍要附上去 —— 它是定位线索");
  assert.equal(innerPrompt.includes("没能启动"), false, "inner 不是「没能启动」");
  // 即便带着一段 command_missing 的结论文字,归因是 exit_code 的那一种也不许换面孔。
  assert.equal(promptOf("exit_code", defined, "not-mine").includes("不要为这件事改任何代码"), false,
    "免修由失败类型 + 归因共同授权,光有结论文字不算");

  const missingPrompt = promptOf("command_missing", defined, "not-mine");
  assert.match(missingPrompt, /没能启动/, "① 这一种的标题是「没能启动」");
  assert.match(missingPrompt, /不要为这件事改任何代码/, "核实过不是它删的,才给免修指令");
  assert.match(missingPrompt, /在开工基线上也没有，这一条也核过了/, "免修的依据要写在面孔里");
  assert.match(missingPrompt, /转述给用户/);
  assert.match(missingPrompt, /以上面那段结论为准/, "出路和核实档位都由结论说,模板不自己下判断");
  assert.equal(/这条红跟你这次的改动无关/.test(missingPrompt), false,
    "缺失推不出「与本次改动无关」（审查二 F1 末条）");
  assert.equal(missingPrompt.includes("定位到底是哪一条红的"), false, "普通红那一版的措辞不该出现在这一种上");

  // 归因没核出来：未启动这件事照说（它核过了），但**不许**给免修令 —— 任务自己把验收脚本
  //    删了、而目标 ref 恰好读不到时，免修令会把 agent 按在原地（第 3 轮审查 F2）。
  for (const attribution of [null, undefined, "unknown"] as const) {
    const unknownPrompt = promptOf("command_missing", notice({ origin: null }), attribution);
    assert.match(unknownPrompt, /没能启动/, "未启动这件事是核过的,照说");
    assert.match(unknownPrompt, /解析不出来/, "照说它点名要跑的东西没解析出来");
    assert.equal(unknownPrompt.includes("不要为这件事改任何代码"), false,
      `归因=${attribution}：没核出来就不许发免修令`);
    assert.match(unknownPrompt, /是不是你这次改动把它弄没的/, "要让它先去核归因");
    assert.match(unknownPrompt, /改回来或同步改配置/, "核下来是自己弄没的,就该去改");
    assert.match(unknownPrompt, /转述给用户/, "核下来无关,再转述给用户");
    assert.equal(unknownPrompt.includes("定位到底是哪一条红的"), false, "它也不是普通红那一种");
    assert.match(unknownPrompt, /别为了「让它跑起来」去凭空补一个脚本/, "补个空脚本是伪造放行条件");
  }
  console.log("✅ 门禁结论措辞（存在性档位 / inner 四种 / 出路不预测合并结果 / 回流三副面孔）通过");
}
