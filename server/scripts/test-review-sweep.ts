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
  const { REVIEW_SWEEP_PROTOCOL, REVIEW_SWEEP_REMINDER } = await import("../src/review-sweep.js");
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
  assert.ok(long[0]!.length <= 110, `单条现象行必须截断，现在 ${long[0]!.length} 字`);

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

  // 超出内联上限时：保留**最近的**，并如实说省掉了几条。
  const many = priorFindingsSection(Array.from({ length: 10 }, (_, index) => ({
    label: `第 ${index + 1} 轮`,
    conclusion: "verify_failed",
    reportPath: `/r/${index + 1}.md`,
    findings: [`现象 ${index * 3 + 1}`, `现象 ${index * 3 + 2}`, `现象 ${index * 3 + 3}`],
  })));
  assert.match(many, /（更早的 6 条没有内联/, "省掉的条数要说出来");
  assert.match(many, /现象 30/, "最近那几条必须留住——活着的类在后面");
  assert.doesNotMatch(many, /现象 1〕|〕现象 1$/m, "最早那几条才是被省掉的");

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
