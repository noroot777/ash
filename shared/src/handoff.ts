// ── 任务接力（跨机器 handoff）──────────────────────────────────────────────
// 把一个任务连同 git 分支、CLI 会话文件、会话产物整体迁到另一台 harness 上续跑。
// 从 index.ts 拆出的纯类型模块;index.ts 做类型再导出,消费方 import 路径不变。
export interface HandoffTarget {
  name: string;
  url: string;
}

// 落在 tasks.handoff（json）上的持久接力标记:导出侧 direction:"out"（任务已交出去，
// 本地这份只是历史），导入侧 direction:"in"（从别的机器接过来的）。刷新后横幅靠它。
export interface TaskHandoff {
  direction: "out" | "in";
  // out 专用:true = 请求已发出但没收到对端确认(应答丢失/源机中途退出)。pending 态
  // 同样硬拦本机启动;原样重试接力会按 transferId 幂等收口,确认没送到也可手动移除标记。
  pending?: boolean;
  // 这一次接力的身份证(源机生成并持久化,导入侧存进 in 标记):重试时对端据此把
  // 「已有同 id 任务」识别成同一次接力。老版本导出的标记没有这个字段。
  transferId?: string | null;
  // out+pending 专用:第一次发送时冻结的目标项目与 autoResume。收口重试沿用同一个
  // transferId,所以只能对同一台机器、同一个项目原样重放——换目标会把任务复制到多台
  // 机器(对端各自导入成功)。要换目标必须先移除标记,走全新 transferId。
  targetProjectId?: string | null;
  autoResume?: boolean;
  // out: 对端 harness 根地址（横幅可点过去）；in: 源机自述不了地址,为 null。
  peerUrl: string | null;
  // out: 目标配置里的名字；in: 源机主机名。
  peerName: string | null;
  // 对端那份任务的 id（同 id 迁移,当前恒等于本任务 id;留字段防语义变化）。
  peerTaskId: string;
  at: string;
  // 成功搬运的 CLI 会话文件数。0 = 对端只能全新起跑（吃一遍任务正文）。
  sessions: number;
  // 代码是否随任务走了:bundle = 分支打包带走;none = 没有可带的（非 worktree 任务等）。
  git: "bundle" | "none";
  note?: string;
}

// 对端 /handoff/ping 报出的候选项目（接力对话框里选目标项目用）。
export interface HandoffPingProject {
  id: string;
  name: string;
  repoPath: string;
  isRepo: boolean;
}

// POST /tasks/:id/handoff/preflight 的应答:探测对端 + 盘点本地可搬运的东西,只读。
export interface HandoffPreflightResult {
  ok: true;
  target: { url: string; host: string };
  projects: HandoffPingProject[];
  // 按仓库目录名匹配出的对端项目;null = 没匹配上,让用户自己选。
  suggestedProjectId: string | null;
  local: {
    status: string;
    running: boolean;
    sessions: number;
    sessionFilesFound: number;
    git: "bundle" | "none";
    notes: string[];
  };
}

// POST /tasks/:id/handoff 的应答。
export interface HandoffExportResult {
  ok: true;
  remoteTaskId: string;
  remoteUrl: string;
  sessionsMigrated: number;
  git: "bundle" | "none";
  autoResume: boolean;
  notes: string[];
}
