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
  "review/dispatch-bare": 7600,
  "review/dispatch-logic": 11400,
  "review/dispatch-syntax": 11400,
  "review/resume": 2700,
  // ── 修复交接 ─────────────────────────────────────────────────────────────────
  // 正文里最大的一块是 `CLASS_PROBLEM_BOUNDARY`（三种处置，673B）。驳回那条路只留指针，
  // 判据全文在 `dispute_review` 工具说明里（它本来就常驻每个回合的上下文）。
  "repair/auto-bare": 1900,
  "repair/auto": 2950,
  "repair/manual": 3050,
  "repair/manual-upheld": 3100,
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
  // ── 动态段撑满的那一版（`STRESS`）：量的是**天花板**，不是典型流量 ───────────
  "stress/review-dispatch": 15800,
  "stress/repair-auto": 3450,
  // ── 投递态（`DELIVERED`）：真正发出去的那一条，片段相加之后的样子 ─────────────
  "delivered/review-dispatch": 14500,
  "delivered/review-resume": 5800,
  "delivered/repair": 6600,
  // ── MCP 工具清单：每一条都常驻执行者的每一个回合 ─────────────────────────────
  // 字段说明按 **SDK 真正发出去的那份 JSON Schema** 量（见采样器 `toolTexts`）。
  "mcp/accept_task": 1750,
  "mcp/answer_question": 600,
  "mcp/ask_question": 1750,
  "mcp/batch_create_tasks": 2300,
  "mcp/complete_task": 1450,
  "mcp/create_group": 400,
  "mcp/create_queue": 220,
  "mcp/create_task_chain": 2550,
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
  "mcp/start_monitor": 5100,
  "mcp/stop_monitor": 850,
  "mcp/stop_task": 480,
};

/** 这两族是**同一批文字的派生视图**，算进总量就是把同一段话数两遍。 */
const DERIVED = (id: string): boolean => id.startsWith("stress/") || id.startsWith("delivered/");

/** 片段集合加起来的顶。单条都压着、总量却靠「多加几份样本」涨回去，也算退步。 */
const TOTAL_BUDGET = 89_000;

/**
 * 动态段的上限：`<撑满的那一版> - <同名 -bare 样本>`。
 *
 * **必须拿撑满的那一版作差**，不能拿一个固定夹具：夹具通过只证明「这个夹具不超」。
 * 第 1 轮审查 F1 用 20 条满额裁定和 24 条满额现象行实测到 21356B / 9326B，而当时声明的
 * 上限是 5200B —— 闸是绿的，生产渲染根本不受它约束。现在 `stress/*` 就是按合法输入的
 * 边界种出来的（满额单段、撑到条数上限、撑过轮次取样分支），这个差值才是天花板。
 *
 * 真正拦住增长的是渲染层的那两个整节预算（`free-review-settled.ts` 的 `SECTION_BUDGET`、
 * `review-history.ts` 的 `MAX_BODY`）；这张表只负责在它们被调松时红掉。
 */
const DYNAMIC_CAPS: Array<{ full: string; bare: string; cap: number; what: string }> = [
  { full: "stress/review-dispatch", bare: "review/dispatch-bare", cap: 8200, what: "审查任务书的裁定重播 + 历史发现（撑满）" },
  { full: "stress/repair-auto", bare: "repair/auto-bare", cap: 1600, what: "修复交接的裁定重播（撑满；执行者侧只给分档清单 + 全文路径）" },
];

/**
 * **同一条消息里，这几段话各自至多出现一次。**
 *
 * 片段各自压着预算，拼成一条投递消息之后翻倍 —— 这是这一摞里最贵的一种退步，而它只在
 * `delivered/*` 这一层量得到（第 1 轮审查 F2：首次派审 13407B，报告格式、回归口径、
 * 证据清单引用各两遍）。锚点取的是各段话的首句，同时断言它**在整个样本集里至少出现
 * 一次** —— 否则改个措辞就能让这条断言悄悄变成空转。
 */
const DEDUP_ANCHORS = [
  "报告开头必须",                  // 报告格式契约（完整版 / 缩略版共有）
  "该扫的面扫完了",                // 六面扫描的覆盖声明锚点（协议 / 缩略版共有）
  "执行者回归证据清单：",           // 回归证据清单说明
  "passed=true 且 exitCode=0",     // 清单怎么读（只许由清单说明自己讲）
  "浏览器验证必须按以下顺序选择通道", // 全局浏览器策略
];

/**
 * 单源落款：每块判据允许出现在**哪几份**样本里。
 *
 * 多一份、少一份、或者在同一份里出现两次，都红。`REGRESSION_POLICY` 这类「口径」允许
 * 多处出现（执行者面和审查者面本来就是两条消息），但同一条消息里只许讲一遍。
 * `stress/*` 与 `delivered/*` 是 `review/*`、`repair/*` 的派生视图，所以凡是出现在母本
 * 里的判据，也要在这里把派生那几份列上 —— 列不全就说明派生路径上多拼了或少拼了一份。
 */
const PLACEMENT: Array<{ name: string; where: string[] }> = [
  { name: "DEFER_BOUNDARY_CRITERION", where: ["mcp/dispute_review"] },
  { name: "DEFER_REASON_FIELD_GUIDE", where: ["mcp/dispute_review"] },
  { name: "PLAIN_SUMMARY_EXAMPLE", where: ["mcp/dispute_review"] },
  { name: "PLAIN_SUMMARY_GUIDE", where: ["mcp/debate_reply", "mcp/dispute_review"] },
  {
    name: "CLASS_PROBLEM_BOUNDARY",
    where: ["repair/auto-bare", "repair/auto", "repair/manual", "repair/manual-upheld",
      "stress/repair-auto", "delivered/repair"],
  },
  { name: "GATE_FAILURE_REGRESSION_CARVE_OUT", where: ["accept/gate-failure"] },
  {
    name: "REVIEW_VALIDATION_REQUIREMENT",
    where: ["review/dispatch-bare", "review/dispatch-logic", "review/dispatch-syntax",
      "stress/review-dispatch", "delivered/review-dispatch", "mcp/report_stage"],
  },
  // 审查者面的一句话口径：**只**在没有完整验证义务的那条消息里出现（续跑）。派审正文里
  // 有全文，再讲一遍就是同一条消息里两份。
  { name: "REVIEWER_REGRESSION_CLAUSE", where: ["review/resume", "delivered/review-resume"] },
  {
    name: "EXECUTOR_REGRESSION_RECORDING",
    where: ["turn/completion-protocol-free", "turn/completion-protocol-normal",
      "turn/completion-reminder-free", "turn/follow-up-reminder-free",
      // 审查/验证那两条投递消息里没有它：那一轮的完成协议走 `verifying` 分支，执行者
      // 回归登记本来就不是审查者的事。
      "delivered/repair"],
  },
  {
    name: "REGRESSION_POLICY",
    where: ["review/dispatch-bare", "review/dispatch-logic", "review/dispatch-syntax",
      "stress/review-dispatch",
      "turn/completion-protocol-free", "turn/completion-protocol-normal",
      "turn/completion-reminder-free", "turn/follow-up-reminder-free",
      // 续跑那条只带审查者面的一句话口径（`REVIEWER_REGRESSION_CLAUSE`），不带全文
      // —— 这是 `freeReviewResumeMessage` 一贯的分寸：续跑不重发任务书。
      "delivered/review-dispatch", "delivered/repair",
      "mcp/report_stage", "mcp/start_monitor"],
  },
];

/**
 * 需求里写死的**量化目标**，跟预算是两件事。
 *
 * 预算是「别再涨了」的棘轮，必然等于当前实测值加余量；把它当成目标达成，就是用一个
 * 自动跟着产物走的数字宣布自己达标了（第 1 轮审查 F3）。所以目标单独列：没打到不红
 * （改不改目标是用户的事，不是闸的事），但**每次运行都打印差距**，并且要求预算高于
 * 目标时必须写下 `waiver` —— 一句「为什么到此为止」会进 diff，被人看见、被问一句。
 */
const TARGETS: Array<{ id: string; target: number; what: string; waiver: string }> = [
  {
    id: "repair/auto", target: 2_040, what: "修复交接 −80%（改前 10202B）",
    waiver: "剩下的正文里 CLASS_PROBLEM_BOUNDARY 占 673B：三种处置各一行，少一支就会把" +
      "「根因本身也落在界外」那一型重新判成界内。再砍是删规则，不是删废话。",
  },
  {
    id: "review/dispatch-bare", target: 3_000, what: "审查任务书正文 ≤3KB",
    waiver: "剩下的是审查契约本体（六面扫描约 2.6KB、报告格式约 1.6KB、验证义务 717B、" +
      "清单说明约 700B），而「审查制度本身不在本任务范围内」。事故叙事已全部迁进代码注释。",
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

  const total = samples.filter(({ id }) => !DERIVED(id))
    .reduce((sum, { id }) => sum + size.get(id)!, 0);
  assert.ok(total <= TOTAL_BUDGET, `片段样本合计 ${total}B 超过 ${TOTAL_BUDGET}B`);

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

  // ⑤ 去重：同一条消息里同一段话只许讲一遍。
  for (const anchor of DEDUP_ANCHORS) {
    const seen = samples.filter((sample) => sample.text.includes(anchor));
    assert.ok(seen.length > 0,
      `去重锚点「${anchor}」在所有样本里一次都没出现：它要么被改了措辞、要么那段话没了，` +
      "无论哪种，这条断言都已经空转——改锚点或删掉它，别留着");
    const twice = seen.filter((sample) => sample.text.split(anchor).length - 1 > 1)
      .map((sample) => `${sample.id}×${sample.text.split(anchor).length - 1}`);
    assert.deepEqual(twice, [],
      `「${anchor}」在同一条消息里出现了不止一次：${twice.join("、")}。` +
      "片段各自压着预算、拼起来翻倍，正是这张表要拦的那一种");
  }

  // ⑥ 量化目标：没打到不红，但每次都报出来；预算高于目标必须写下理由。
  const missed = TARGETS.filter(({ id, target }) => size.get(id)! > target);
  for (const item of TARGETS) {
    assert.ok(size.has(item.id), `TARGETS 指向了不存在的样本 ${item.id}`);
    if (BUDGETS[item.id]! > item.target) {
      assert.ok(item.waiver.trim().length > 0,
        `${item.id} 的预算（${BUDGETS[item.id]}B）高于需求目标（${item.target}B），` +
        "必须在 TARGETS 里写下 waiver：一句「为什么到此为止」要进 diff，不能让预算数字自己宣布达标");
    }
  }

  console.log(`prompt budget ok：${samples.length} 份样本，片段合计 ${total}B / ${TOTAL_BUDGET}B`);
  for (const { id, target, what } of missed) {
    console.log(`  ⚠ 未达需求目标 ${what}：实测 ${size.get(id)}B > ${target}B（已在 TARGETS 里记了理由）`);
  }
} finally {
  await import("../src/db/index.js").then(({ dbClient }) => dbClient.close()).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
