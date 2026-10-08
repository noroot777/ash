import type { Task } from "@ash/shared";
import { api } from "../lib/api.ts";
import type { DraftHandle } from "../lib/DraftStore.tsx";
import type { LaunchMode } from "./ComposerLaunchControl.tsx";

/**
 * 创建成功之后的收尾:草稿归属裁决 → 按启动方式排队/启动/定时 → 回写 onCreated。
 *
 * 提交是异步的,完成时发起那份面板可能早已卸载(用户切走、删了刚建的任务又开了
 * 新面板),共享草稿(按项目一份,见 composerDraft.ts)可能已被新面板接管。收尾
 * 必须绑定**本次提交**的归属(第 9 轮审查:旧请求的收尾清掉了用户正在写的新草稿):
 * - 清草稿:面板还挂着照常清;已卸载时只有草稿仍与提交那份一致(正文与回链都没
 *   动过,没人接管)才能清,否则一个字都不碰;
 * - 随手记回链交**提交那一刻**捕获的 noteIds,不读完成时的(那可能是新面板的);
 * - ownsComposer 一并交给上层,上层只在它为 true 时收面板。
 */
export async function settleCreatedTask(args: {
  task: Task;
  launchMode: LaunchMode;
  scheduleAt: string;
  scheduleCron: string;
  /** 提交那一刻的正文与随手记回链。 */
  submitted: { text: string; noteIds: string[] };
  /** 发起提交的那份面板此刻是否仍挂载。 */
  panelMounted: () => boolean;
  draft: Pick<DraftHandle, "read" | "clear">;
  resetLabels: () => void;
  enqueue: (task: Task) => Promise<{ task: Task; members: Task[]; message: string }>;
  onCreated: (task: Task, noteIds: string[], ownsComposer: boolean) => void;
  onTasksSynced?: (tasks: Task[]) => void;
  notify: (message: string) => void;
}): Promise<void> {
  const { submitted, notify } = args;
  let task = args.task;
  // 创建成功了草稿才丢:中途任何一步失败都原样留着,用户回到面板还能接着改。
  const finishCreation = () => {
    const ownsComposer = args.panelMounted();
    const current = args.draft.read();
    if (ownsComposer || (current.text === submitted.text && current.noteIds === submitted.noteIds)) {
      args.resetLabels();
      args.draft.clear();
    }
    args.onCreated(task, submitted.noteIds, ownsComposer);
  };
  if (args.launchMode === "create") {
    finishCreation();
    notify("任务已创建");
    return;
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
    return;
  }
  let launchError: unknown = null;
  try {
    if (args.launchMode === "run") await api.runTask(task.id);
    else if (args.launchMode === "once") {
      await api.setSchedule(task.id, { kind: "once", at: new Date(args.scheduleAt).toISOString(), cron: null });
    } else {
      await api.setSchedule(task.id, { kind: "cron", at: null, cron: args.scheduleCron.trim() });
    }
  } catch (error) {
    launchError = error;
  }
  finishCreation();
  if (launchError) {
    notify(`任务已创建，但${args.launchMode === "run" ? "启动" : "定时设置"}失败：${launchError instanceof Error ? launchError.message : "未知错误"}`);
    return;
  }
  notify(args.launchMode === "run"
    ? "任务已创建并启动"
    : args.launchMode === "once"
      ? "任务已创建，已设置一次性定时"
      : "任务已创建，已设置 Cron 定时");
}
