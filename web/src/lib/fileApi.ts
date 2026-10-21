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
  FileDeleteResult,
  FileEntryOverview,
  FileListing,
  FileSearchResult,
  IdeLaunchStatus,
  IdeProbe,
  OpenerProbe,
  TaskArtifactsResult,
  TaskFileRead,
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
  taskFile: (taskId: string, path: string): Promise<TaskFileRead> =>
    request(`/tasks/${id(taskId)}/file?path=${id(path)}`),
  // 图片/PDF 预览直接把这个地址交给 <img>/<iframe>，不经过 JSON。
  //
  // `workspaceOnly` 给**对话正文里的图**用（见 task-detail/turnImages.ts）：那一档必须只
  // 认任务自己那个目录，退到项目主仓会把 `output/shot.png` 解到另一个任务留下的同名文件
  // 上，画出一张不相干的图。文件树、生成物那几处不传——它们要的就是「退到主仓也让人看」。
  taskFileRawUrl: (taskId: string, path: string, options?: { workspaceOnly?: boolean }): string =>
    apiPath(`/tasks/${id(taskId)}/file/raw?path=${id(path)}${options?.workspaceOnly ? "&workspaceOnly=1" : ""}`),
  // 网页产物的预览地址**不在前端拼**：它带着一段预览令牌，由 `taskFile` 随内容一起发下来
  // （见 server/src/task-page.ts 顶部——令牌是放开 ACAO 之后挡住第三方站点的那一道）。
  taskArtifacts: (taskId: string, signal?: AbortSignal): Promise<TaskArtifactsResult> =>
    request(`/tasks/${id(taskId)}/artifacts`, { signal }),
  taskFileOpeners: (taskId: string, path: string, refresh = false): Promise<OpenerProbe> =>
    request(`/tasks/${id(taskId)}/file/openers?path=${id(path)}${refresh ? "&refresh=1" : ""}`),
  revealTaskFile: (taskId: string, path: string): Promise<{ ok: true; absPath: string }> =>
    request(`/tasks/${id(taskId)}/file/reveal`, json("POST", { path })),
  // 本机装了哪些编程 IDE。整台机器一份，跟任务无关，所以路径上没有 taskId。
  // `signal` 让调用方能给这次探测设期限:探测要 stat 几百个路径,代理或磁盘卡住时它
  // 可能既不返回也不断开,菜单就永远停在「正在查…」(第 2 轮审查 N3)。
  ides: (refresh = false, signal?: AbortSignal): Promise<IdeProbe> =>
    request(`/ides${refresh ? "?refresh=1" : ""}`, signal ? { signal } : undefined),
  // 用某个 IDE 打开工作目录里的一个文件夹（`path` 为空 = 工作目录本身）。
  openTaskPathInIde: (
    taskId: string,
    path: string,
    ideId: string,
  ): Promise<{ ok: true; absPath: string; name: string; status: IdeLaunchStatus }> =>
    request(`/tasks/${id(taskId)}/file/open-in-ide`, json("POST", { path, ideId })),
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
