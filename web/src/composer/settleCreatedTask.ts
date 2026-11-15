import type { Task } from "@ash/shared";
import { api } from "../lib/api.ts";
import type { Draft, DraftHandle } from "../lib/DraftStore.tsx";
import type { LaunchMode } from "./ComposerLaunchControl.tsx";
import type { ComposerOpening } from "./composerOpening.ts";

/**
 * 创建成功之后的收尾:草稿归属裁决 → 按启动方式排队/启动/定时 → 回写 onCreated。
 *
 * 提交是异步的,完成时发起那份面板可能早已卸载(用户切走、删了刚建的任务又开了
 * 新面板),共享草稿(按项目一份,见 composerDraft.ts)可能已被新面板接管。收尾
 * 必须绑定**本次提交**的归属(第 9、10 轮审查:旧请求的收尾清掉了用户正在写的新
 * 草稿/新附件):
 * - 清草稿:面板还挂着照常清;已卸载时交给 clearIfUnchanged 按提交时刻的草稿
 *   对象引用做原子裁决——引用相同 ⇔ 正文、附件、在途上传、回链、截图全都没动过,
 *   任何变化(含改过又改回)都让旧提交失去清空资格;
 * - 随手记回链交**提交那一刻**捕获的 noteIds,不读完成时的(那可能是新面板的);
 * - ownsComposer 一并交给上层,上层只在它为 true 时收面板。
 *
 * 框里 `@` 了人时「启动」就是起第一回合(问一句 / 讨论)。它没被服务端接下,任务虽已建好,这次提交却没办成:
 * 不收尾——草稿、叫的人原样留着,这条任务记进草稿(onOpeningFailed),再按一次只对它重发这一下,不再建一条。
 * 返回值:这次提交办成了没有(没办成时调用方别把叫的人当「已发出」清掉)。
 */
export async function settleCreatedTask(args: {
  task: Task;
  launchMode: LaunchMode;
  scheduleAt: string;
  scheduleCron: string;
  /** 框里 `@` 了人：「创建并运行」那一下换成它起第一回合（只在 launchMode="run" 时有）。 */
  opening?: ComposerOpening | null;
  /** 第一回合没被接下：把这条已建好的任务连同原因记下来，留给下一次提交重发。 */
  onOpeningFailed?: (task: Task, error: string) => void;
  /** 提交那一刻的草稿对象(归属标识)与随手记回链。 */
  submitted: { draft: Draft; noteIds: string[] };
  /** 发起提交的那份面板此刻是否仍挂载。 */
  panelMounted: () => boolean;
  draft: Pick<DraftHandle, "clear" | "clearIfUnchanged">;
  resetLabels: () => void;
  enqueue: (task: Task) => Promise<{ task: Task; members: Task[]; message: string }>;
  onCreated: (task: Task, noteIds: string[], ownsComposer: boolean) => void;
  onTasksSynced?: (tasks: Task[]) => void;
  notify: (message: string) => void;
}): Promise<boolean> {
  const { submitted, notify } = args;
  let task = args.task;
  // 创建成功了草稿才丢:中途任何一步失败都原样留着,用户回到面板还能接着改。
  const finishCreation = () => {
    const ownsComposer = args.panelMounted();
    if (ownsComposer) {
      args.resetLabels();
      args.draft.clear();
    } else {
      args.draft.clearIfUnchanged(submitted.draft);
    }
    args.onCreated(task, submitted.noteIds, ownsComposer);
  };
  if (args.launchMode === "create") {
    finishCreation();
    notify("任务已创建");
    return true;
  }
  if (args.launchMode === "queue") {
    // 创建成功后排队失败不回滚任务(enqueue 如实分开报两段结果);成功时 task
    // 换成入队后的最新快照,免得旧快照把 SSE 已送达的队列字段盖回去。前驱等
    // 全体成员快照整批交给 onTasksSynced 同步(第 5 轮审查:前驱不同步会丢
    // 队列徽标、再排一次还会重复建队)。
    const result = await args.enqueue(task);
    task = result.task;
    finishCreation();
    if (result.members.length) args.onTasksSynced?.(result.members);
    notify(result.message);
    return true;
  }
  let launchError: unknown = null;
  try {
    if (args.launchMode === "run") await (args.opening ? args.opening.start(task) : api.runTask(task.id));
    else if (args.launchMode === "once") {
      await api.setSchedule(task.id, { kind: "once", at: new Date(args.scheduleAt).toISOString(), cron: null });
    } else {
      await api.setSchedule(task.id, { kind: "cron", at: null, cron: args.scheduleCron.trim() });
    }
  } catch (error) {
    launchError = error;
  }
  const reason = launchError instanceof Error ? launchError.message : "未知错误";
  if (launchError && args.opening && args.onOpeningFailed) {
    args.onOpeningFailed(task, reason);
    notify(`任务已创建，但${args.opening.what}没发出去：${reason}。再按一次只重发这一下，不会再建一条`);
    return false;
  }
  finishCreation();
  if (launchError) {
    notify(`任务已创建，但${args.launchMode === "run" ? "启动" : "定时设置"}失败：${reason}`);
    return true;
  }
  notify(args.launchMode === "run"
    ? args.opening?.started ?? "任务已创建并启动"
    : args.launchMode === "once"
      ? "任务已创建，已设置一次性定时"
      : "任务已创建，已设置 Cron 定时");
  return true;
}
