// 「发给模型的那几类消息，渲染出来有多大」——**体积棘轮**。
//
// 盯的是产物不是源码（`scripts/root-budget.mjs` 盯的是根文件字节数，这里盯的是真正注入
// 模型的那串字）。理由：这些文本由十几个常量拼起来，一条规则从 A 文件搬到 B 文件，源码
// 两边都动、注入体积一个字节没少；而执行者每回合读的 token 从 8 月的 5.2M 涨到 10 月的
// 39.7M，涨的就是这一摞。
//
// **棘轮怎么起作用**：下面那张预算表是硬编码的数字。想让某条消息变长，就必须在 diff 里
// 改掉一个数 —— 那一行会被人看见、被问一句「为什么」。不改数字的增长一律在这里红掉。
//
// 配套的两张表同样是棘轮：
// - `DYNAMIC_CAPS` 盯**动态段**（已裁定意见的重播、历史发现清单）。它们随轮次累积而涨，
//   和「措辞写长了」是两种病，所以分开量：`<id>` 减去对应的 `-bare` 变体就是动态段。
// - `PLACEMENT` 盯**单源**：每一块判据（越界判据、类问题边界、summary 示范…）只许出现在
//   声明的那几份样本里，且每份样本里至多一次。原先靠「两处同文 + 回归钉死原样出现」防漂移，
//   代价是同一段话在一条消息里出现两三遍；现在改成「只有一处有全文，别处只留指针」，
//   这张表就是那个「一处」的落款。多抄一份、搬错地方、或者悄悄删掉，都在这里红。
//
// 用法：
//   tsx server/scripts/test-prompt-budget.ts            # 跑闸
//   tsx server/scripts/test-prompt-budget.ts --dump DIR # 把金样写进 DIR，供改动前后肉眼对比
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-prompt-budget-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

/**
 * 每份样本的字节上限（UTF-8；中文一个字三字节）。
 *
 * 数字取「当前实测值 + 一点余量」，不是拍脑袋的理想值。想调大先问一句：是这条消息真的
 * 多了一条规则，还是又把一段论证写进了正文？论证的去处是代码注释和 `docs/incidents.md`。
 */
const BUDGETS: Record<string, number> = {
  // ── 审查任务书 ───────────────────────────────────────────────────────────────
  // `-bare` = 同一条消息、但任务身上没有已裁定意见也没有历史发现，量的是**正文**。
  // 剩下的 7.3KB 几乎全是审查契约本身（六面扫描 + 报告格式 + 验证义务），再压就是删规则。
  "review/dispatch-bare": 7500,
  "review/dispatch-logic": 12400,
  "review/dispatch-syntax": 12400,
  "review/resume": 2700,
  // ── 修复交接 ─────────────────────────────────────────────────────────────────
  // 正文里最大的一块是 `CLASS_PROBLEM_BOUNDARY`（三种处置，673B）。驳回那条路只留指针，
  // 判据全文在 `dispute_review` 工具说明里（它本来就常驻每个回合的上下文）。
  "repair/auto-bare": 1900,
  "repair/auto": 3000,
  "repair/manual": 3100,
  "repair/manual-upheld": 3150,
  "debate/segment": 1500,
  "debate/final": 1600,
  // ── 每回合都要发的那几段 ─────────────────────────────────────────────────────
  "turn/completion-protocol-free": 950,
  "turn/completion-protocol-normal": 1100,
  "turn/completion-reminder-free": 800,
  "turn/follow-up-reminder-free": 1000,
  // 浏览器策略**不做条件省略**（误判漏注入的代价大于多发几百字），只压文本。
  "browser/full-ungranted": 2300,
  "browser/full-granted": 2300,
  "browser/reminder-granted": 1100,
  "accept/gate-failure": 1450,
  // ── MCP 工具清单：每一条都常驻执行者的每一个回合 ─────────────────────────────
  "mcp/accept_task": 1750,
  "mcp/answer_question": 600,
  "mcp/ask_question": 1750,
  "mcp/batch_create_tasks": 3100,
  "mcp/complete_task": 1450,
  "mcp/create_group": 400,
  "mcp/create_queue": 220,
  "mcp/create_task_chain": 3350,
  "mcp/debate_reply": 1400,
  "mcp/dispatch": 2100,
  // 三块判据全文的唯一落脚处（见 PLACEMENT），所以它理应是工具里偏大的一条。
  "mcp/dispute_review": 3400,
  "mcp/get_queue": 160,
  "mcp/get_task": 130,
  "mcp/list_groups": 360,
  "mcp/list_monitors": 430,
  "mcp/list_tasks": 500,
  "mcp/patch_task": 1100,
  "mcp/pause_task": 950,
  "mcp/queue_insert": 220,
  "mcp/queue_remove": 190,
  "mcp/queue_reorder": 270,
  "mcp/read_task_transcript": 1150,
  "mcp/report_stage": 2050,
  "mcp/requeue_task": 560,
  "mcp/resolve_group": 530,
  "mcp/resolve_project": 250,
  "mcp/run_group": 320,
  "mcp/run_task": 340,
  // 「怎么登记回归」的机制住在这里而不在每轮前言（见 mcp/src/tools/monitor.ts 文件头）：
  // 一份工具说明换掉每一轮都重发一遍，所以它大得有理由，但仍然要有个顶。
  "mcp/start_monitor": 5200,
  "mcp/stop_monitor": 850,
  "mcp/stop_task": 480,
};

/** 全部样本加起来的顶。单条都压着、总量却靠「多加几份样本」涨回去，也算退步。 */
const TOTAL_BUDGET = 94_000;

/**
 * 动态段的上限：`<完整样本> - <同名 -bare 样本>`。
 *
 * 它随「这个任务攒了多少轮裁定 / 多少条历史发现」涨，跟措辞长短无关，所以单独量。
 * 样本里种了两条已裁定意见 + 两条历史发现，是个偏多但真实会出现的形状。
 */
const DYNAMIC_CAPS: Array<{ full: string; bare: string; cap: number; what: string }> = [
  { full: "review/dispatch-logic", bare: "review/dispatch-bare", cap: 5200, what: "审查任务书的裁定重播 + 历史发现" },
  { full: "repair/auto", bare: "repair/auto-bare", cap: 1200, what: "修复交接的裁定重播（执行者侧只给一行摘要 + 全文路径）" },
];

/**
 * 单源落款：每块判据允许出现在**哪几份**样本里。
 *
 * 多一份、少一份、或者在同一份里出现两次，都红。`REGRESSION_POLICY` 这类「口径」允许
 * 多处出现（执行者面和审查者面本来就是两条消息），但同一条消息里只许讲一遍。
 */
const PLACEMENT: Array<{ name: string; where: string[] }> = [
  { name: "DEFER_BOUNDARY_CRITERION", where: ["mcp/dispute_review"] },
  { name: "DEFER_REASON_FIELD_GUIDE", where: ["mcp/dispute_review"] },
  { name: "PLAIN_SUMMARY_EXAMPLE", where: ["mcp/dispute_review"] },
  { name: "PLAIN_SUMMARY_GUIDE", where: ["mcp/debate_reply", "mcp/dispute_review"] },
  {
    name: "CLASS_PROBLEM_BOUNDARY",
    where: ["repair/auto-bare", "repair/auto", "repair/manual", "repair/manual-upheld"],
  },
  { name: "GATE_FAILURE_REGRESSION_CARVE_OUT", where: ["accept/gate-failure"] },
  {
    name: "REVIEW_VALIDATION_REQUIREMENT",
    where: ["review/dispatch-bare", "review/dispatch-logic", "review/dispatch-syntax", "mcp/report_stage"],
  },
  // 审查者面的一句话口径：**只**在没有完整验证义务的那条消息里出现（续跑）。派审正文里
  // 有全文，再讲一遍就是同一条消息里两份。
  { name: "REVIEWER_REGRESSION_CLAUSE", where: ["review/resume"] },
  {
    name: "EXECUTOR_REGRESSION_RECORDING",
    where: ["turn/completion-protocol-free", "turn/completion-protocol-normal",
      "turn/completion-reminder-free", "turn/follow-up-reminder-free"],
  },
  {
    name: "REGRESSION_POLICY",
    where: ["review/dispatch-bare", "review/dispatch-logic", "review/dispatch-syntax",
      "turn/completion-protocol-free", "turn/completion-protocol-normal",
      "turn/completion-reminder-free", "turn/follow-up-reminder-free",
      "mcp/report_stage", "mcp/start_monitor"],
  },
];

const dumpTo = process.argv.includes("--dump") ? process.argv[process.argv.indexOf("--dump") + 1] : null;

try {
  const { renderPromptSamples, sizeOf } = await import("./prompt-budget-samples.js");
  const shared = (await import("@ash/shared/free-workflow")) as unknown as Record<string, string>;
  const samples = await renderPromptSamples(root);
  const size = new Map(samples.map((sample) => [sample.id, sizeOf(sample.text)]));

  if (dumpTo) {
    mkdirSync(dumpTo, { recursive: true });
    const index: string[] = [];
    for (const { id, text } of samples) {
      writeFileSync(join(dumpTo, `${id.replace(/\//g, "__")}.txt`), text);
      index.push(`${String(sizeOf(text)).padStart(6)}  ${id}`);
    }
    index.push(`${String([...size.values()].reduce((a, b) => a + b, 0)).padStart(6)}  == TOTAL`);
    writeFileSync(join(dumpTo, "_index.txt"), `${index.join("\n")}\n`);
    console.log(index.join("\n"));
  }

  // ① 预算表与样本集必须**严丝合缝**：新加一份样本忘了给预算，等于这份没人盯；预算表里
  //    留着一个已经不存在的 id，等于一条看着在生效、其实什么都没约束的规则。
  assert.deepEqual(
    samples.map((sample) => sample.id).filter((id) => !(id in BUDGETS)), [],
    "有样本没有预算：在 BUDGETS 里给它一个数，别让它裸奔",
  );
  assert.deepEqual(
    Object.keys(BUDGETS).filter((id) => !size.has(id)), [],
    "预算表里有已经不存在的样本 id：删掉它，别留一条不约束任何东西的规则",
  );

  // ② 逐份量。报错里直接给出「超了多少」和当前值，省得人再跑一遍 --dump。
  const over: string[] = [];
  for (const { id } of samples) {
    const actual = size.get(id)!;
    const budget = BUDGETS[id]!;
    if (actual > budget) over.push(`${id}: ${actual}B > ${budget}B（超 ${actual - budget}B）`);
  }
  assert.deepEqual(over, [], `这些消息超预算了，先问「是多了一条规则还是多了一段论证」：\n${over.join("\n")}`);

  const total = [...size.values()].reduce((sum, bytes) => sum + bytes, 0);
  assert.ok(total <= TOTAL_BUDGET, `全部样本合计 ${total}B 超过 ${TOTAL_BUDGET}B`);

  // ③ 动态段：和正文分开量，否则「攒了十轮裁定」和「措辞写胖了」在同一个数字里分不开。
  for (const { full, bare, cap, what } of DYNAMIC_CAPS) {
    const delta = size.get(full)! - size.get(bare)!;
    assert.ok(delta > 0, `${full} 不比 ${bare} 大：动态段没有进这条消息，这张表就量不到东西了`);
    assert.ok(delta <= cap, `${what} 涨到 ${delta}B，超过上限 ${cap}B`);
  }

  // ④ 单源。
  for (const { name, where } of PLACEMENT) {
    const text = shared[name];
    assert.ok(typeof text === "string" && text.length > 0, `@ash/shared/free-workflow 里找不到 ${name}`);
    const hits = samples.filter((sample) => sample.text.includes(text)).map((sample) => sample.id);
    assert.deepEqual([...hits].sort(), [...where].sort(),
      `${name} 的落脚处变了：现在在 ${hits.join("、") || "(没有任何样本)"}，` +
      `声明的是 ${where.join("、")}。多出来的那份要么是复制，要么是该改 PLACEMENT`);
    for (const id of hits) {
      const sample = samples.find((item) => item.id === id)!;
      assert.equal(sample.text.split(text).length - 1, 1,
        `${name} 在 ${id} 这一条消息里出现了不止一次：同一段判据重复进同一条消息，就是在为它按轮次付费`);
    }
  }

  console.log(`prompt budget ok：${samples.length} 份样本，合计 ${total}B / ${TOTAL_BUDGET}B`);
} finally {
  await import("../src/db/index.js").then(({ dbClient }) => dbClient.close()).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
