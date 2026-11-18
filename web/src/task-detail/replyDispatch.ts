// 回复框里「派出去」那一按真正做的事：开一条新任务交给叫的那个人，挂在这条任务名下，建完就起跑。
// 单独成文件是为了守住 TaskDetail 的 700 行，也跟「问一句」那条（replySend.ts）对称。
//
// 这条任务自己的智能体不被叫醒、不占回合：只建任务、起跑新任务，不往这条任务的会话里送任何话，
// 所以它正在跑的时候也照派不误。新任务是普通任务——自己的 worktree 跟随默认；建出来就带审查预约（框里那颗
// 「谁来审」，缺省默认审查者，shared/src/review-on-create.ts）。
import type { Task } from "@ash/shared";
import { provisionalTitle } from "@ash/shared/provisional-title";
import { concreteReviewChoice } from "@ash/shared/review-on-create";
import { reviewerProfilesStore } from "../free-workflow/reviewerProfilesStore.ts";
import { api } from "../lib/api.ts";
import type { Notify } from "../lib/notify.ts";
import type { ReplyBoxProps } from "./replyBoxProps.ts";
import { buildDispatchBody } from "./taskDerivation.ts";

type Dispatch = NonNullable<ReplyBoxProps["onDispatch"]>;

export function replyDispatch({ task, onCreated, notify }: {
  task: Task;
  /** 建好了：并进任务列表（右侧「子任务」、侧栏、会话里那一句都从列表里认）。 */
  onCreated: (created: Task) => void;
  notify: Notify;
}): Dispatch {
  return async ({ text, attachments, target, worktreeBase, review }) => {
    // 带着这场对话到此为止的背景（taskDerivation.ts）。
    const sessions = await api.sessions(task.id);
    const created = await api.createTask({
      projectId: task.projectId,
      title: provisionalTitle(text),
      autoTitle: true,
      body: buildDispatchBody(task, sessions, text),
      attachments,
      mode: "single",
      agentType: target.agent,
      executorId: target.executorId,
      model: target.model,
      reasoningEffort: target.reasoningEffort,
      dispatchedBy: task.id,
      worktreeBase,
      // 照胶囊上此刻画着的那一位派（清单就是那颗胶囊读进缓存的那一份）。
      review: concreteReviewChoice(review, reviewerProfilesStore.current()),
    });
    onCreated(created);
    // 起跑没成不算派失败：任务已经在「子任务」里了，框照常清掉，说清楚去那里重试。
    try {
      await api.runTask(created.id);
    } catch (error) {
      notify(`新任务已建好，但没能起跑：${error instanceof Error ? error.message : "未知错误"}。在「子任务」里打开它再运行`);
    }
  };
}
