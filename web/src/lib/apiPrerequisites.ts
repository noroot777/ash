// 前置：这条任务建在哪几条上面（shared/src/prerequisites.ts）。加、减、列候选三个端点，从 `api.ts` 的清单里
// 拎出来（那份顶着单文件 700 行上限）；调用点仍然只写 `api.addPrerequisite(...)`。
import type { PrerequisiteCandidates } from "@navi/shared/prerequisites";
import type { Task } from "@navi/shared";
import { id, json, request } from "./apiClient.ts";

export const prerequisiteApi = {
  /** 「建在谁上面」的候选。已有任务传 taskId；新建面板传工作目录选择和已选的前置（按选的先后）。 */
  prerequisiteCandidates: (projectId: string, query: { taskId: string } | { useWorktree: boolean; selected: string[] }): Promise<PrerequisiteCandidates> => {
    const params = new URLSearchParams("taskId" in query
      ? { taskId: query.taskId }
      : { useWorktree: query.useWorktree ? "1" : "0", selected: query.selected.join(",") });
    return request(`/projects/${id(projectId)}/prerequisite-candidates?${params}`);
  },
  addPrerequisite: (taskId: string, prerequisiteId: string): Promise<Task> =>
    request(`/tasks/${id(taskId)}/prerequisites`, json("POST", { prerequisiteId })),
  removePrerequisite: (taskId: string, prerequisiteId: string): Promise<Task> =>
    request(`/tasks/${id(taskId)}/prerequisites/${id(prerequisiteId)}`, { method: "DELETE" }),
};
