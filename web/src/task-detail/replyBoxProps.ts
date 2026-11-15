import type { ReactNode, RefObject } from "react";
import type { AgentType, SkillEntry, Task, TaskListItem } from "@ash/shared";
import type { QuestionAnswerInput } from "@ash/shared/questions";
import type { DispatchLaunchInput, DispatchRunTarget } from "@ash/shared/dispatch-plan";
import type { IconMenuItem } from "../components/IconMenu.tsx";
import type { ReplyTaskResult } from "../lib/api.ts";
import type { ConversationItem } from "./conversationModel.ts";
import type { MentionTarget } from "./mentionPicker.ts";
import type { ReplyOverride } from "./replyOverride.ts";
import type { StandingExecutor } from "./useStandingExecutor.ts";

/** 任务页回复框（ReplyBox.tsx）的接口：宿主给它什么、它回头调什么。单独成文件守 700 行。 */
export type ReplyBoxProps = {
  task: Task;
  hasConversation: boolean;
  onSend: (
    text: string,
    attachments: string[],
    options: {
      agent?: AgentType;
      executorId?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
      sendAt?: string;
      afterTaskId?: string;
      // 只用于显示:这一回合会由谁跑。服务端不认这个字段(调用方要摘掉再发),
      // 它补的是「消息已发出、会话行还没落库」那一两秒里横幅没名字可报的空窗。
      executorLabel?: string | null;
    },
    // 返回 null = **这一句没送出去,而且不是错误**(典型:换执行器的确认框被取消)。
    // 输入框里的字、附件、@选中的执行器全部原样留着，用户点一下就能重来。
  ) => Promise<ReplyTaskResult | null>;
  /**
   * 停掉这一轮（在跑）或不排了（排着队）。给了才有停止键：任务头上不再有停止，它就是发送键的
   * 另一面（docs/ui-ux-audit reply-4）。
   */
  onStop?: () => Promise<void>;
  /** 服务端说此刻停不了的那句原因（停止结论 `blocker`）：给了 onStop 时停止键灰着说它。 */
  stopBlocked?: string | null;
  /**
   * 点胶囊改执行器/模型/智能水平 = 改**这个任务以后都用谁**，由调用方写回任务
   * （PATCH /tasks/:id）。不传就只剩 `@` 那条一次性召唤，胶囊变成只读。
   * `label` 只是提示文案用的执行器名，别当业务字段使。
   */
  onStandingExecutorChange?: (next: StandingExecutor, label: string) => Promise<void>;
  command?: {
    matches: (text: string) => boolean;
    onSubmit: (text: string) => void;
    onChange?: (text: string) => void;
    onCancel?: () => void;
    resetKey?: number;
    items: { command: string; label: string; hint?: string }[];
  };
  // 当前执行器已装的技能。选中只把 `/名字` 补进正文，不把它当派生命令截走；
  // server 会在运行这一回合前注入对应 SKILL.md。
  skills?: SkillEntry[];
  inlinePanel?: ReactNode;
  /** 框上方只放状态（验收前置命令在跑之类）；没有就不占地方。 */
  topRail?: ReactNode;
  /** 框里那一行左边、附件后面的动作（再审、打开预览、接力到…）（docs/ui-ux-audit reply-3）。 */
  actions?: ReactNode;
  /** 「更多」里除截图批注以外的项（预览日志）。 */
  moreItems?: IconMenuItem[];
  /** 「更多」那颗键：它里面开出的对话框关上以后焦点回到这里。 */
  moreRef?: RefObject<HTMLButtonElement | null>;
  conversationItems?: ConversationItem[];
  /** 「等某任务完成后发送」的候选,以及托盘里报出在等谁。 */
  tasks?: TaskListItem[];
  /** 这个框此刻被借用（等你裁定时框顶那一行）；见 replyOverride.ts。 */
  override?: ReplyOverride;
  /** 有问题在等时怎么答：给了，框那一格就由答题卡接管（QuestionSlot.tsx）。第三个参数是卡对的那一条。 */
  onAnswer?: (answer: string, input: QuestionAnswerInput, asking: TaskListItem) => Promise<void>;
  /** 那一问是一张派活单时，「派出去」交给 ash 照卡建（DispatchPlanCard.tsx）。第二个参数是卡对的那一条。 */
  onLaunchPlan?: (input: DispatchLaunchInput, asking: TaskListItem) => Promise<void>;
  /** 「派出去的活交给谁」（胶囊点开那一层里的一行）：null = 同这里。不给就不出这一行。 */
  onDispatchTargetChange?: (target: DispatchRunTarget | null) => Promise<void>;
  /** 这一格此刻是谁的卡；不给就是这条任务自己（名下派出的任务来问时由宿主给那一条）。 */
  asking?: TaskListItem | null;
  /**
   * `@` 了人之后的「派出去」：开一条新任务交给他（replyDispatch.ts）。失败就抛，框里的人、做法和字都留着。
   * 不给 = 这里派不出去（团队执行者、审查任务），`@` 只剩问一句，框顶那一行不出。
   */
  onDispatch?: (input: { text: string; attachments: string[]; target: MentionTarget; worktreeBase: string | null }) => Promise<void>;
};
