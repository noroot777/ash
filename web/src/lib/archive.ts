// 归档/取回的那一下 toast。摘要逻辑只能有一份：归档现在会按设置顺手删 worktree/分支，
// 「删成了什么、什么因为未合并留下了」是用户当场唯一能看到的交代（持久那份在任务时间
// 线里）。四个入口（任务详情、团队、讨论、命令面板）都走这里，别在调用处自己拼文案。
import type { Task } from "@ash/shared";
import { summarizeArchiveCleanup } from "@ash/shared/project";
import { api } from "./api.ts";

// 前端 build 立即生效、server 要用户自己重启（见 README 的部署说明），所以存在一个
// 「新前端 + 老 server」的窗口：那时这两个端点回的还是**裸 Task**，没有外层包装。
// 不兜住的话 `{ task }` 解构出 undefined，归档按钮当场炸在一个与功能无关的地方。
const unwrap = <T extends object>(payload: T & { task?: Task }): Task =>
  payload.task ?? (payload as unknown as Task);

/** 归档或取回 `task`（按它当前的 archived 位决定方向），并把结果说给用户听。 */
export async function toggleArchive(
  task: { id: string; archived?: boolean },
  notify: (message: string) => void,
  label = "任务",
): Promise<Task> {
  if (task.archived) {
    const payload = await api.unarchiveTask(task.id);
    notify(payload.restoreNote ? `${label}已取回。${payload.restoreNote}` : `${label}已取回`);
    return unwrap(payload);
  }
  const payload = await api.archiveTask(task.id);
  const summary = summarizeArchiveCleanup(payload.cleanup);
  notify(summary ? `${label}已归档：${summary}` : `${label}已归档`);
  return unwrap(payload);
}
