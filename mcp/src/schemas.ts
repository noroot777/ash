// 工具入参里反复出现的取值域与形状。单独一份是为了**只有一份**：以前 agent 类型在
// 各处写死，新增一个执行器后 MCP 侧会莫名 400（见下面那段注释）。
import { z } from "zod";
import { AGENT_TYPES, STAGE_ORDER } from "@ash/shared";
import { RECURS_SHAPE_ERROR, TASK_WORKFLOW_MODES } from "@ash/shared/free-workflow";

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

// 工作方式。**措辞是给 agent 看的判据，不是字段说明**：它手上只有这段话能决定选哪个，
// 说成「free / preset 二选一」它就会随便挑一个。所以直接写「默认 free，什么时候才该改」。
export const WORKFLOW_MODE = z.enum(TASK_WORKFLOW_MODES).describe(
  "工作方式,缺省 free。free=自由工作流:建完就跑,跑完由人在界面上随时派审查、开预览、" +
  "驳回审查意见——**绝大多数活都该用这个**。preset=预设工作流:按固定站点线走" +
  "(实现→验证→预览→人工→验收),只在你确实要那条线、或要指定 workflowId 起手式时才选;" +
  "选了它界面上没有「派审查/打开预览」入口。",
);

// One task spec, reused by batch_create_tasks and create_task_chain.
// 注意:不再接受 dependsOn / resumeDependsOn —— 顺序依赖统一走 queue,
// chain:true 是创建队列的语法糖。要细调队列请用 queue_* 工具。
export const taskShape = z.object({
  key: z.string().optional().describe("此任务的本地标识(目前没有内部用途,保留供日志/调试)"),
  title: z.string().optional().describe("省略则首次运行时由 agent 自动起名"),
  body: z.string().optional().describe("交给 agent 执行的 prompt / 目标"),
  agentType: AGENT_TYPE.optional().describe("覆盖批次默认 agent"),
  executorId: z.string().nullable().optional().describe("覆盖批次默认执行器 profile(agents.id)；为空/悬空按 agentType 默认执行器降级"),
  model: z.string().nullable().optional().describe("覆盖执行器 profile 的模型；缺省/null=跟随执行器"),
  reasoningEffort: z.string().nullable().optional().describe("覆盖执行器 profile 的思考强度；缺省/null=跟随执行器"),
  useWorktree: z.boolean().optional().describe("是否在独立 worktree 中运行；缺省跟随全局默认，非 git 项目始终为 false"),
  worktreeBase: z.string().nullable().optional().describe("开工起点；可选父任务分支，服务端冻结该提交并记录验收依赖"),
  mergeTargetBranch: z.string().nullable().optional().describe("最终合入分支；派生任务默认继承父任务的最终目标，独立于开工起点"),
  workflowMode: WORKFLOW_MODE.optional(),
  labels: z.array(z.string()).optional().describe("任务标签"),
});
