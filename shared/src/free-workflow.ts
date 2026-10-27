import type { AgentType } from "./index.ts";
import type { PreviewServiceState } from "./preview.ts";

export const TASK_WORKFLOW_MODES = ["free", "preset"] as const;
export type TaskWorkflowMode = (typeof TASK_WORKFLOW_MODES)[number];

/**
 * 「回归测试谁来跑」——**全系统唯一一份源**（用户 2026-10-26 拍板）。
 *
 * 为什么必须收成一句话：同一个执行者原先同时收到三份互相打架的指令 ——
 * ① 根 `AGENTS.md`「执行者和审查者都不要运行任何回归测试」；
 * ② 每回合注入的完成协议「需要跑回归测试时，用 start_monitor(regression=true) ……」；
 * ③ 审查扫描契约的「回归面」「缺少适用的真实测试结果时补跑，别只读代码」。
 * 实测后果（knowledge-base 项目）：执行者援引 ① 连**自己新写的测试**都不跑，交付了红着的
 * 测试文件、两次被审查抓到；审查者守 ① 就只能写「旧问题无法确认已修好」，于是用户看到的
 * 是「旧问题未修全」。三份文本各自都讲得通，合起来没有一条能执行。
 *
 * 新口径只有两句（下面这个常量），**唯一的例外写在口径里面而不是另加一条规则**：
 * 「自己新写/改动的测试必须自己跑绿」不是对「统一在验收时执行」的削弱——那是在说
 * **交付物本身**（一个红着的测试文件就是没做完的活），而不是在说回归面的覆盖义务。
 *
 * 两个运行时表面都从这里取：执行者每回合的 `EXECUTOR_REGRESSION_RECORDING`、
 * 审查/验证回合的 `REVIEW_VALIDATION_REQUIREMENT`。再加表面时也引这一份，别手抄。
 *
 * **口径进每一轮，机制只挂工具说明**：`start_monitor` 的时限、日志落盘、exitCode 语义
 * 这些「怎么登记」的细节住在那个工具自己的 description / 字段说明里（MCP 工具清单本来
 * 就常驻每个回合的上下文），每轮前言只带口径加一句指针。两处都写全文时，执行者每一轮
 * 都在为同一段机制付两份 token。
 */
export const REGRESSION_POLICY =
  "回归测试统一在验收时由项目的验收前置命令执行。" +
  "唯一例外：**本轮自己新写或改动的测试文件**必须自己跑绿，并登记结果。";

/**
 * 审查者面的**一句话**口径。只需要一个分句的审查消费端（两条每回合提醒、续跑消息、清单
 * 说明、清单不可用的降级文案）一律引用它 —— 原先那几处各手写一句近义话，第 1 轮审查点名
 * 这是「会继续漂移的实例集合」：措辞一改就得同时改 5 个地方，漏一个就又多一份口径。
 *
 * 末尾那半句不是客套：禁的只有回归，`REVIEW_VALIDATION_REQUIREMENT` 里的冒烟/点检义务一条
 * 不减，不说清就会被读成「审查者什么都不用跑」。
 */
export const REVIEWER_REGRESSION_CLAUSE =
  "回归测试统一在验收时执行：你只核对执行者登记的结果、自己一条都不跑，缺口原样写进覆盖声明的留白；" +
  "构建、接口冒烟、浏览器真实点检这些必要执行照做。";

/**
 * 验收门禁失败交接这一路的例外。门禁命令**就是**「验收时的那次回归执行」，而且已经红了，
 * 所以这一轮跑它是定位手段，不是「自己另外加跑一套回归」—— 不把这层说开，修复回合会同时
 * 读到完成协议的「整套回归不要在本轮跑」和交接消息的「重跑这条命令」，只能靠猜（第 1 轮审查
 * 发现 2 实测两句话确实进同一个回合）。
 */
export const GATE_FAILURE_REGRESSION_CARVE_OUT =
  "这条命令就是验收时跑的那套回归、刚刚已经红了：所以**这一轮跑它是允许的**" +
  "（完成协议里「整套回归不要在本轮跑」说的是别另外加跑一套，不是这一条）。" +
  "定位到哪一条红之后，优先只跑那一条复核。";

export const REVIEW_VALIDATION_REQUIREMENT =
  "验证必须有真实执行依据，不能只读代码或只过编译。" +
  REGRESSION_POLICY +
  // 「怎么读那份清单」（passed / exitCode / latest / 旧通过不许顶替）住在清单说明自己
  // 那一份里（`regression-checks.ts` 的 `regressionEvidenceReference`），这里只留口径和
  // 一句指针 —— 两处都写全，同一条消息里这几句判据就各出现两遍（实测派审正文就是）。
  "所以这一轮你**一条回归都不要跑、也不要补跑**：只核对执行者登记的结果（怎么读见同一条消息里的证据清单说明），" +
  "没覆盖到的缺口原样写进覆盖声明的「回归面」留白，别拿跑一遍去填。" +
  "回归之外一条不减：构建、接口冒烟、浏览器真实点检照做，web 改动必须起服务用浏览器确认行为。" +
  "技术明细写明核对了哪几条、留白是什么。";

/**
 * 这一段的长度是**权衡过的**：它是整条审查消息里唯一一处回归口径全文（扫描义务的回归面
 * 与清单说明都只留一句指针，见 `review-sweep.ts` / `regression-checks.ts`），所以不能再缩成
 * 一句——三个表面同时缩，口径就没有任何一处讲全了。体积由 `test-prompt-budget.ts` 盯着。
 */

/**
 * 回归证据清单那一段的两半，**拆开是为了让去重分得清静态和动态**。
 *
 * 一条审查消息里这段话会出现两次：任务书正文一份、每回合提醒一份。原先整段当成一块
 * 「重复的协议」，正文里有报告格式就把整条提醒丢掉 —— 连提醒里**这一轮才有的**状态
 * （清单不可用、要把回归面写成留白）一起丢了（第 2 轮审查 F2 实测）。
 *
 * 所以分两半：
 * - `regressionManifestEntry` 是**动态入口**（路径随轮次变，状态不可用时整句换成警告），
 *   只有正文里出现**同一句**时才算重复；
 * - `REGRESSION_MANIFEST_READING` 是**静态判据**（怎么算通过、latest 怎么读），正文讲过
 *   就不必在提醒里再讲一遍。
 *
 * 去重判据住在 `server/src/turn-prompt.ts`，它只认这两个常量，不再拿「正文里有没有某段
 * 任意文本」去推断整条提醒可删。
 */
export const REGRESSION_MANIFEST_PREFIX = "执行者回归证据清单：";

export const regressionManifestEntry = (path: string): string =>
  `${REGRESSION_MANIFEST_PREFIX}${path}。`;

/** 从一段文字里切出那一句入口（去重时按它逐字比对）；没有就返回 null。 */
export function regressionManifestEntryOf(text: string): string | null {
  const at = text.indexOf(REGRESSION_MANIFEST_PREFIX);
  if (at < 0) return null;
  const end = text.indexOf("。", at + REGRESSION_MANIFEST_PREFIX.length);
  return end < 0 ? null : text.slice(at, end + 1);
}

export const REGRESSION_MANIFEST_READING =
  "这份清单只供你**核对执行者登记过什么**：" +
  "reusable 恒为 false，它既不是你的验证结论，也不是让你重跑或补跑的清单；" +
  "一条算通过必须同时满足 passed=true 且 exitCode=0，失败照实报告，不得给通过结论；" +
  // 「只认最新那次」是**读清单的规则**，不是实现说明：同一条命令重跑、新一次还没跑完时，
  // 清单里仍留着上一次 passed=true/exitCode=0 的记录，少了这句话它完全满足「算通过」的
  // 判据，于是一次尚未结束的重跑会被旧的「通过」顶过去（第 1 轮审查 F4）。
  "latest 标记同命令/目录的最新登记，**只按它核对**：最新那次没跑完（passed=null）就把这一面写成留白，" +
  "不能回退用旧的通过结果顶替；旧失败完整保留，按 logPath 读完整输出。" +
  "清单为空、失效或没覆盖到你担心的那一面时，把缺口原样写进覆盖声明的回归面留白，不能用对话自述或旧审查结果代替。";

export const EXECUTOR_REGRESSION_RECORDING =
  REGRESSION_POLICY +
  "登记用 start_monitor(regression=true) 交未过滤的原始命令与实际 cwd（时限等细节见该工具说明），挂完用 pause_task 等结果。" +
  "整套回归不要在本轮跑，也不要只在回复里自述测试通过。";

/**
 * 「这个建任务请求容得下自由工作流吗」——**建任务路由的门禁与默认值共用同一份判据**。
 *
 * 自由工作流只适用于普通单任务：团队/讨论任务、派生执行者（`parentId`）、审查任务
 * （`reviewOf`）各自有自己的编排，自带起手式（`workflow`/`workflowId`）的请求则是明摆着
 * 要走预设那条线。这几种传 `workflowMode: "free"` 一律 409/400。
 *
 * 之所以要把它抽成一个函数：默认值现在按它推导（没显式说就是「配得上就给 free」）。
 * 判据但凡和门禁差一个字，老调用方就会在自己什么都没改的情况下凭空吃 409——它们
 * 压根不知道有 `workflowMode` 这个字段。两处各写一份，早晚漂。
 */
export function freeWorkflowFits(req: {
  mode?: string | null;
  parentId?: string | null;
  reviewOf?: string | null;
  workflow?: unknown;
  workflowId?: string | null;
}): boolean {
  return (req.mode ?? "single") === "single"
    && req.parentId == null
    && req.reviewOf == null
    && req.workflow == null
    && req.workflowId == null;
}

export const FREE_REVIEW_CHECK_MODES = ["syntax", "logic"] as const;
export type FreeReviewCheckMode = (typeof FREE_REVIEW_CHECK_MODES)[number];

/**
 * 「失败后自动复审」允许的最大次数（这条链最多跑 `retryLimit + 1` 轮）。
 * 派审面让用户直接填数字，前端的输入门禁和后端的入参校验必须是同一个上限——
 * 各写一份的话，界面放行的值会在提交那一刻被后端打回。
 */
export const MAX_FREE_REVIEW_RETRIES = 20;

/**
 * 「这条审查意见属不属于本任务」的判据——**唯一一份源**。
 *
 * 判据本体是用户 2026-09-24 的原话「如果偏离了主任务的内容的话就开启一个新的任务」，
 * 2026-10-14 再确认一次：「与本任务内容无关的就裁定」。
 *
 * 为什么必须是常量而不是各处手写：这段话有**两个运行时表面**——修复交接消息
 * （`server/src/free-review-prompts.ts` 的 `disputeOption`）和 MCP 工具 `dispute_review`
 * 注册时的 description / `deferReason` 字段说明（`mcp/src/tools/task-turn.ts`）。执行者
 * **两边都会读到**，于是两边不一致时它拿到的是互相打架的指引。实测后果：server 那侧
 * 已经改成三种形态了，工具说明仍写着「为什么越界(是哪一轮的哪次改动引入的)」、字段
 * 说明仍写着「多半是本轮修复引入的衍生问题」——执行者填一条「基线上本就存在、落在无关
 * 模块」的理由时，按工具说明它根本没有格子可填。回归（`test-free-review-dispute.ts`）
 * 直接拿注册后的实际元数据核这份常量，不是对 server 消息做字符串包含断言。
 *
 * 三种形态必须**并列全列出来**，一条都不许省：这条出路最初只落了「衍生问题」一种，
 * 于是执行者把「不是我上一轮改出来的」读成了「属于本任务」，判据被用反。
 */
export const DEFER_BOUNDARY_CRITERION =
  "判据只有一句：**偏离了本任务的内容就该转出去**。三种形态都算，不是只有最后一种：\n"
  + "- **内容无关**：落点在与本任务目标无关的模块，不碰本任务要改的那条链路；\n"
  + "- **基线既有**：开工起点那一版上就存在，本任务只是被动适配到它；\n"
  + "- **衍生问题**：上一轮你按意见改了，这一轮报的是那次改动带出来的新问题。\n"
  + "**「不是我上一轮改出来的」不等于「属于本任务」**——前两种恰恰都不是你改出来的。";

/**
 * `deferReason` 这个格子该怎么填——同样是唯一一份源，理由同 `DEFER_BOUNDARY_CRITERION`。
 *
 * 「**按实际那一种写**」这句不许省：写死成一种形态的填空（最初那版是「是哪一轮的哪次
 * 改动引入的」），等于把另两种形态挡在门外——答案是「谁都没引入，它一直在那儿」的时候，
 * 执行者只能照改。
 */
export const DEFER_REASON_FIELD_GUIDE =
  "逐条写清：哪几条 + 为什么它不属于本任务"
  + "（无关模块 / 基线即有 / 哪一轮改动引入的，按实际那一种写，能指到文件或 commit 就指）"
  + "+ 建议的独立任务范围";

/**
 * 报告写着「这是类问题」时，边界怎么划——第三份唯一源。
 *
 * 这一句同时被**修复交接**（`review-sweep.ts` 的 `CLASS_REPAIR_NOTE`，自由工作流与
 * 预设/旧验证两条线共用）和 `disputeOption` 用到，所以也必须只有一份。
 *
 * 它最初写成了无条件的「报告点名的根因层级属于本任务边界之内」——那是为了防类问题被
 * 改成单点补丁，可它把**边界判断**也一起替掉了：边界该由**任务目标**定，不由审查者给
 * 的那个标签定。实测反例：只做「广告贴归类」的任务，被报告要求去修一个根因和实例**全部**
 * 落在 YouTube 摘要回填 / wiki 双链化管线里的既有类问题——按这一句，整条意见都被判成界内。
 *
 * 所以三种处置并列，而且**不写具体出口**：这段话被预设工作流那条线共用，那边没有
 * `dispute_review`，写死「用 deferReason」会变成一句指不到东西的话（第 1 轮审查 N1）。
 * 出口由各条交接自己交代。
 */
export const CLASS_PROBLEM_BOUNDARY =
  "「这是类问题」只决定**修在哪一层**，不决定它**是不是本任务的事**——那由本任务目标定：\n"
  + "- 根因与同类实例都在目标内：按报告指的层级修根因、同类实例一并修掉，不算扩大边界；"
  + "只补复现到的那一条触发路径不算修完；\n"
  + "- 根因在目标内、部分实例落在无关模块：根因照修，那几个实例**不属于本任务**，别顺手改；\n"
  + "- 根因**本身**也落在无关模块：**整条意见都不属于本任务**，一个字都不要在这里改。\n"
  + "后两种按本回合给你的边界出路提出来，由用户裁定：判据是**内容**，不是报告给的那个标签。";

/**
 * 「写给用户看的那一句话」该怎么写——**唯一一份源**，MCP 工具说明、交接提示、
 * 入参报错三处共用。
 *
 * 为什么要有这么一条：驳回和辩论发言是写给**用户**看的（他要据此拍板），可执行者写
 * 出来的一直是写给审查者看的辩护书。真实样本（2026-10-19 库里那几条）长 1000~3500 字，
 * 一段到底、满篇 `kb/feeds/x_post.py:211`、`672 条回归`、commit 短 hash——用户 2026-10-20
 * 的原话是「一大篇文字都看不懂」。界面能做的只有折叠，折叠解决的是「太长」，不解决
 * 「看不懂」：展开之后还是那一墙字。所以要在源头多要一句人话。
 *
 * 为什么是**独立字段**而不是「正文第一句写人话」：界面要把它单独摆在首屏、时间线旁注
 * 要拿它当摘要（原来截 reason 前 60 字，截出来的是「本轮认可的部分已先修复、验证并提交
 * ceed925（fix: separa…」——纯噪音）。靠约定格式从正文里切，等于把这件事交给措辞去守。
 *
 * 为什么**上限只有 200 字**：这是规范本身，不只是省地方。200 字塞不进路径、行号和
 * 测试条数，它只装得下一句结论——限额自己把「说人话」这件事钉住了。
 */
export const MAX_PLAIN_SUMMARY_LEN = 200;

/**
 * 同上，一份源。`PLAIN_SUMMARY_GUIDE` 的几处表面见 `MAX_PLAIN_SUMMARY_LEN` 的注释。
 *
 * 规范本体压到一句：它要跟着**每一个**要填 summary 的表面走（两条交接、辩论每一段、
 * 两个工具的说明和字段、入参报错），一句话乘以七处才划得来。示范拆进
 * `PLAIN_SUMMARY_EXAMPLE`，**只挂一处**（见那个常量）。
 */
export const PLAIN_SUMMARY_GUIDE =
  "一两句人话说清结论，讲给没读过这块代码的人听；不要路径、行号、commit、函数名、测试条数"
  + `（上限 ${MAX_PLAIN_SUMMARY_LEN} 字，超出截断）。`;

/**
 * 那一句话的正反示范——**整个运行时只挂一处**：`dispute_review` 的 `summary` 字段说明，
 * 也就是执行者真要动手填那个格子时离得最近的一句。
 *
 * 为什么不跟着 `PLAIN_SUMMARY_GUIDE` 走：示范比规范本体还长，而它只在「第一次写」那一刻
 * 有用；七个表面各带一份，等于为一次性的示范付七份常驻上下文。体积闸（`test-prompt-budget.ts`）
 * 直接断言它在全部渲染样本里**只出现一次**——这就是「单源」在这里的全部含义，不再靠
 * 「两处同文 + 回归钉死」。
 */
export const PLAIN_SUMMARY_EXAMPLE =
  "反面：「第 2 条读错了 kb/feeds/x_post.py:211 的严格增长门，672 条定点回归通过」"
  + "——用户看不出你要他决定什么。正面：「报告说我漏了一道并发保护，但那段代码只在单线程里跑，"
  + "这一条我认为不成立；另外两条我已经改好了。」";

// 审查链只落四个持久状态：reviewing 是唯一的「活」态（旁路审查回合正在跑），
// passed / failed 是链的终局，stopped 是「最后一轮未通过后停住」。
// 「修复中 / 等待复审 / 结论已过期」这些叙事一律**推导**，不落库：
// - 修复中 = 任务本身 running（谁发起的都一样）
// - 等待自动复审 = stopped + 预约槽里挂着 runId
// - 结论过期 = round.reviewedCommit ≠ 当前工作区 HEAD
export type FreeReviewRunStatus = "reviewing" | "passed" | "failed" | "stopped";
export type FreeReviewRoundStatus = "reviewing" | "passed" | "failed" | "error";

export interface ReviewerProfile {
  id: string;
  name: string;
  agentType: AgentType;
  executorId: string | null;
  executorLabel: string | null;
  model: string | null;
  reasoningEffort: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 「这一次审查实际用谁跑」——相对审查者配置的整套覆盖，**不写回审查者本身**。
 *
 * 是整套而不是单个字段：选执行器的形状是一颗三段胶囊（智能体 · 模型 · 智能水平），
 * 换智能体会把后两段打回「跟随执行器」，拆成可选字段就没法表达「这次显式跟随」。
 * null/空 = 跟随该执行器自己的默认，与审查者配置里的同名字段语义一致。
 */
export interface FreeReviewExecutorOverride {
  agentType: AgentType;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
}

/**
 * 「驳回」这条支线的三个概念，**不共用一个状态字段**：
 * - `FreeReviewDispute`：执行者不认某一轮未通过结论（`dispute_review`），链停下来等用户裁定。
 * - `FreeReviewDebate`：用户看过驳回后让双方各自陈词的那几个旁路回合。
 * - `resolution`：**用户**的裁定。审查者在辩论收尾时给的 `verdict` 只是它自己的立场，
 *   两者分开存 —— 让被驳回的一方替用户签字，等于绕过用户裁定这件事本身。
 */
export type FreeReviewDisputeResolution =
  /** 维持审查意见：照报告修 */
  | "upheld"
  /** 采纳执行者：这条未通过意见作废，报告与证据原样留着 */
  | "withdrawn"
  /**
   * 转独立任务：意见**成立**，但偏离了本任务要做的那件事（判据与三种形态见
   * `DEFER_BOUNDARY_CRITERION`，别在这里重写一份）。
   * 建一个 backlog 派生任务把它带走，本轮不再要求在本任务里修；报告与证据同样原样留着。
   *
   * 与 `withdrawn` 的差别只有一处——**这条意见没有作废，只是换了个地方修**。所以它不是
   * 「不想改」的第三种说法：必须由执行者先在 `deferReason` 里逐条写明越界/衍生的依据
   * （没写时服务端拒绝这个裁定），再由用户签字。
   */
  | "deferred";

/** 辩论收尾时**审查者自述**的立场（不是用户裁定，不自动改变任何状态）。 */
export type FreeReviewDebateVerdict = "upheld" | "withdrawn" | "partial";

export type FreeReviewDebateSide = "reviewer" | "executor";
export type FreeReviewDebateStatus = "running" | "finished" | "failed";
export type FreeReviewDebateTurnStatus = "speaking" | "done" | "error";

/** 一次辩论最多几个来回（一个来回 = 审查者答辩 + 执行者回应）。 */
export const MAX_FREE_REVIEW_DEBATE_EXCHANGES = 3;

export interface FreeReviewDebateTurn {
  seq: number;
  side: FreeReviewDebateSide;
  /**
   * 这一段发言的一句话（`PLAIN_SUMMARY_GUIDE`）；null = 还没交卷，或这条是加字段之前的老记录。
   *
   * 七段发言合起来一万字上下（真实样本），而用户开辩论就是为了裁定——他要的是「这段
   * 到底站哪边」，不是逐段读完。界面逐段先摆这一句，正文默认折起来。
   */
  summary: string | null;
  /** 这一段发言正文；还没交卷（speaking/error）时为空串。 */
  statement: string;
  status: FreeReviewDebateTurnStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface FreeReviewDebate {
  id: string;
  status: FreeReviewDebateStatus;
  /** 用户选的来回数；总发言段数 = exchanges * 2 + 1（末尾多一段审查者收尾）。 */
  exchanges: number;
  /** 正在发言的一方；辩论已结束为 null。 */
  currentSide: FreeReviewDebateSide | null;
  verdict: FreeReviewDebateVerdict | null;
  turns: FreeReviewDebateTurn[];
  startedAt: string;
  finishedAt: string | null;
}

export interface FreeReviewDispute {
  /**
   * 写给用户的那一句话（`PLAIN_SUMMARY_GUIDE`）：这条驳回到底要他决定什么。
   * null = 加这个字段之前落的老驳回——界面降级成只显示正文，不假装有摘要。
   *
   * 它是裁定屏的第一行字。两段正文加起来常有两三千字技术论述，用户要的是先知道
   * 「争的是什么」，再决定要不要读依据。
   */
  summary: string | null;
  /** 执行者写的「哪几条不成立 / 哪几条是知情且有意为之」；空串 = 它只提了转出那几条。 */
  reason: string;
  /**
   * 执行者写的「哪几条我认可、但超出本任务边界，建议转独立任务」；null = 没提过。
   *
   * 与 `reason` 分开存而不是挤进同一段文本：界面要据此决定「转为独立任务」那个出口
   * 给不给，服务端也要据此拒绝凭空的 `deferred` 裁定——靠在自由文本里找关键词判断，
   * 等于把一条裁定门禁交给措辞去守。
   */
  deferReason: string | null;
  at: string;
  /** 用户的裁定；null = 还在等用户。 */
  resolution: FreeReviewDisputeResolution | null;
  resolvedAt: string | null;
  /**
   * 用户裁定时写给执行者的要点；null = 没写。
   *
   * 为什么裁定光有三档不够：辩论经常辩出「第 2 条我认，但按后来达成的那个方案做，
   * 不是报告里的原方案」这种结论——`upheld` 会让执行者照原报告改（正好是双方都已
   * 否掉的那版），`withdrawn` 又把整条意见作废，三档一个都表达不了它。没有这一栏时
   * 用户只能事后再手打一条续聊，而那段话不在任何结构化状态里：下次打开任务看不见，
   * 接力到别的机器也不跟着走。
   *
   * 它**压过报告**（措辞见服务端 freeManualRepairPrompt）：裁定人是用户，报告只是
   * 审查者的一份判断。
   */
  resolutionNote: string | null;
  /** `deferred` 裁定后建出的那个 backlog 派生任务；其它裁定恒为 null。 */
  deferredTaskId: string | null;
  /** 这一条驳回上开过的辩论，按开始时间排；空数组 = 还没辩过。中断过的可以重开，
   *  所以同一条驳回上可能有多条（辩完的那条会挡住再开，判据在服务端）。 */
  debates: FreeReviewDebate[];
}

export interface FreeReviewRound {
  round: number;
  status: FreeReviewRoundStatus;
  conclusion: "verified" | "verify_failed" | null;
  /** 本轮启动时任务工作区的 HEAD；与当前 HEAD 不一致即「结论陈旧」。null = 未能取到（老数据/工作区缺失）。 */
  reviewedCommit: string | null;
  reportMarkdown: string;
  screenshots: string[];
  /** 执行者对这一轮结论的驳回；null = 没驳回过（绝大多数轮次）。 */
  dispute: FreeReviewDispute | null;
  startedAt: string;
  endedAt: string | null;
}

export interface FreeReviewRun {
  id: string;
  reviewerId: string | null;
  reviewerName: string;
  agentType: AgentType;
  executorId: string | null;
  executorLabel: string | null;
  model: string | null;
  reasoningEffort: string | null;
  checkMode: FreeReviewCheckMode;
  note: string | null;
  /** 省略视为老数据的任务工作区审查。 */
  target?:
    | { kind: "workspace" }
    | {
        kind: "accepted_merge";
        branch: string;
        baseCommit: string;
        mergeCommit: string;
        repairTaskId: string | null;
      };
  retryLimit: number;
  currentRound: number;
  status: FreeReviewRunStatus;
  rounds: FreeReviewRound[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface FreeWorkflowPreviewState {
  gen?: string | null;
  services?: PreviewServiceState[];
  proxied?: boolean;
  /** 起来了**或者正在起**。界面拿它决定那颗开关是「打开预览」还是「关掉」。 */
  running: boolean;
  /**
   * 还在启动（装依赖 / 等就绪）。这一段能长到八分钟，期间没有 url、也随时可以被收掉，
   * 所以它跟「起来了」必须分得开：文案要说「正在启动…（点这里取消）」而不是「关闭预览」，
   * 「预览页」那个链接也不能给。
   */
  starting: boolean;
  // 这个任务盘上有没有预览启动日志。跟 running 是两件事：**起失败的那次也留着日志**，
  // 而那一次恰恰最需要看 —— 只按 running 给入口，用户永远看不到失败现场。
  hasLog: boolean;
  url: string | null;
  port: number | null;
  command: string | null;
  startedAt: string | null;
}

export type FreeWorkflowExecutionStatus = "running" | "completed" | "failed" | "canceled" | "paused";

export interface FreeWorkflowExecution {
  id: string;
  status: FreeWorkflowExecutionStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface FreeWorkflowState {
  taskId: string;
  selectedReviewerId: string | null;
  /** 服务端生成快照的单调时间戳。前端只接受更新的快照——「响应到达顺序」不是版本，
   *  早先生成、更晚到达的 mutation 响应不能盖掉后来 GET 拿到的新世界。 */
  stateVersion: number;
  /** 当前任务工作区 HEAD；null = 工作区不存在（如已验收清理）或不是 git 目录。 */
  workspaceHead: string | null;
  /** 工作区是否有未提交改动；null = 取不到（按未知处理，不能当干净）。 */
  workspaceDirty: boolean | null;
  reviewReservation: {
    armed: boolean;
    reviewerId: string | null;
    checkMode: FreeReviewCheckMode | null;
    retryLimit: number | null;
    note: string | null;
    /** 非空 = 本次预约要用的执行器覆盖（审查者配置没被改，只有这一次这么跑）。 */
    override: FreeReviewExecutorOverride | null;
    /** 非空 = 这是自动复审链的续轮预约（修复回合正常结束后在该 run 上续下一轮）。 */
    runId: string | null;
  };
  /**
   * 此刻在跑的是**审查/验证旁路回合**（只读工作区、写报告、给结论，不产出新一版代码）。
   *
   * 界面拿它给预览类动作开门：「任务在跑 = 代码改到一半，预览没有意义」这条对旁路回合
   * 不成立——审查那十几分钟恰恰是最想自己打开页面看一眼的时候。判据取服务端的运行时
   * 事实（turn 的 role），不是「库里有没有 reviewing run」，理由见 server/review-turn.ts。
   */
  reviewTurn: boolean;
  /** 预览是「随手开一眼」的看片器，不是工作流里的一步：只报当下开没开，不留开关历史。 */
  preview: FreeWorkflowPreviewState;
  executions: FreeWorkflowExecution[];
  reviews: FreeReviewRun[];
}

export interface FreeReviewDispatchInput {
  reviewerId: string;
  checkMode: FreeReviewCheckMode;
  retryLimit: number;
  note?: string | null;
  /** 本次审查的执行器覆盖；缺省/null = 就按审查者自己的配置跑。 */
  override?: FreeReviewExecutorOverride | null;
}
