// 工具入参里反复出现的取值域与形状。单独一份是为了**只有一份**：以前 agent 类型在
// 各处写死，新增一个执行器后 MCP 侧会莫名 400（见下面那段注释）。
import { z } from "zod";
import { AGENT_TYPES, STAGE_ORDER } from "@navi/shared";
import { RECURS_SHAPE_ERROR } from "@navi/shared/free-workflow";
import { MAX_WITHDRAW_REASON_LEN } from "@navi/shared/dispatch-suggestion";

export const AGENT_TYPE = z.enum(AGENT_TYPES);
export const MODE = z.enum(["parallel", "serial"]);
export const TASK_STATUS = z.enum(["backlog", "done", "failed", "canceled"]);
export const TASK_STAGE = z.enum(STAGE_ORDER);

// report_stage 的 `recurs`（同类问题承接）。只认服务端 `parseCarries` 读得懂的两种形状：
// `{"1":"2.1.1"}`（字段说明教的那种）和 `[{finding:1, from:"2.1.1"}]`；被序列化成字符串的同样先解开再核。
// 形状不对**在这里当场拒**、带一句正确示例（`RECURS_SHAPE_ERROR`）：以前是 `z.any()`，错位一路
// 放到服务端被静默丢掉，审查者到回合结束都不知道自己白填了（v9Ps5S1vbnKt 三轮裸编号数组）。
// MCP SDK 把校验失败包成 isError 的工具结果，审查者同一回合里改正重发即可。
// 编号对不上清单这类「形状对、内容不对」的仍归服务端，按没填算 —— 那一层这里看不见。
//
// 不把这两种形状展开进 JSON Schema：字段说明里已经带形状和示例，展开只会让每个回合的工具清单
// 多背一截结构；不填（含 null、空串）照旧合法。
const RECURS_SHAPE = z.union([
  z.record(z.string().regex(/^[1-9]\d*$/), z.string().min(1)),
  z.array(z.object({ finding: z.number().int().positive(), from: z.string().min(1) }).strict()),
]);
export const RECURS = z.unknown().superRefine((value, ctx) => {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return;
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { /* 不是 JSON 的字符串，下面照样不合格 */ }
  }
  if (!RECURS_SHAPE.safeParse(parsed).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: RECURS_SHAPE_ERROR });
});

// 工作方式。新建任务一律是自由工作流，起手式已停止新建，所以这里不再介绍 preset、也不在
// 本地拦：传什么都原样转给服务端，由 `createWorkflowMode` 统一拒并说明原因。字段删掉的话
// zod 会把旧调用方传的 `"preset"` 静默剥掉，它拿到一条自由工作流任务却以为是预设线。
export const WORKFLOW_MODE = z.string().describe("缺省即可：新建任务一律是自由工作流");

// 前置 vs 队列：派活的智能体最容易混的一处，两段说明在这里各留一份，几个工具共用。
export const PREREQUISITES_GUIDE =
  "前置：建在哪几条任务上面（同批写 key，已有的写 id）。前置都完成且审查通过就自动起跑，开工即有前置的代码、diff 不含前置的，不等验收；别再在任务说明里写「没合入就提问等着」";
export const QUEUE_VS_PREREQUISITES =
  "只要一个接一个跑、不要对方的代码，用 chain（队列）；要前一条的代码，用 prerequisites 或 stack（前置），只依赖同一条前置的会同时起";

// 谁来审：建出来就带审查预约，执行回合正常结束后自动开审（shared/src/review-on-create.ts）。
// MCP 这一侧**缺省就带**（落成 "default" = 用户在设置里设的默认审查者），关掉只认用户的原话。
export const REVIEWER_GUIDE =
  "谁来审：缺省 = 用户设的默认审查者（没设就不审），建出来就带审查预约、完成后自动开审；写名字或 id = 交给那一位；"
  + "null = 不审 —— 只有用户明说「不用审」才传，别自己判断这条不用审";
// 空白不是一位审查者，也不是「不审」（关掉只认 null）：当参数错退回去，跟 HTTP 那一侧对显式空名的处理一样。
export const REVIEWER = z.string().trim().min(1, "reviewer 不能是空白；不审查请传 null").nullable().optional().describe(REVIEWER_GUIDE);

/** 工具参数里的 reviewer 落成建任务请求里的 review：缺省带默认，null 不审，其余按名字或 id 指定。 */
export function reviewChoiceOf(reviewer: string | null | undefined): "default" | "none" | { reviewer: string } {
  if (reviewer === undefined) return "default";
  if (reviewer === null) return "none";
  return { reviewer: reviewer.trim() };
}

// One task spec, reused by batch_create_tasks and create_task_chain.
// 字段说明不写「覆盖批次默认」：两个工具的批次默认值直接复用这里的字段实例，序列化时折成 `$ref`，
// 同一段说明只发一遍（覆盖关系由批次默认那一层自己的说明交代）。
// 注意:不再接受 dependsOn / resumeDependsOn —— 顺序依赖统一走 queue,
// chain:true 是创建队列的语法糖。要细调队列请用 queue_* 工具。
export const taskShape = z.object({
  key: z.string().optional().describe("此任务在这一批里的本地标识，同一批的 prerequisites 用它指这条"),
  title: z.string().optional().describe("省略则首次运行时由 agent 自动起名"),
  body: z.string().optional().describe("交给 agent 执行的 prompt / 目标"),
  agentType: AGENT_TYPE.optional().describe("交给哪类 agent"),
  executorId: z.string().nullable().optional().describe("执行器 profile(agents.id)；为空/悬空按 agentType 默认执行器降级"),
  model: z.string().nullable().optional().describe("模型；缺省/null=跟随执行器"),
  reasoningEffort: z.string().nullable().optional().describe("思考强度；缺省/null=跟随执行器"),
  useWorktree: z.boolean().optional().describe("是否在独立 worktree 中运行；缺省跟随全局默认，非 git 项目始终为 false"),
  worktreeBase: z.string().nullable().optional().describe("开工起点：本地/远端分支（如 origin/foo）、tag、提交，或父任务分支（另记验收依赖）；服务端冻结成提交，解析不出直接报错。远端的建任务前先 fetch，没给合入分支就合进本地同名分支（没有就建跟踪分支）"),
  mergeTargetBranch: z.string().nullable().optional().describe("最终合入分支；派生任务默认继承父任务的最终目标，独立于开工起点"),
  workflowMode: WORKFLOW_MODE.optional(),
  labels: z.array(z.string()).optional().describe("任务标签"),
  prerequisites: z.array(z.string()).optional().describe(PREREQUISITES_GUIDE),
  reviewer: REVIEWER,
});

// 要派出去的活的一件（suggest_dispatch）：标题、完整说明、一句为什么必填——框顶一行就是标题和那句话，建出来的
// 任务正文就是 body；其余照建任务那几个参数（交给谁、谁来审、标签、同批前置），从哪开工只留 trunk / here 两档。
export const suggestionShape = z.object({
  key: taskShape.shape.key,
  title: z.string().min(1).describe("框顶这一行的标题"),
  body: z.string().min(1).describe("新任务的完整正文：目标、背景、约束、验收标准"),
  note: z.string().max(120).describe("一句话：为什么该做、要注意什么"),
  base: z.enum(["trunk", "here"]).optional().describe("trunk=从主分支开工(默认)；here=接着本任务的代码"),
  agentType: AGENT_TYPE.optional().describe("交给谁；不填=本任务「派出去的活交给谁」的默认"),
  executorId: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  labels: taskShape.shape.labels,
  prerequisites: taskShape.shape.prerequisites,
  reviewer: REVIEWER,
});

// 收回一件挂着的（suggest_dispatch 的 withdraw）：原因原样给用户看，是他知道「它为什么不在了」的唯一去处。
export const suggestionWithdrawShape = z.object({
  id: z.string().min(1).describe("挂时返回的 id"),
  reason: z.string().min(1).max(MAX_WITHDRAW_REASON_LEN).describe("为什么不用派了，用户会看到"),
});
