import type { Task } from "@ash/shared";
import { api } from "../lib/api.ts";
import type { Draft, DraftHandle } from "../lib/DraftStore.tsx";
import type { LaunchMode } from "./ComposerLaunchControl.tsx";
import type { ComposerOpening } from "./composerOpening.ts";

/**
 * 创建成功之后的收尾:草稿归属裁决 → 按启动方式排队/启动/定时 → 回写 onCreated。
 *
 * 提交是异步的,结果回来时发起那份面板可能早已卸载(用户切走、删了刚建的任务又开了
 * 新面板),共享草稿(按项目一份,见 composerDraft.ts)也可能已被清空、换成了另一件事。
 * 所以结果**一律凭这次提交的身份**动草稿,不看面板挂没挂着来猜(第 9、10 轮审查清掉了新
 * 草稿/新附件;新建框第 3 轮审查:清空后新写的内容被旧请求的成功清掉、面板被收起):
 * - 成功清草稿、没送达挂上待重发的那条,都走 DraftStore 的 settleSubmission——草稿还盖着
 *   这次的戳才认;面板已卸载时还要求自提交那一刻起一点没动过(对象引用相同);
 * - 不认就不清、不挂,ownsComposer=false,上层不收面板;只如实说一声;
 * - 随手记回链交**提交那一刻**捕获的 noteIds,不读完成时的(那可能是新面板的)。
 *
 * 框里 `@` 了人时「启动」就是起第一回合(问一句 / 讨论)。它没被服务端接下,任务虽已建好,这次提交却没办成:
 * 不收尾——草稿、叫的人原样留着,这条任务记进草稿,再按一次只对它重发这一下,不再建一条。草稿已经不是那一份,
 * 这条任务就不去接管新草稿,只说一声它留在待办里。
 * 返回值:这次提交办成了没有(没办成时调用方别把叫的人当「已发出」清掉)。
 */
export async function settleCreatedTask(args: {
  task: Task;
  launchMode: LaunchMode;
  scheduleAt: string;
  scheduleCron: string;
  /** 框里 `@` 了人：「创建并运行」那一下换成它起第一回合（只在 launchMode="run" 时有）。 */
  opening?: ComposerOpening | null;
  /** 这次提交的身份：盖在草稿上的戳、盖完那一刻的草稿对象，以及那一刻的随手记回链。 */
  submitted: { token: string; draft: Draft; noteIds: string[] };
  /** 发起提交的那份面板此刻是否仍挂载。 */
  panelMounted: () => boolean;
  draft: Pick<DraftHandle, "settleSubmission">;
  resetLabels: () => void;
  enqueue: (task: Task) => Promise<{ task: Task; members: Task[]; message: string }>;
  onCreated: (task: Task, noteIds: string[], ownsComposer: boolean) => void;
  onTasksSynced?: (tasks: Task[]) => void;
  notify: (message: string) => void;
}): Promise<boolean> {
  const { submitted } = args;
  let task = args.task;
  // 创建成功了草稿才丢:中途任何一步失败都原样留着,用户回到面板还能接着改。
  let kept = false;
  const finishCreation = () => {
    const mounted = args.panelMounted();
    const owns = args.draft.settleSubmission(submitted.token, "clear", mounted ? undefined : submitted.draft);
    kept = !owns;
    if (owns && mounted) args.resetLabels();
    args.onCreated(task, submitted.noteIds, owns && mounted);
  };
  // 草稿已经换了的时候补一句：那边写的东西没被动过，面板也没收。
  const notify = (message: string) => args.notify(kept ? `${message}；那份草稿已经换了，后来写的内容原样留着` : message);
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
  if (launchError && args.opening) {
    args.notify(args.draft.settleSubmission(submitted.token, { created: { task, error: reason } })
      ? `任务已创建，但${args.opening.what}没发出去：${reason}。再按一次只重发这一下，不会再建一条`
      : `任务「${task.title}」已创建，但${args.opening.what}没发出去：${reason}。那份草稿已经换了，这条任务留在待办里`);
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
