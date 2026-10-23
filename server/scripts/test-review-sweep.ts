// 「一次查全」那一节的回归：契约表自身、历史发现清单的抽取与成文、以及这两样有没有
// 真的被塞进各条审查 prompt。
//
// 为什么值得单独一条测试：这一整套都是**提示词**，没有任何运行期行为会因为它丢了而报错
// ——常量整段删掉，审查照样跑完、报告照样落盘，只是又变回「一轮报一条」。所以能钉住的
// 只有「字真的在那段 prompt 里」和「抽取函数认得真实报告的两种形状」。
// 跑:npm -w server run test:review-sweep
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-review-sweep-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

try {
  const { REVIEW_SWEEP_PROTOCOL, REVIEW_SWEEP_REMINDER, SWEEP_RULES } = await import("../src/review-sweep.js");
  const { extractReportFindings, priorFindingsSection } = await import("../src/review-history.js");
  const { repairPrompt, reviewReminderFor, verifyReminderFor } = await import("../src/review-prompts.js");
  const {
    assertCarriesClassRepairNote,
    assertCarriesSweepReminder,
    assertSweepRuleTable,
  } = await import("./review-sweep-rules.js");

  // ── ① 契约表自身 ─────────────────────────────────────────────────────────────
  assertSweepRuleTable();
  // 停机条件是这份协议的全部意义：丢了它，剩下的话术只是「多找几条」的客套。
  assert.match(REVIEW_SWEEP_PROTOCOL, /该扫的面扫完了/, "完整版必须写明停机条件");
  assert.match(REVIEW_SWEEP_PROTOCOL, /这是类问题/, "完整版必须给出「报类」的固定说法");
  assert.match(REVIEW_SWEEP_REMINDER, /这是类问题/, "缩略版也必须留住「报类」那四个字");

  const reuseRule = SWEEP_RULES.find((rule) => rule.id === "执行者回归结果复用");
  assert.ok(reuseRule?.short, "执行者回归结果复用必须同时进入完整协议与续跑提醒");
  assert.doesNotMatch(reuseRule.full, /read_task_transcript/, "不能依赖会截断且没有结果的对话记录");
  for (const text of [reuseRule.full, reuseRule.short]) {
    assert.match(text, /本轮后端证据清单.*reusable=true.*执行者结果/, "只复用后端核验的本轮执行者结果");
    assert.match(text, /不再重复运行/, "不得要求审查者重复执行已有回归");
    assert.match(text, /失败.*不得当作通过/, "已有失败结果不能被复用成通过");
    assert.match(text, /缺失.*失效.*未覆盖.*补跑/, "缺失、失效或未覆盖时只补跑必要检查");
    assert.match(text, /技术明细.*复用来源.*命令.*结果/, "技术明细必须列明复用依据");
    assert.match(text, /不免除独立代码审查与必要的行为验证/, "续跑不能漏掉独立审查和行为验证");
  }
  assert.doesNotMatch(REVIEW_SWEEP_PROTOCOL, /回归面[^\n]*—— 跑测试/, "回归扫描义务不能再无条件要求重新跑测试");

  // ── ② 现象行抽取：全库真实报告只有两种形状 ──────────────────────────────────
  // 新格式（275 份）：摘要契约要求每条阻塞问题以「你会遇到」起头。
  const modern = [
    "# 第 10 轮逻辑审查报告", "", "## 结论", "",
    "**能不能验收**：不能 —— 有 2 条必须先修。", "",
    "**必须修的问题**：", "",
    "### 存储短暂失败后恢复可写会丢弃悬账", "",
    "- 你会遇到：切回项目后仍是旧字幕，烧录按钮却可用。",
    "- 为什么：探针只证明现在能写。",
    "- 建议怎么修：保留内存副本到明确结清。", "",
    "### 第二条", "",
    "- **你会遇到**：刷新后输入框被清空。", "",
    "## 已验证的正向行为", "", "- npm test 全绿。",
  ].join("\n");
  assert.deepEqual(extractReportFindings(modern), [
    "切回项目后仍是旧字幕，烧录按钮却可用。",
    "刷新后输入框被清空。",
  ], "新格式应只抽「你会遇到」那几行，且不把正向行为一节算进来");

  // 老格式（库里 1103 份）：没有锚点，按「条目标记 + 发现节容器」抽。下面四种形状全是
  // 全库真实报告里数出来的，按标题层级抽会在后两种上双向翻车（见 review-history.ts 注释）。
  const legacy = [
    "# 第 3 轮报告", "", "结论：**verify_failed**。", "", "## Finding", "",
    "### P1：孤儿写租约在 GET 途中到期时会提前放行烧录", "", "位置：`web/src/refresh.ts:198-209`", "",
    "## 已验证的正向行为与自动化检查", "", "### 已验证：npm run build 通过", "",
    "## 浏览器通道与清理", "", "### 清场记录", "",
  ].join("\n");
  assert.deepEqual(
    extractReportFindings(legacy),
    ["P1：孤儿写租约在 GET 途中到期时会提前放行烧录"],
    "发现节下的条目要抽到，「已验证」「清场」这类小节要滤掉",
  );

  // `ca9rtmb6aFAP/round-5` 的形状：真发现是**二级**标题，它的证据才是三级。
  const h2Finding = [
    "# 第 5 轮逻辑审查报告", "", "## 结论", "", "## 审查范围", "",
    "## P1：通道基线只按世代号验盘，同号异内容会错误放行烧录", "",
    "### 代码证据", "", "### Vitest 最小复现", "", "### 真实浏览器复现", "",
    "## 其他验证", "", "## 清理与最终状态", "",
  ].join("\n");
  assert.deepEqual(
    extractReportFindings(h2Finding),
    ["P1：通道基线只按世代号验盘，同号异内容会错误放行烧录"],
    "二级标题的发现要抽到，三级的证据小节不许冒充发现",
  );

  // `Fa8UBhSrhHc1/round-9` 的形状：`## 缺陷：…` 自带标记，不能被当成「缺陷」那一节的容器
  // ——当成容器就会把它底下的原因/影响/建议搬成三条发现，而真发现被丢掉。
  const markedWithBody = [
    "# 第 9 轮逻辑审查报告", "", "## 结论", "",
    "## 缺陷：generation 在正式发布后才写且失败时 fail-open，ABA 防护仍可丢失", "",
    "### 原因", "", "### 真实子进程复现 1：generation 写失败仍成功退出", "",
    "### 影响", "", "### 建议", "", "## 实际验证", "",
  ].join("\n");
  assert.deepEqual(
    extractReportFindings(markedWithBody),
    ["缺陷：generation 在正式发布后才写且失败时 fail-open，ABA 防护仍可丢失"],
    "自带标记的标题是发现本体，不是容器",
  );

  // `ca9rtmb6aFAP/round-6` 的形状：那一轮通过，一条发现都没有，不许把验证步骤搬成发现。
  const verifiedRound = [
    "# 第 6 轮逻辑审查报告", "", "## 结论", "", "## 代码审查", "", "## 真实浏览器验证", "",
    "### 通道选择", "", "### 同世代不同内容的通道碰撞", "", "### 冲突后清空存储", "",
  ].join("\n");
  assert.deepEqual(extractReportFindings(verifiedRound), [], "通过轮次的验证步骤不是发现");
  // 「问题分析方法」这类标题不带分隔符也不带编号，不算条目标记。
  assert.deepEqual(extractReportFindings("## 问题分析方法\n\n正文"), [], "标记必须跟编号或分隔符");
  assert.deepEqual(extractReportFindings(""), [], "空报告不许编一行出来");
  assert.deepEqual(
    extractReportFindings("# 报告\n\n结论：通过，没有发现问题。\n"),
    [],
    "通过且无小节的报告抽不到东西，就该是空的",
  );
  const long = extractReportFindings(`- 你会遇到：${"很长的现象".repeat(60)}`);
  assert.ok(long[0]!.length <= 111, `单条现象行必须截断，现在 ${long[0]!.length} 字`);
  // 截断要留记号：不留的话被切掉半句的现象读起来像一句完整的话（全库 2.6% 的条目会撞上限）。
  assert.ok(long[0]!.endsWith("…"), "截断必须留省略号");
  assert.ok(!extractReportFindings("- 你会遇到：短的。")[0]!.endsWith("…"), "没截断就不许加省略号");

  // 围栏里的写法示例不是发现。真实来源：`P5EH_BPGxLt-` 那条链的报告在讲报告格式本身，
  // 正文里原样贴了「你会遇到：保存后刚写的内容消失。」这种占位句（全库 7 份、15 行）。
  const fenced = [
    "# 报告", "", "## 结论", "", "**必须修的问题**：", "",
    "- 你会遇到：真发现——保存后页面不刷新。", "",
    "写法示例：", "", "```markdown", "### 示例标题",
    "- 你会遇到：保存后刚写的内容消失。", "- 为什么：保存请求没有落盘。", "```", "",
    "~~~", "- 你会遇到：另一种围栏里的示例。", "~~~", "",
  ].join("\n");
  assert.deepEqual(
    extractReportFindings(fenced),
    ["真发现——保存后页面不刷新。"],
    "围栏内的示例句不许当成发现搬给下一轮",
  );
  // 只有围栏里的示例时，整份报告抽不到东西 —— 不许回落到标题那条路去捞围栏里的标题。
  assert.deepEqual(
    extractReportFindings("# 报告\n\n```\n- 你会遇到：示例。\n### P1：围栏里的标题\n```\n"),
    [],
    "围栏里的带标记标题同样不算发现",
  );

  // 围栏判据必须按 CommonMark 来，不许自己简化成「记号是哪种」。第 1 轮审查在真实报告
  // `P5EH_BPGxLt-/.../dB45LYOzuxnx/round-6/report.md:74` 上复现了简化版的两头错：
  // 长围栏里的短围栏被当成闭栏（示例漏成发现），闭栏又被当成新开栏（真发现被整段吞掉）。
  // 预期值不是另写一份同样的简化算法，而是逐条按 CommonMark 的规则手写，并在全库 1553 份
  // 报告上跟 web 侧那个真解析器（`mdast-util-from-markdown`）逐份对照过（0 份不一致）。
  assert.deepEqual(
    extractReportFindings([
      "- 你会遇到：真发现在围栏之前。", "", "````md", "### 写法示例", "", "```text",
      "你会遇到：这里填现象", "```", "````", "", "- 你会遇到：真发现在围栏之后。",
    ].join("\n")),
    ["真发现在围栏之前。", "真发现在围栏之后。"],
    "长围栏包短围栏：短的不许当闭栏，合法闭合之后的真发现不许被吞",
  );
  assert.deepEqual(
    extractReportFindings(["````", "内容", "```js 这行不是闭栏", "````",
      "- 你会遇到：合法闭合之后的真发现。"].join("\n")),
    ["合法闭合之后的真发现。"],
    "闭栏那行记号后面只能是空白；带 info string 的不是闭栏",
  );
  assert.deepEqual(
    extractReportFindings(["~~~~", "你会遇到：波浪号围栏里的示例", "~~~", "~~~~",
      "- 你会遇到：真发现。"].join("\n")),
    ["真发现。"],
    "波浪号围栏同一套规则",
  );
  assert.deepEqual(
    extractReportFindings(["- 你会遇到：真发现。", "```", "你会遇到：没闭合的围栏一直到末尾"].join("\n")),
    ["真发现。"],
    "没闭合的围栏吃到文件末尾（CommonMark 如此规定）",
  );
  assert.deepEqual(
    extractReportFindings(["- 你会遇到：真发现。", "``` `inline` 反引号 info string 不是开栏"].join("\n")),
    ["真发现。"],
    "反引号开栏的 info string 里不许有反引号，否则那行只是正文",
  );

  // 第 2 轮审查构造的五种**合法 Markdown** 形态。它们的共同成因是「一个全文件的 open 状态
  // 表达不了块容器」，所以判据整体换到解析树上（见 review-history.ts 的 reportBlocks 注释）；
  // 这几条留在这里当契约，换不换实现都得过。预期值由审查侧的 remark 语法树独立给出。
  assert.deepEqual(
    extractReportFindings(["你会遇到：真的问题", "", "> ```md", "> 你会遇到：引文里的写法示例", "> ```"].join("\n")),
    ["真的问题"],
    "引用里的围栏代码不算发现",
  );
  assert.deepEqual(
    extractReportFindings(["- ```md", "  你会遇到：列表里的写法示例", "  ```", "", "你会遇到：列表外真的问题"].join("\n")),
    ["列表外真的问题"],
    "列表首行开栏：示例不算发现，列表外的真发现也不许被吞",
  );
  assert.deepEqual(
    extractReportFindings(["你会遇到：真的问题", "", "    你会遇到：缩进代码里的写法示例"].join("\n")),
    ["真的问题"],
    "四空格缩进代码也是代码",
  );
  assert.deepEqual(
    extractReportFindings([
      "- 写法示例", "", "  ```md", "  你会遇到：列表里的写法示例", "",
      "## 后续发现", "你会遇到：列表外真的问题",
    ].join("\n")),
    ["列表外真的问题"],
    "列表内未显式闭合的围栏到容器结束即闭合，后面的真发现不许丢",
  );
  assert.deepEqual(
    extractReportFindings(["```md", "``` \u00a0", "你会遇到：仍在代码块内，不是真发现", "```",
      "你会遇到：真的问题"].join("\n")),
    ["真的问题"],
    "闭栏记号后只能跟空格/制表符；NBSP 不算（JS 的 trim() 认它是空白，CommonMark 不认）",
  );

  // 引用里的**正文**同样不算：那是别人说过的话（上一轮报告、别份报告的片段），不是这一份
  // 报告的发现。真实数据上这条零代价 —— 全库 1556 份报告新旧实现结果完全一致。
  assert.deepEqual(
    extractReportFindings(["你会遇到：真的问题", "", "> 你会遇到：上一轮报告里说过的话"].join("\n")),
    ["真的问题"],
    "引用里的现象行不算这一份报告的发现",
  );
  assert.deepEqual(
    extractReportFindings(["> ## 缺陷", "> ### P1：引用里的旧条目", "", "## Finding", "### P2：本报告的条目"].join("\n")),
    ["P2：本报告的条目"],
    "引用里的标题不参与「发现节容器」判定",
  );

  // 「你会遇到：」当行为空、内容写在下一行（真实报告里有这种写法）。
  assert.deepEqual(
    extractReportFindings("- 你会遇到：\n  打开页面后按钮是灰的。\n- 为什么：状态没同步。"),
    ["打开页面后按钮是灰的。"],
    "现象写在下一行时要跟过去拿",
  );
  assert.deepEqual(
    extractReportFindings("- 你会遇到：\n- 为什么：状态没同步。"),
    [],
    "下一行是另一条契约行时，说明这一条压根没写现象，不许把「为什么」当现象",
  );

  // 摘要 5 条上限要求把溢出条目的完整三行再写进技术明细，于是同一条现象在一份报告里
  // 出现两次（全库 4 份）。同报告内去重，跨轮不去 —— 跨轮重复是复发。
  assert.deepEqual(
    extractReportFindings("- 你会遇到：同一条。\n\n## 技术明细\n\n- 你会遇到：同一条。"),
    ["同一条。"],
    "同一份报告里重复的条目只留一条",
  );

  // ── ③ 历史清单成文 ──────────────────────────────────────────────────────────
  assert.equal(priorFindingsSection([]), "", "没有历史时不塞空小节");
  assert.equal(
    priorFindingsSection([{ label: "第 1 轮", conclusion: "verified", reportPath: "/r/1.md", findings: [] }]),
    "",
    "通过的轮次抽不到现象时不塞小节",
  );
  // 没通过却抽不到现象行（全库 301 份）：整轮藏掉等于把最该看的那几轮删了，所以留一行
  // 指向报告，且只说「没抽出来」，不编内容。
  const fallback = priorFindingsSection([
    { label: "第 2 轮", conclusion: "verify_failed", reportPath: "/r/2.md", findings: [] },
  ]);
  assert.match(fallback, /现象行没抽出来，整份报告在 \/r\/2\.md/, "失败轮次不许被整轮藏掉");
  assert.match(fallback, /第 2 轮 · verify_failed/, "兜底那一行也要带轮次和结论");
  const section = priorFindingsSection([
    { label: "第 1 条审查链第 2 轮", conclusion: "verify_failed", reportPath: "/r/a.md", findings: ["多开页会覆盖脚本"] },
    { label: "第 3 轮", conclusion: "verify_failed", reportPath: "/r/b.md", findings: ["刷新后结果写错", "复制标签页也会写错"] },
  ]);
  assert.match(section, /此前报过的发现（3 条/, "条数要如实报");
  assert.match(section, /第 1 条审查链第 2 轮 · verify_failed〕多开页会覆盖脚本/, "轮次标签和结论要跟着现象一起搬");
  assert.match(section, /\/r\/a\.md[\s\S]*\/r\/b\.md/, "报告全文路径要给出去");
  assert.match(section, /第 N 个触发组合/, "这一节的用处必须写明是判同类");
  assert.match(section, /还没修好|又复发/, "必须留下「旧条目没修好照样报」这条出路，否则这一节会变成消音");

  // 超出内联上限时怎么分名额。按「取最近 24 条」分的话，`6KCDi5veaSP8`（35 轮 61 条）
  // 会被最新几轮占满、前 20 轮一条不剩 —— 而定义「类」的恰恰是早期那几轮。
  //
  // ① 轮数没超上限：每轮至少留最严重的那条（报告按严重度排序，第一条就是），名额剩下的
  //    给最近几轮。
  const many = priorFindingsSection(Array.from({ length: 10 }, (_, index) => ({
    label: `第 ${index + 1} 轮`,
    conclusion: "verify_failed",
    reportPath: `/r/${index + 1}.md`,
    findings: [`现象 ${index * 3 + 1}`, `现象 ${index * 3 + 2}`, `现象 ${index * 3 + 3}`],
  })));
  assert.match(many, /另外 6 条没有内联/, "没内联的条数要说出来");
  for (let round = 1; round <= 10; round += 1) {
    assert.match(many, new RegExp(`〔第 ${round} 轮 · verify_failed〕现象 ${(round - 1) * 3 + 1}`),
      `第 ${round} 轮最严重的那条必须留住`);
  }
  assert.match(many, /现象 30/, "名额剩下的给最近几轮");
  assert.doesNotMatch(many, /现象 2$/m, "最早那几轮的次要条目才是被省掉的");
  assert.doesNotMatch(many, /一条都没列出/, "每轮都列到了，就不许说有轮次完全没列出");

  // ② 轮数本身超过上限：按轮次均匀取样，首尾必须在；没列出条目的那几轮的报告路径
  //    **排在最前**，列不下的说清还有几份、在哪个目录下（原先写「在下面那几份报告里」却
  //    列的全是已内联的轮次，全库 20 个有省略的任务里 19 个都在说这句假话）。
  const huge = priorFindingsSection(Array.from({ length: 40 }, (_, index) => ({
    label: `第 ${index + 1} 轮`,
    conclusion: "verify_failed",
    reportPath: `/data/runs/T/free-review/run-${index + 1}/round-1/report.md`,
    findings: [`现象 ${index + 1}`],
  })));
  assert.match(huge, /按轮次均匀取样/, "取样方式要讲清楚");
  assert.match(huge, /〔第 1 轮 · verify_failed〕现象 1$/m, "首轮定义类，必须在");
  assert.match(huge, /〔第 40 轮 · verify_failed〕现象 40$/m, "最近一轮是现状，必须在");
  assert.match(huge, /一条都没列出/, "完全没列出的轮次要点名");
  assert.match(huge, /另有 \d+ 份没有列出，在 \/data\/runs\/T\/free-review 下/,
    "路径列不下时要说清还有几份、在哪个目录下");
  const inlined = [...huge.matchAll(/〕现象 (\d+)/g)].map((m) => Number(m[1]));
  assert.equal(inlined.length, 24, `内联条数应等于上限，现在 ${inlined.length}`);
  // 没列出条目的轮次，它的路径必须真的能在清单里找到（或被「另有 N 份」那句兜住）。
  const listedPaths = huge.split("报告全文")[1]!;
  assert.ok(
    [1, 40].every((round) => inlined.includes(round)),
    "首尾两轮必须内联",
  );
  assert.ok(
    listedPaths.includes("/data/runs/T/free-review/run-2/round-1/report.md")
      || /另有 \d+ 份/.test(listedPaths),
    "被取样掉的轮次要么路径在清单里，要么被「另有 N 份」兜住",
  );

  // ③ 判据是「这一轮有没有条目被省掉」，不是「整轮有没有条目」：保住第一条、省掉第二三条
  //    的那几轮，报告路径同样是读不到那几条的唯一去处（真实数据上原先有 15 个任务、72 个
  //    轮次既没内联、路径也没列、还不触发目录兜底）。
  const partial = priorFindingsSection([
    { label: "第 1 轮", conclusion: "verify_failed", reportPath: "/r/first.md",
      findings: Array.from({ length: 20 }, (_, i) => `头轮现象 ${i + 1}`) },
    { label: "第 2 轮", conclusion: "verify_failed", reportPath: "/r/second.md",
      findings: ["尾轮现象 A", "尾轮现象 B", "尾轮现象 C", "尾轮现象 D", "尾轮现象 E", "尾轮现象 F"] },
  ]);
  assert.match(partial, /〕头轮现象 1$/m, "第 1 轮最严重那条要留住");
  assert.match(partial, /另外 \d+ 条没有内联/, "被省掉的条数要说出来");
  assert.ok(partial.includes("/r/first.md"), "第 1 轮有条目被省掉，它的报告路径必须列出来");

  // Windows 形状路径：分隔符写死 `/` 会让兜底退化成「在 / 下」，一句指不到任何地方的指路。
  // 纯字符串处理、没有平台分支，所以喂 win32 形状的字符串就验到底了（真机 192.168.1.187
  // 第 1 轮审查时 EHOSTUNREACH，未做原生复演）。
  const win = priorFindingsSection(Array.from({ length: 40 }, (_, index) => ({
    label: `第 ${index + 1} 轮`,
    conclusion: "verify_failed",
    reportPath: `D:\\ai_workspace\\ash\\data\\runs\\T\\free-review\\run-${index + 1}\\round-1\\report.md`,
    findings: [`现象 ${index + 1}`],
  })));
  assert.match(
    win,
    /另有 \d+ 份没有列出，在 D:\\ai_workspace\\ash\\data\\runs\\T\\free-review 下/,
    "Windows 形状路径的公共目录要按反斜杠算，不许退化成「在 / 下」",
  );

  // ── ④ 真的被塞进了各条 prompt ───────────────────────────────────────────────
  assertCarriesSweepReminder(verifyReminderFor("t-1", 2), "自动验证续跑提醒");
  assertCarriesSweepReminder(
    reviewReminderFor({ id: "legacy-review", reviewOf: "t-1", reviewRound: 2 }),
    "历史审查续跑提醒",
  );
  // 修复提示那一侧：不带这句话，「不要扩大原任务边界」会把报出来的类改回成一个补丁。
  const repair = repairPrompt({
    target: { id: "t-1", useWorktree: false, worktreeBase: null } as Parameters<typeof repairPrompt>[0]["target"],
    round: 2,
    reviewTaskId: null,
    coverage: null,
    autoNext: true,
  });
  assertCarriesClassRepairNote(repair, "自动验证未通过的修复提示");
  assert.match(repair, /不要扩大原任务边界/, "边界约束仍然在——类问题是它的例外，不是取消它");

  console.log("✓ review sweep contract");
} finally {
  rmSync(root, { recursive: true, force: true });
}
