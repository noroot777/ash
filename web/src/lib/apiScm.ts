// 工作区源代码管理那一族（`api.taskScm()` / `api.scmCommit()` …），整份 spread 进
// `api`，调用点写法不变。单独一个文件是为了守住 700 行（同 apiMonitors.ts / apiLlm.ts）。
//
// 写操作在任务运行中会被后端拦成 409（body 带 needsForce），由调用点弹确认框后带 force
// 重试 —— **别在这一层偷偷补 force**：那等于替用户按掉一道他自己要看的闸。
import type {
  ScmCommitResult,
  ScmDiffSource,
  ScmFileDiff,
  ScmOverview,
  ScmPushResult,
  ScmWriteResult,
} from "./apiTypes.ts";
import { id, json, request } from "./apiClient.ts";

export const scmApi = {
  taskScm: (taskId: string): Promise<ScmOverview> =>
    request(`/tasks/${id(taskId)}/scm`),
  // 跟 `taskBranchFileDiff` 是两个问题，别混：这个读的是工作目录此刻还没提交的东西
  // （索引 + 工作树），那个读的是提交历史上的一段区间。
  taskScmDiff: (
    taskId: string,
    path: string,
    source: ScmDiffSource,
    origPath?: string | null,
  ): Promise<ScmFileDiff> =>
    request(`/tasks/${id(taskId)}/scm/diff?path=${id(path)}&source=${source}${origPath ? `&origPath=${id(origPath)}` : ""}`),
  scmStage: (taskId: string, paths: string[], force = false): Promise<ScmWriteResult> =>
    request(`/tasks/${id(taskId)}/scm/stage`, json("POST", { paths, force })),
  scmUnstage: (taskId: string, paths: string[], force = false): Promise<ScmWriteResult> =>
    request(`/tasks/${id(taskId)}/scm/unstage`, json("POST", { paths, force })),
  scmDiscard: (
    taskId: string,
    paths: string[],
    deleteUntracked: string[] = [],
    force = false,
  ): Promise<ScmWriteResult> =>
    request(`/tasks/${id(taskId)}/scm/discard`, json("POST", { paths, deleteUntracked, force })),
  scmCommit: (
    taskId: string,
    message: string,
    options: { stagePaths?: string[]; amend?: boolean; force?: boolean; acceptance?: boolean } = {},
  ): Promise<ScmCommitResult> =>
    request(`/tasks/${id(taskId)}/scm/${options.acceptance ? "acceptance-commit" : "commit"}`, json("POST", { message, ...options })),
  scmPush: (taskId: string, remote: string | null, force = false): Promise<ScmPushResult> =>
    request(`/tasks/${id(taskId)}/scm/push`, json("POST", { remote, force })),
};
