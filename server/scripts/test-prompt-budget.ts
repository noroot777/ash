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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 舞台根**故意含一个空格**：含空白的 `TMPDIR` 是合法环境（宿主给的临时目录就可能带空格），
// 而第 2 轮审查正是在这种根下复现出「完整可读的地址被判成没有入口」—— 一条挡住验收的假红。
// 路径里有空白是所有样本都该扛住的输入边界，所以整摞样本都在这种根下渲染一遍，而不是给
// 某个样本加特判。归一化按整串 `root` 替换，与里面有没有空格无关。
const root = mkdtempSync(join(tmpdir(), "ash prompt budget "));
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
  "review/dispatch-bare": 7400,
  "review/dispatch-logic": 11100,
  "review/dispatch-syntax": 11100,
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
  // 产出质量规则本体（`CRAFT_RULES`，用户 2026-10-30 拍板的两句原句）。**这个数就是它的
  // 棘轮**：口径是「原句一字不改、不加判据不加护栏不加判断表」，所以余量刻意只留 40B —— 
  // 想往里补一句判据，得先在 diff 里把这个数改大，那一行会被看见、被问一句「谁同意的」。
  "turn/craft-rules": 200,
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
  //    20 条是「典型上限」，100 条是「条数压力」。两个都要：第 2 轮审查就是靠 40/60/100
  //    复现出「20 条通过 ≠ 有上限」的。
  //    这三条在第 4 轮**各涨了两三百字节**，涨的不是措辞：历史发现那一节改成「地址清单
  //    先让位、条目按余量分配」（第 1 轮审查裁定的修法），于是同样的 4000B 上限下内联的
  //    轮次从 7 轮变成 13 轮，省掉的那摞地址折成一个公共目录入口。换来的是覆盖面，花掉的
  //    是这点字节。
  "stress/review-dispatch": 14900,
  "stress/repair-auto": 3400,
  "stress/review-dispatch-100": 14800,
  "stress/repair-auto-100": 2900,
  // ── 分节（`SECTION`）：两节动态段自己的字节，和整条消息分开量 ─────────────────
  //    `-nofile` = 全文落盘失败（`full=null`）那一路：它同样必须有界。
  "section/settled-reviewer-20": 4500,
  "section/settled-executor-20": 1550,
  "section/settled-reviewer-100": 4400,
  "section/settled-executor-100": 1050,
  "section/settled-reviewer-100-nofile": 4750,
  "section/settled-executor-100-nofile": 1050,
  "section/history-100": 3100,
  // ── 投递态（`DELIVERED`）：真正发出去的那一条，片段相加之后的样子 ─────────────
  "delivered/review-dispatch": 14500,
  "delivered/review-resume": 6750,
  // 证据清单读不出来那一轮：续跑正文里一个字都没有，全靠提醒把状态带到。
  "delivered/review-resume-nomanifest": 6150,
  // 目录名含「。」：比普通续跑多出用户引的那条旧地址，本轮入口必须照样在。
  "delivered/review-resume-dotdir": 7100,
  "delivered/repair": 6450,
  // ── 没有旧上下文的那几条首条消息（产出质量规则唯一的落脚处）─────────────────
  //
  // 四个入口各走一个拼装器，所以各有一份。**口径**：`fresh-*` 那两份量的是所有任务共有
  // 的那一截开场，团队前言／审查任务书／接力前言／同伴告知一律置空（各有自己的样本）——
  // 拿 `delivered/fresh-review-run` 当「生产里审查首条消息的上限」会低估，真实那条还要
  // 加上 `review/dispatch-*` 那一摞。
  //
  // 审查那一份小得多，不止少了这两句：它的完成协议走 `verifying` 分支（没有验收辅路、
  // 没有执行者回归登记）。团队开台那份大，是 `LEAD_PREAMBLE` 本身的体积（派活哲学那一摞）。
  // 规划那份小，是因为那条路刻意只有正文加一句，且浏览器策略发的是缩略版。
  "delivered/fresh-run": 4000,
  "delivered/fresh-review-run": 3350,
  "delivered/invited-first": 3900,
  "delivered/team-lead-first": 5900,
  "delivered/plan-first": 1450,
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

/** 这几族是**同一批文字的派生视图**，算进总量就是把同一段话数两遍。 */
const DERIVED = (id: string): boolean =>
  id.startsWith("stress/") || id.startsWith("delivered/") || id.startsWith("section/")
  || LONG_PATH(id);

/**
 * 长路径那一族：字节数里含着 `mkdtemp` 的舞台根，**逐机不同**，棘轮盯不住一个随机数。
 * 所以它们不进 `BUDGETS`，改由 `CONTRACT` 那张表盯 —— 盯的也不是具体数字，而是
 * 「不管地址多长，整节都要以固定契约结尾、带一个真读得到的入口、且不超生产上限」。
 */
const LONG_PATH = (id: string): boolean => id.startsWith("deep/");

/** 片段集合加起来的顶。单条都压着、总量却靠「多加几份样本」涨回去，也算退步。 */
const TOTAL_BUDGET = 89_000;

/**
 * 动态段的上限：`<撑满的那一版> - <同名 -bare 样本>`。
 *
 * **必须拿撑满的那一版作差**，而且不能只撑一种条数：夹具通过只证明「这个夹具不超」。
 * 第 1 轮审查用 20 条满额裁定实测到 21356B（当时声明 5200B），第 2 轮再把条数推到
 * 40/60/100，复现出「20 条过了、40 条起就破顶」—— 所以这里 20 条和 100 条都量。
 *
 * 100 条那一版**比 20 条更小**是预期之中的：条数多到内联不下时，渲染层会折成有界摘要
 * （`free-review-settled.ts` 的 `digestSection`）。这正是「有上限」的样子。
 *
 * 真正拦住增长的是渲染层那两个整节上限（`SECTION_BUDGET` / `SECTION_CAP`），下面那张
 * `SECTION_CAPS` 直接量它们；这张表负责证明「装进整条消息之后也还是这么大」。
 */
// 这里的 cap **不是实测值，是生产上限推出来的**：动态段就是那两节直接拼起来的，
// 所以审查任务书 = `SECTION_BUDGET.reviewer`(5000) + `SECTION_CAP`(4000)，修复交接 =
// `SECTION_BUDGET.executor`(2500)。实测值由上面的 BUDGETS 逐份棘轮盯着，这张表只回答
// 一个问题：**装进整条消息之后，它还受不受那两个上限约束**。
const DYNAMIC_CAPS: Array<{ full: string; bare: string; cap: number; what: string }> = [
  { full: "stress/review-dispatch", bare: "review/dispatch-bare", cap: 9_000, what: "审查任务书的动态段（20 条裁定 + 26 轮）" },
  { full: "stress/review-dispatch-100", bare: "review/dispatch-bare", cap: 9_000, what: "审查任务书的动态段（100 条裁定 + 100 轮）" },
  { full: "stress/repair-auto", bare: "repair/auto-bare", cap: 2_500, what: "修复交接的裁定重播（20 条）" },
  { full: "stress/repair-auto-100", bare: "repair/auto-bare", cap: 2_500, what: "修复交接的裁定重播（100 条，已折成有界摘要）" },
];

/**
 * **两节动态段各自的硬上限，连同「省掉的内容去哪读」那个入口一起钉。**
 *
 * 为什么要单独量而不是只拿整条消息作差：整条消息里还有需求引用、证据清单状态这些会跟着
 * 夹具一起变的东西，作差量到的不只是这一节；而「这一节有上限」才是要保的不变量。
 *
 * `cap` 取的是**生产代码里声明的那个数**（`free-review-settled.ts` 的 `SECTION_BUDGET`、
 * `review-history.ts` 的 `SECTION_CAP`），不是实测值 —— 下面同时断言 `BUDGETS[id] <= cap`，
 * 所以棘轮永远不可能被调到生产上限之上。
 *
 * `entry` 是**必需入口**：超限折叠省掉的逐条内容必须有一个真读得到的去处。少了它，这一节
 * 就从「补上下文」退化成无声丢条目 —— 那是它最不能犯的错（见 free-review-settled.ts 文件头）。
 */
const SECTION_CAPS: Array<{ id: string; cap: number; entry: string; what: string }> = [
  { id: "section/settled-reviewer-20", cap: 5_000, entry: "settled-rulings.md", what: "裁定重播·审查者侧（20 条）" },
  { id: "section/settled-executor-20", cap: 2_500, entry: "settled-rulings.md", what: "裁定重播·执行者侧（20 条）" },
  { id: "section/settled-reviewer-100", cap: 5_000, entry: "settled-rulings.md", what: "裁定重播·审查者侧（100 条）" },
  { id: "section/settled-executor-100", cap: 2_500, entry: "settled-rulings.md", what: "裁定重播·执行者侧（100 条）" },
  // 落盘失败那一路没有全文文件，入口改成任务详情里的审查记录；**不许**因此退回无界内联。
  { id: "section/settled-reviewer-100-nofile", cap: 5_000, entry: "审查记录", what: "裁定重播·审查者侧（100 条，全文落盘失败）" },
  { id: "section/settled-executor-100-nofile", cap: 2_500, entry: "审查记录", what: "裁定重播·执行者侧（100 条，全文落盘失败）" },
  { id: "section/history-100", cap: 4_000, entry: "报告全文", what: "历史发现清单（100 轮）" },
];

/**
 * **最终渲染层的不变量：固定契约完整 + 入口完整 + 总字节有界 —— 三条一起，缺一不可。**
 *
 * 只钉字节是不够的。第 1 轮审查复现到的形态恰好是「4000B 整」：整节在
 * 「另有 32 份没有列出，在 …」这半句话处被切断，指着一个不存在的目录，末尾那两句
 * 固定契约（「报类不报个例」和「还没修好／复发照样报」）一起消失 —— 闸全绿，而剩下的
 * 文字已经不是一份能执行的契约了，读的人只会得出「上面这些别再报」。
 *
 * 所以这张表量三件事：
 * ① 不超生产声明的整节上限；
 * ② 以 `PRIOR_FINDINGS_TAIL` **结尾**（任何盲截都会先吃掉它，所以这一条就是「没被盲截」
 *    的直接证据）；
 * ③ 夹具声明的那几个报告地址／公共目录里，**至少有一个整串出现在正文里，且它在盘上真的
 *    存在** —— 入口被截掉半截时整串就匹配不上，这一条把「入口完整」变成一个可机验的事实。
 *    预期地址由采样器给出，闸**不从自然语言里反解地址**：第 2 轮审查复现过反解那条路的
 *    死法（按「不含空白」切地址，舞台根含空格就把完整地址判成不存在，挡住验收）。
 *
 * 另外钉一条**取样声明的真实性**：说了「含首轮」，第 1 轮就必须真在正文里。降级到只剩
 * 最近一轮时那句话会换成别的措辞（`review-history.ts` 的 `allocate`）；这里钉的是不变量
 * 而不是那个分支 —— 合法路径最长 1024B，走不到只剩一轮，但谁把上限调小了都会在这里红。
 */
/** 固定契约末句取哪一份。真正的文案由生产函数算（见下面 `tailOf`），这里只记属于哪一类。 */
type TailKind = "history" | "settled-reviewer" | "settled-executor";

const CONTRACT: Array<{ id: string; cap: number; tail: TailKind; what: string }> = [
  { id: "section/history-100", cap: 4_000, tail: "history", what: "历史发现清单（100 轮，短地址）" },
  { id: "deep/history-free", cap: 4_000, tail: "history", what: "历史发现清单·自由工作流（40 轮，单条地址 300B+）" },
  { id: "deep/history-verify", cap: 4_000, tail: "history", what: "历史发现清单·就地验证（40 轮，单条地址 290B+）" },
  // 入口地址本身超过整节上限的那一类（第 1 轮审查在 Linux 真目录上复现）。末级摘要当时
  // 直接 return，于是「与条数无关」被当成了「必然放得下」—— 而入口是随环境变长的绝对路径。
  { id: "deep/history-longpath", cap: 4_000, tail: "history", what: "历史发现清单（地址 3.7KB，超过整节上限）" },
  { id: "deep/settled-reviewer-longref", cap: 5_000, tail: "settled-reviewer", what: "裁定重播·审查者侧（全文地址 4KB，合法路径的最坏情况）" },
  { id: "deep/settled-executor-longref", cap: 2_500, tail: "settled-executor", what: "裁定重播·执行者侧（全文地址 2KB，超过整节上限）" },
];

/**
 * **同一条消息里，这几段话各自至多出现一次。**
 *
 * 片段各自压着预算，拼成一条投递消息之后翻倍 —— 这是这一摞里最贵的一种退步，而它只在
 * `delivered/*` 这一层量得到（第 1 轮审查 F2：首次派审 13407B，报告格式、回归口径、
 * 证据清单引用各两遍）。锚点取的是各段话的首句，同时断言它**在整个样本集里至少出现
 * 一次** —— 否则改个措辞就能让这条断言悄悄变成空转。
 */
const DEDUP_ANCHORS: Array<{ anchor: string; twiceOk?: readonly string[] }> = [
  { anchor: "报告开头必须" },                  // 报告格式契约（完整版 / 缩略版共有）
  { anchor: "该扫的面扫完了" },                // 六面扫描的覆盖声明锚点（协议 / 缩略版共有）
  // 回归证据清单入口。**只有一份样本里它该出现两次**：目录名含「。」那一条，用户消息里引着
  // 上一轮的地址、提醒里是本轮的地址 —— 两条不同路径各算一个入口，正是那份样本要证明的事
  //（上一版把它们当成同一个入口，删掉了本轮那一份）。其余样本一律至多一次。
  { anchor: "执行者回归证据清单：", twiceOk: ["delivered/review-resume-dotdir"] },
  { anchor: "passed=true 且 exitCode=0" },     // 清单怎么读（只许由清单说明自己讲）
  { anchor: "浏览器验证必须按以下顺序选择通道" }, // 全局浏览器策略
];

/**
 * **每条投递消息里必须有的东西。**
 *
 * 去重断言只保证「不重复」，保证不了「齐全」—— 第 2 轮审查 F2 就栽在这个缺口上：
 * 判据是「正文里出现了报告格式契约就把整条提醒丢掉」，于是提醒里**这一轮才有的**
 * 证据状态（清单不可用、把回归面写成留白）跟着一起没了，而闸全绿。所以两条断言要配对：
 * `DEDUP_ANCHORS` 管「至多一次」，这张表管「至少一次」。
 *
 * `forbid` 用来钉**不该出现**的东西：清单读不出来的那一轮，提示里不能还挂着一条指向
 * 不存在文件的清单路径。
 */
const REQUIRED: Array<{ id: string; must: Array<[string, string]>; forbid?: Array<[string, string]> }> = [
  {
    id: "delivered/review-dispatch",
    must: [
      ["报告格式契约", "报告开头必须"],
      ["六面扫描的覆盖声明", "该扫的面扫完了"],
      ["回归口径", "回归测试统一在验收时"],
      ["证据清单入口", "执行者回归证据清单："],
      ["清单怎么算通过", "passed=true 且 exitCode=0"],
      ["latest 不许被旧通过顶替", "不能回退用旧的通过结果顶替"],
      ["全局浏览器策略", "浏览器验证必须按以下顺序选择通道"],
      ["结论怎么上报", "report_stage"],
    ],
  },
  {
    // 续跑正文**没有**清单读法（它刻意只有几行），所以这几条全靠每回合提醒带到。
    // 上一版把整条提醒丢掉时，这里前四项一条都没有。
    id: "delivered/review-resume",
    must: [
      ["报告格式契约", "报告开头必须"],
      ["回归口径", "回归测试统一在验收时"],
      ["证据清单入口", "执行者回归证据清单："],
      ["清单怎么算通过", "passed=true 且 exitCode=0"],
      ["latest 不许被旧通过顶替", "不能回退用旧的通过结果顶替"],
      ["全局浏览器策略", "浏览器验证必须按以下顺序选择通道"],
      ["结论怎么上报", "report_stage"],
    ],
  },
  {
    id: "delivered/review-resume-nomanifest",
    must: [
      ["本轮的证据状态", "回归证据清单不可用"],
      ["状态对应的动作", "把回归面写成留白"],
      ["报告格式契约", "报告开头必须"],
      ["全局浏览器策略", "浏览器验证必须按以下顺序选择通道"],
      ["结论怎么上报", "report_stage"],
    ],
    forbid: [["指向不存在清单的入口", "执行者回归证据清单："]],
  },
  {
    id: "delivered/repair",
    must: [
      ["类问题的边界判据", "这是类问题"],
      ["驳回/转出那条出路", "dispute_review"],
      ["完成协议", "complete_task"],
      ["全局浏览器策略", "浏览器验证必须按以下顺序选择通道"],
    ],
  },
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
      "stress/repair-auto", "stress/repair-auto-100", "delivered/repair"],
  },
  { name: "GATE_FAILURE_REGRESSION_CARVE_OUT", where: ["accept/gate-failure"] },
  // 产出质量规则：**只在没有旧 CLI 上下文的执行首条消息里**。这一行同时钉住两面 ——
  // 「每一种新执行上下文都带它」（四个入口各一份样本，少一份就是那个入口没接上）和
  // 「别处一个字都没有」（多一份就是在为一条全任务通用的开场按轮次重复付费）。
  // `delivered/fresh-review-run` 刻意不在表里：那一轮交的是报告，不是新一版界面。
  {
    name: "CRAFT_RULES",
    where: ["turn/craft-rules", "delivered/fresh-run", "delivered/invited-first",
      "delivered/team-lead-first", "delivered/plan-first"],
  },
  {
    name: "REVIEW_VALIDATION_REQUIREMENT",
    where: ["review/dispatch-bare", "review/dispatch-logic", "review/dispatch-syntax",
      "stress/review-dispatch", "stress/review-dispatch-100",
      "delivered/review-dispatch", "mcp/report_stage"],
  },
  // 审查者面的一句话口径：**只**在没有完整验证义务的那条消息里出现（续跑）。派审正文里
  // 有全文，再讲一遍就是同一条消息里两份。
  {
    name: "REVIEWER_REGRESSION_CLAUSE",
    where: ["review/resume", "delivered/review-resume", "delivered/review-resume-nomanifest",
      "delivered/review-resume-dotdir"],
  },
  // 「这份清单怎么读」的全文：正文讲过就不在提醒里重讲（去重判据见 turn-prompt.ts），
  // 所以续跑那条**只有提醒带着它**，首次派审那条**只有正文带着它** —— 两边各一份。
  {
    name: "REGRESSION_MANIFEST_READING",
    where: ["review/dispatch-bare", "review/dispatch-logic", "review/dispatch-syntax",
      "stress/review-dispatch", "stress/review-dispatch-100",
      "delivered/review-dispatch", "delivered/review-resume", "delivered/review-resume-dotdir"],
  },
  {
    name: "EXECUTOR_REGRESSION_RECORDING",
    where: ["turn/completion-protocol-free", "turn/completion-protocol-normal",
      "turn/completion-reminder-free", "turn/follow-up-reminder-free",
      // 审查/验证那几条投递消息里没有它：那一轮的完成协议走 `verifying` 分支，执行者
      // 回归登记本来就不是审查者的事（`delivered/fresh-review-run` 同理）。
      "delivered/repair", "delivered/fresh-run", "delivered/invited-first"],
  },
  {
    name: "REGRESSION_POLICY",
    where: ["review/dispatch-bare", "review/dispatch-logic", "review/dispatch-syntax",
      "stress/review-dispatch",
      "stress/review-dispatch-100",
      "turn/completion-protocol-free", "turn/completion-protocol-normal",
      "turn/completion-reminder-free", "turn/follow-up-reminder-free",
      // 续跑那条只带审查者面的一句话口径（`REVIEWER_REGRESSION_CLAUSE`），不带全文
      // —— 这是 `freeReviewResumeMessage` 一贯的分寸：续跑不重发任务书。
      "delivered/review-dispatch", "delivered/repair",
      "delivered/fresh-run", "delivered/invited-first",
      "mcp/report_stage", "mcp/start_monitor"],
  },
];

/**
 * 需求里写死的量化目标 → **用户 2026-10-27 追认后的新目标**，现在是硬断言。
 *
 * 原先这张表只打印差距、只要求开发者写一句非空 `waiver` 就放行。第 2 轮审查点名这是
 * 「用开发者自己的说明代替用户授权」：任何人填一行字就能宣布达标。
 *
 * 用户的裁定（2026-10-27 原话口径）：再压一轮、尽力而为；压不到原定目标没关系，但
 * **绝不许为凑体积数字把好用的功能改坏**。所以原定的两个目标（修复交接 −80%、任务书
 * 正文 ≤3KB）作废，改成把这一轮压完的**实测值**钉成新目标 —— 数字由他追认，闸只负责
 * 防回弹：超过即红，一个字节都不放。
 *
 * `held` 记的是「这里为什么到此为止」：剩下的是哪几段契约/护栏文本顶着。它不是放行条件
 * （放行条件只有字节数），是给下一个想继续压的人看的。
 */
const TARGETS: Array<{ id: string; target: number; what: string; held: string }> = [
  {
    id: "repair/auto", target: 2_851, what: "修复交接（含两条裁定重播）",
    held: "正文 1830B 里 CLASS_PROBLEM_BOUNDARY 占 673B：三种处置各一行，少一支就会把" +
      "「根因本身也落在界外」那一型重新判成界内。其余是驳回出路的指针和证据目录。",
  },
  {
    id: "repair/auto-bare", target: 1_830, what: "修复交接正文（不含裁定重播）",
    held: "同上：类问题边界 673B + 驳回出路指针 ~470B + 抬头与报告路径。",
  },
  {
    id: "review/dispatch-bare", target: 7_339, what: "审查任务书正文（不含动态段）",
    held: "剩下的是审查契约本体（六面扫描约 2.5KB、报告格式约 1.6KB、验证义务 717B、" +
      "清单说明约 700B），而「审查制度本身不在本任务范围内」。事故叙事已全部迁进代码注释。",
  },
  {
    id: "delivered/review-dispatch", target: 14_317, what: "首次派审的投递态",
    held: "正文 + 完成协议 + 方向身份 + 全局浏览器策略（2.2KB，按需求不做条件省略）。",
  },
  {
    // 这一条**比上一轮大**：上一轮把整条提醒丢掉，续跑因此收不到清单读法（第 2 轮审查 F2）。
    // 多出来的那 1066B 是补回去的协议，不是胖出来的措辞。
    id: "delivered/review-resume", target: 6_649, what: "断线续跑的投递态",
    held: "续跑正文刻意只有几行，清单入口与读法只能由每回合提醒带到；这部分不能再删。",
  },
];

const dumpTo = process.argv.includes("--dump") ? process.argv[process.argv.indexOf("--dump") + 1] : null;

try {
  const { renderPromptSamples, sizeOf } = await import("./prompt-budget-samples.js");
  const { PRIOR_FINDINGS_TAIL } = await import("../src/review-history.js");
  const { guidanceLines } = await import("../src/free-review-settled.js");
  const { dedupeReminder } = await import("../src/turn-prompt.js");
  // 两节各自的「固定契约最后一句」。取的是**生产函数算出来**的那一句，不在这里抄文案 ——
  // 抄一份就等于再开一个会漂移的副本。裁定那两份夹具都是既有转出又有作废、未维持原意见。
  const tailOf = (kind: TailKind): string => kind === "history"
    ? PRIOR_FINDINGS_TAIL
    : guidanceLines(kind === "settled-reviewer" ? "reviewer" : "executor", true, true, false).at(-1)!;
  const shared = (await import("@ash/shared/free-workflow")) as unknown as Record<string, string>;
  // 单源常量有两窝：审查/修复那一摞住在 shared，执行者开场那两句住在 `craft-rules.ts`
  //（服务端独用，搬进 shared 只多一跳；零依赖独立成文件的理由见那个文件头）。两边都认。
  const craft = (await import("../src/craft-rules.js")) as unknown as Record<string, string>;
  const sourceOf = (name: string): string | undefined => shared[name] ?? craft[name];
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
    samples.map((sample) => sample.id).filter((id) => !(id in BUDGETS) && !LONG_PATH(id)), [],
    "有样本没有预算：在 BUDGETS 里给它一个数，别让它裸奔",
  );
  assert.deepEqual(
    samples.map((sample) => sample.id).filter(LONG_PATH)
      .filter((id) => !CONTRACT.some((item) => item.id === id)), [],
    "长路径样本既不在 BUDGETS 也不在 CONTRACT：它现在什么都没约束",
  );
  assert.deepEqual(
    Object.keys(BUDGETS).filter((id) => !size.has(id)), [],
    "预算表里有已经不存在的样本 id：删掉它，别留一条不约束任何东西的规则",
  );

  // ② 逐份量。报错里直接给出「超了多少」和当前值，省得人再跑一遍 --dump。
  const over: string[] = [];
  for (const { id } of samples) {
    if (LONG_PATH(id)) continue;
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

  // ③′ 两节动态段自己的硬上限 + 必需入口。这一条才是「有没有上限」的直接证明：
  //     上面那张表量的是装进整条消息之后的差值，这里量的是渲染层那一节本身。
  for (const { id, cap, entry, what } of SECTION_CAPS) {
    const actual = size.get(id)!;
    assert.ok(actual <= cap,
      `${what} 渲染出 ${actual}B，超过生产声明的整节上限 ${cap}B（超 ${actual - cap}B）：` +
      "降级没有收口，改 free-review-settled.ts / review-history.ts，别改这个数");
    assert.ok(BUDGETS[id]! <= cap,
      `${id} 的预算 ${BUDGETS[id]}B 高过生产上限 ${cap}B：棘轮不许被调到生产上限之上`);
    const sample = samples.find((item) => item.id === id)!;
    assert.ok(sample.text.includes(entry),
      `${what} 里找不到「${entry}」：折叠省掉的逐条内容必须留一个真读得到的去处，` +
      "没有入口的摘要等于无声丢条目");
  }

  // ③″ 固定契约完整 + 入口真读得到。字节达标不等于剩下的文字还是份完整契约 —— 这一条
  //     量的是**没归一过**的那份正文（归一会把舞台根缩成 7 字节，路径压力恰好就量不到了）。
  for (const { id, cap, tail, what } of CONTRACT) {
    const sample = samples.find((item) => item.id === id);
    assert.ok(sample, `CONTRACT 指向了不存在的样本 ${id}`);
    const text = sample.raw;
    const actual = sizeOf(text);
    assert.ok(actual <= cap,
      `${what} 渲染出 ${actual}B，超过生产声明的整节上限 ${cap}B（超 ${actual - cap}B）`);
    assert.ok(text.endsWith(tailOf(tail)),
      `${what} 没有以固定契约结尾 —— 末尾那几句是这一节的用处本身（历史说明是「报类不报` +
      "个例」和「还没修好／复发照样报」，裁定重播是读者侧的处置指引），被切掉就只剩一摞" +
      "旧条目。整节不许盲截，装不下要降级成有界摘要");
    // 预期入口由夹具**结构化给出**，不从正文里反解地址：反解只能靠「地址到哪儿为止」这种
    // 猜测，而任何猜测都会在合法输入上判错（上一版猜「到第一个空白为止」，含空格的舞台根
    // 就全军覆没）。这里只做两件与字符形状无关的事：原文里有没有这个**完整**地址、它读不读得到。
    const expected = sample.entries ?? [];
    assert.ok(expected.length > 0,
      `${what} 没有给出预期入口：CONTRACT 样本必须在采样器里声明它应当指得到哪几个地方`);
    const present = expected.filter((entry) => text.includes(entry.text));
    assert.ok(present.length > 0,
      `${what} 里一个完整入口都没有（预期的 ${expected.length} 个去处一个都没整串出现）：` +
      "省掉的条目必须留一个真读得到的去处，截在半条地址上的指路比不指路更坏");
    for (const entry of present.filter((item) => item.onDisk)) {
      assert.ok(existsSync(entry.text), `${what} 的入口 ${entry.text} 在盘上不存在`);
    }
    // 首轮的标签有两种形状：单链是「第 1 轮」，跨链是「第 1 条审查链第 1 轮」，都以
    // 「第 1 」起头（`freeReviewPriorRounds` 的 label）。
    if (text.includes("含首轮和最近一轮")) {
      assert.ok(text.includes("〔第 1 "),
        `${what} 声称取样「含首轮和最近一轮」，正文里却没有第 1 轮：取样说明不许说假话`);
    }
  }

  // ④ 单源。
  for (const { name, where } of PLACEMENT) {
    const text = sourceOf(name);
    assert.ok(typeof text === "string" && text.length > 0,
      `${name} 在 @ash/shared/free-workflow 和 server/src/craft-rules.ts 里都找不到`);
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
  for (const { anchor, twiceOk } of DEDUP_ANCHORS) {
    const seen = samples.filter((sample) => sample.text.includes(anchor));
    assert.ok(seen.length > 0,
      `去重锚点「${anchor}」在所有样本里一次都没出现：它要么被改了措辞、要么那段话没了，` +
      "无论哪种，这条断言都已经空转——改锚点或删掉它，别留着");
    const twice = seen.filter((sample) => !twiceOk?.includes(sample.id))
      .filter((sample) => sample.text.split(anchor).length - 1 > 1)
      .map((sample) => `${sample.id}×${sample.text.split(anchor).length - 1}`);
    assert.deepEqual(twice, [],
      `「${anchor}」在同一条消息里出现了不止一次：${twice.join("、")}。` +
      "片段各自压着预算、拼起来翻倍，正是这张表要拦的那一种");
  }

  // ⑥ 必含内容：去重管「至多一次」，这一条管「至少一次」。两条配对才拦得住
  //    「把整条提醒删干净」这种去重（第 2 轮审查 F2）。
  for (const { id, must, forbid } of REQUIRED) {
    const sample = samples.find((item) => item.id === id);
    assert.ok(sample, `REQUIRED 指向了不存在的样本 ${id}`);
    for (const [what, anchor] of must) {
      assert.ok(sample.text.includes(anchor),
        `${id} 这条投递消息里没有${what}（找不到「${anchor}」）：` +
        "要么是去重把它删掉了，要么是那段话没再进这条消息 —— 两种都得修，不是改这张表");
    }
    for (const [what, anchor] of forbid ?? []) {
      assert.ok(!sample.text.includes(anchor),
        `${id} 这条投递消息里不该有${what}（出现了「${anchor}」）`);
    }
  }

  // ⑥‴ 产出质量规则的**判据方向**。上面那张 PLACEMENT 盯的是「渲染出来落在哪几条消息里」，
  //     这一条直接打生产判据本身：四个拼装入口都只认它的产物，所以判据塌了就是四处一起塌。
  {
    const { craftRulesFor, CRAFT_RULES } = await import("../src/craft-rules.js");
    assert.equal(craftRulesFor({ freshContext: true, verifying: false }), CRAFT_RULES,
      "没有旧上下文的执行首条消息没带产出质量规则：判据反了");
    assert.equal(craftRulesFor({ freshContext: true, verifying: true }), "",
      "审查/验证的首条消息带上了产出质量规则：那一轮交的是报告，不是新一版界面");
    // 判据必须落在「模型手上有没有旧上下文」上，而不是「走的哪个 API 入口」：为假时一律
    // 不贴，规则只贴一次，之后靠那条 CLI 会话自己留住（同 `AUTONOMY` 的分寸）。
    assert.equal(craftRulesFor({ freshContext: false, verifying: false }), "",
      "续跑（有旧上下文）也重贴了产出质量规则：规则只贴一次");
    // 原句一字不改（用户 2026-10-30 的口径）。写死在这里是故意的：这两句是**用户给的
    // 原话**，不是可以顺手改措辞的内部文案 —— 改一个字就得在 diff 里动这个断言。
    assert.equal(CRAFT_RULES,
      "避免不必要的次级标签和描述，让布局本身解释界面\n" +
      "结合第一性原理和成熟实践，从根因修复 Bug，避免只遮住表面症状\n\n",
      "产出质量规则的原句被改动了：用户给的是原话，改字要先问他");
  }

  // ⑥′ 夹具声明的「这一份必须原样含有」。`REQUIRED` 只能写死字面量，而「本轮清单的**完整**
  //     地址有没有活着出现在投递消息里」是随夹具变的事实 —— 第 1 轮审查复现的正是它被误删。
  for (const { id, requires } of samples) {
    for (const needed of requires ?? []) {
      const sample = samples.find((item) => item.id === id)!;
      assert.ok(sample.raw.includes(needed),
        `${id} 里缺了夹具声明的必含内容：${needed}\n` +
        "去重只许删**整串相同**的那一份，拿不准一律保留");
    }
  }

  // ⑥″ 去重判据本身：整串相等才算重复。这一条直接打生产函数，因为三个提醒（自由审查、
  //     就地验证、历史独立审查）共用它 —— 判据塌了就是三个入口一起塌。
  {
    const entryOf = (path: string) => `执行者回归证据清单：${path}。`;
    const current = entryOf("/tmp/ash。runs/t/free-review/r/round-2/regression-evidence.json");
    const older = entryOf("/tmp/ash。runs/t/free-review/r/round-1/regression-evidence.json");
    const reminder = { text: `审查提醒：${current}清单读法若干。`, manifestEntry: current };
    assert.ok(dedupeReminder(reminder, `上一轮的清单在 ${older}`).includes(current),
      "目录名含「。」时，本轮清单入口被当成重复删掉了：两条路径只共享『第一个句号之前』" +
      "的那一段，不是同一个入口。判据必须是整串相等");
    assert.ok(!dedupeReminder(reminder, `正文里已经有 ${current}`).includes(current),
      "正文里已经有一模一样的那一句，提醒里仍留了第二份：该去重的没去掉");
  }

  // ⑦ 用户追认的体积目标：硬断言，超过即红（棘轮防回弹）。
  for (const { id, target, what } of TARGETS) {
    assert.ok(size.has(id), `TARGETS 指向了不存在的样本 ${id}`);
    const actual = size.get(id)!;
    assert.ok(actual <= target,
      `${what} 涨回到 ${actual}B，超过用户 2026-10-27 追认的目标 ${target}B（超 ${actual - target}B）。` +
      "这个数不是随手定的余量，是那一次压到的实测值 —— 想调大得先问用户");
  }

  console.log(`prompt budget ok：${samples.length} 份样本，片段合计 ${total}B / ${TOTAL_BUDGET}B`);
  for (const { id, target, what } of TARGETS) {
    console.log(`  · ${what}：${size.get(id)}B / 目标 ${target}B`);
  }
} finally {
  await import("../src/db/index.js").then(({ dbClient }) => dbClient.close()).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
