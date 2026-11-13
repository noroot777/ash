// 任务「此刻能做什么」—— 服务端算、前端照着画（server/src/task-action-verdicts.ts）。
//
// 为什么只能有一份判据：前端按任务状态自己推、服务端路由另有一套挡板时，两边迟早说的不是一回事，
// 于是「按钮亮着、点了被拒」。所以每个动作的路由守卫和这里下发的结论是**同一个函数**算的：下发说
// 能做，路由就不会因为确定性的事实拒绝；下发说不能做，路由给出的就是同一句原因。
//
// 只有一类拒绝仍会发生：两个操作撞在一起（回合锁、验收锁、加成员锁这些只在内存里、转瞬即逝的
// 占位）。它们不进这里的结论 —— 进了也只会在锁放开的那一刻变成过期的「不能做」—— 只由路由在
// 确定性判据之后再查一遍，被拒时页面照常把服务端那句原因说出来。
//
// 不随任务列表下发：列表一次一千多行，而且行是被 `task.status` 这类轻量事件就地改写的，挂在行上的
// 结论会在第一条状态事件之后就过期。它走自己的通道：`GET /tasks/:id/actions` 取一次，之后由
// `task.actions` 事件推送（任一相关事实变了，服务端重算并广播）。

/**
 * 一个动作此刻的结论。
 * - `ok: true`：可以做；
 * - `ok: false`：做不了，`reason` 是路由拒绝时会说的那一句；
 *   `hidden` = 这个状态下界面上根本不该出这颗键（有别的入口在管这件事，或者这件事无从谈起），
 *   不带 `hidden` = 键照出、灰着，指上去说 `reason`。
 */
export type ActionVerdict =
  | { ok: true }
  | { ok: false; reason: string; hidden?: true };

/** 「此刻轮到你的那一步」：失败了是重试，没跑/取消了是运行，停在检查点上是继续。 */
export type PrimaryActionKind = "run" | "retry" | "resume";
export type PrimaryAction = ActionVerdict & { kind: PrimaryActionKind };

/**
 * 「继续本轮审查」认的那一轮：哪条链、第几轮、这一轮此刻的代次（服务端原样核对）；
 * `sessionId` = 这一轮输入实际进过的会话（null = 这一轮还没有会话）。
 */
export type ReviewRetryIdentity = { runId: string; round: number; generation: string | null; sessionId: string | null };

/**
 * 重跑上一回合：普通回合挂在会话里那一回合失败那句话后面（认 `sessionId`），审查档挂在审查格结论
 * 行和会话尾注上（认 `review`）。
 */
export type RetryTurnAction = ActionVerdict & (
  | { kind: "turn"; sessionId: string }
  | { kind: "review"; review: ReviewRetryIdentity }
);

export type TaskActions = {
  taskId: string;
  /** 服务端计算序号，只增不减：前端据此丢掉迟到的旧结论。 */
  seq: number;
  /** null = 这个状态下没有「轮到你的那一步」（在跑、已完成、等裁决…）。 */
  primary: PrimaryAction | null;
  stop: ActionVerdict;
  /** 归档。已归档的任务这里是 hidden，出的是「取消归档」（它只有撞车才会被拒，不在这里）。 */
  archive: ActionVerdict;
  requeue: ActionVerdict;
  /** null = 上一回合没有可重跑的（没崩、或者根本不是这条路管的）。 */
  retryTurn: RetryTurnAction | null;
  /** 派一轮就地验证（预设工作流的「验证」那一站）。 */
  verify: ActionVerdict;
};
