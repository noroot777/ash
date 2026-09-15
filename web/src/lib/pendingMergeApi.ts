// 「合并后不提交」那一档的收尾端点。从 `api.ts` 拆出来只有一个理由：那份文件已经
// 顶到 700 行（全局约定的上限）。调用点不用改：它整份被 spread 进 `api`，
// `api.pendingMerge()` 这类写法一字不动。
//
// 这一族的共同点是**都去核对现场**，不是复读库里那句「我们合完没提交」：验收之后用户
// 在自己的终端里干了什么 ash 一概管不着（自己提交了 / reset --hard 丢了 / 又往暂存区
// 加了别的东西），所以每次都由服务端去看一眼目标分支此刻的真实状态（见服务端
// task-accept-pending.ts）。
import type { PendingMergeActionResult, PendingMergeState } from "@ash/shared/accept-pending";
import { id, json, request } from "./apiClient.ts";

export const pendingMergeApi = {
  pendingMerge: (taskId: string): Promise<{ state: PendingMergeState | null }> =>
    request(`/tasks/${id(taskId)}/pending-merge`),
  /** 把索引里那份落成提交。服务端先核对内容指纹，拿不准就拒绝（不硬提交）。 */
  commitPendingMerge: (taskId: string): Promise<PendingMergeActionResult> =>
    request(`/tasks/${id(taskId)}/pending-merge/commit`, json("POST", {})),
  /** 产物被丢掉之后重新合一次。`commit` 只覆盖这一次；不传 = 跟项目设置走。 */
  remergePendingMerge: (taskId: string, commit?: boolean): Promise<PendingMergeActionResult> =>
    request(`/tasks/${id(taskId)}/pending-merge/remerge`, json("POST", { commit })),
};
