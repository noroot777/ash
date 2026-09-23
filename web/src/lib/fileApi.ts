// 任务工作目录里的文件那一族：列目录、`@` 候选、读一份全文 / 原始字节、交给本机应用打开，
// 以及删除（连同删除前要问的那一份 overview）。
//
// 从 `api.ts` 拆出来的理由跟 `handoffApi.ts` 一样：那份文件顶着 700 行的上限。调用点不用
// 改——它整份被 spread 进 `api`，`api.taskFiles()` 这类写法一字不动。
//
// 这一族自成一块：它是唯一**按路径**寻址的一组端点（其余都按 id），所以「路径怎么编码、
// 空路径算不算根」这类讲究全在这里；而且它是前端唯一会**写工作目录**的地方（删除），那一
// 条上的两次「再确认」由调用点负责，这一层不代劳。
import type {
  FileContent,
  FileDeleteResult,
  FileEntryOverview,
  FileListing,
  FileSearchResult,
  FileWorkspaceRoot,
  OpenerProbe,
} from "./apiTypes.ts";
import { apiPath, id, json, request } from "./apiClient.ts";

export const fileApi = {
  taskFiles: (taskId: string, path = ""): Promise<FileListing> =>
    request(`/tasks/${id(taskId)}/files?path=${id(path)}`),
  // 输入框敲 `@` 的候选。两条同形，区别只在「在哪搜」：已有任务按它实际的工作目录
  // （worktree 里改的文件才是用户要引用的那些），新建任务只能按项目仓库本身。
  taskFileSearch: (taskId: string, query: string, signal?: AbortSignal): Promise<FileSearchResult> =>
    request(`/tasks/${id(taskId)}/file-search?q=${id(query)}`, { signal }),
  projectFileSearch: (projectId: string, query: string, signal?: AbortSignal): Promise<FileSearchResult> =>
    request(`/projects/${id(projectId)}/file-search?q=${id(query)}`, { signal }),
  // 树里展开一层。`dir=""` 就是仓库根，所以参数一律要带上，不能因为空就省掉。
  taskFileDir: (taskId: string, dir: string, signal?: AbortSignal): Promise<FileSearchResult> =>
    request(`/tasks/${id(taskId)}/file-search?dir=${id(dir)}`, { signal }),
  projectFileDir: (projectId: string, dir: string, signal?: AbortSignal): Promise<FileSearchResult> =>
    request(`/projects/${id(projectId)}/file-search?dir=${id(dir)}`, { signal }),
  taskFile: (taskId: string, path: string): Promise<{ root: FileWorkspaceRoot; file: FileContent }> =>
    request(`/tasks/${id(taskId)}/file?path=${id(path)}`),
  // 图片/PDF 预览直接把这个地址交给 <img>/<iframe>，不经过 JSON。
  taskFileRawUrl: (taskId: string, path: string): string =>
    apiPath(`/tasks/${id(taskId)}/file/raw?path=${id(path)}`),
  taskFileOpeners: (taskId: string, path: string, refresh = false): Promise<OpenerProbe> =>
    request(`/tasks/${id(taskId)}/file/openers?path=${id(path)}${refresh ? "&refresh=1" : ""}`),
  revealTaskFile: (taskId: string, path: string): Promise<{ ok: true; absPath: string }> =>
    request(`/tasks/${id(taskId)}/file/reveal`, json("POST", { path })),
  openTaskFile: (
    taskId: string,
    path: string,
    appId: string | null,
  ): Promise<{ ok: true; absPath: string }> =>
    request(`/tasks/${id(taskId)}/file/open`, json("POST", { path, appId })),
  // 文件夹详情页和删除确认框读的是同一份（见 FileEntryOverview）。
  taskFileOverview: (taskId: string, path: string, signal?: AbortSignal): Promise<FileEntryOverview> =>
    request(`/tasks/${id(taskId)}/file/overview?path=${id(path)}`, { signal }),
  // 删除默认移到系统废纸篓。两种 409 都不是「失败」而是「再确认一次」，所以**别在这一层
  // 偷偷补 force、也别把 trashFailed 自动降级成永久删除**：那两下都得用户自己点。
  deleteTaskFile: (
    taskId: string,
    path: string,
    options: { mode?: "trash" | "permanent"; force?: boolean } = {},
  ): Promise<FileDeleteResult> =>
    request(`/tasks/${id(taskId)}/file`, json("DELETE", {
      path,
      mode: options.mode ?? "trash",
      force: options.force ?? false,
    })),
};
