// 终端会话与「常用命令」那一族端点。从 `api.ts` 拆出来只有一个理由:那份文件顶到了
// 700 行(全局约定的上限)。调用点不用改:它整份被 spread 进 `api`,`api.startProjectCommand()`
// 这类写法一字不动。
//
// 这一族的共同点是**对面是真实进程**:交互终端那几条(create/write/resize/close/events)
// 直通一条 pty;常用命令那几条(start/stop/restart/residue/abandon)操作的是服务端按
// 启动记号与端口管着的那次启动 —— 所以返回体里常有一句 `notice`:动作做了,但现场还有
// 核不上归属的东西,不说就是谎报(见 server/src/terminal-stop-notices.ts)。
import type { LaunchAbandonment, LaunchResidueView, TerminalSessionInfo } from "./apiTypes.ts";
import { apiPath, id, json, request } from "./apiClient.ts";

export const terminalApi = {
  createTerminalSession: (
    projectId: string,
    size: { cols: number; rows: number },
  ): Promise<TerminalSessionInfo> =>
    request(`/projects/${id(projectId)}/terminal/sessions`, json("POST", size)),
  terminalEventsUrl: (projectId: string, sessionId: string): string =>
    apiPath(`/projects/${id(projectId)}/terminal/sessions/${id(sessionId)}/events`),
  writeTerminalSession: (projectId: string, sessionId: string, data: string): Promise<void> =>
    request(`/projects/${id(projectId)}/terminal/sessions/${id(sessionId)}/input`, json("POST", { data })),
  resizeTerminalSession: (
    projectId: string,
    sessionId: string,
    size: { cols: number; rows: number },
  ): Promise<void> =>
    request(`/projects/${id(projectId)}/terminal/sessions/${id(sessionId)}/resize`, json("POST", size)),
  closeTerminalSession: (projectId: string, sessionId: string): Promise<void> =>
    request(`/projects/${id(projectId)}/terminal/sessions/${id(sessionId)}`, { method: "DELETE" }),
  listTerminalSessions: (projectId: string, signal?: AbortSignal): Promise<{ sessions: TerminalSessionInfo[] }> =>
    request(`/projects/${id(projectId)}/terminal/sessions`, signal ? { signal } : undefined),
  listCommandSessions: (): Promise<{ sessions: TerminalSessionInfo[] }> =>
    request("/terminal-commands"),
  // values = 命令里 `{{占位符}}` 的取值（shared/project-commands.ts）。只送取值不送脚本：
  // 跑什么永远以库里存的那条命令为准。
  startProjectCommand: (projectId: string, commandId: string, values: Record<string, string> = {}): Promise<{ session: TerminalSessionInfo; alreadyRunning?: boolean }> =>
    request(`/projects/${id(projectId)}/commands/${id(commandId)}/start`, json("POST", { values })),
  // notice = 停下来了,但同组还有核不上归属、没敢杀的进程(服务端 StopVerdict 的 unresolved)。
  // 不是报错(端口确实让出来了),但必须说一句 —— 不然「这次启动起来的东西都停了」就是谎报。
  stopProjectCommand: (projectId: string, commandId: string): Promise<{ stopped: boolean; notice?: string }> =>
    request(`/projects/${id(projectId)}/commands/${id(commandId)}/stop`, json("POST", {})),
  restartProjectCommand: (projectId: string, commandId: string, values: Record<string, string> = {}): Promise<{ session: TerminalSessionInfo; notice?: string }> =>
    request(`/projects/${id(projectId)}/commands/${id(commandId)}/restart`, json("POST", { values })),
  // 「我自己处理了」那个显式出口。residue 是**只读**的(点开看看不改任何状态);abandon 必须
  // 带上刚看过的那条 sessionId —— 期间又起了一份就回 409,不许拿旧弹层上的「是」放过新的启动
  // (server/src/terminal-abandon.ts 文件头)。
  launchResidue: (projectId: string, commandId: string): Promise<LaunchResidueView> =>
    request(`/projects/${id(projectId)}/commands/${id(commandId)}/residue`),
  abandonLaunch: (projectId: string, commandId: string, sessionId: string): Promise<{
    abandoned: LaunchAbandonment; alreadyAbandoned?: boolean;
  }> =>
    request(`/projects/${id(projectId)}/commands/${id(commandId)}/abandon`, json("POST", { sessionId })),
};
