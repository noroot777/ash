// 多人模式的 API 客户端。单独一份而不是塞进 `api.ts` —— 那份端点清单已经顶到 700 行
// 上限,而这一组的调用点也集中(登录页、向导、设置页的用户与个人 CLI 环境节)。
import type {
  AuthState,
  ConfigBundle,
  ConfigBundleKind,
  InviteInfo,
  PersonalCliEnv,
  ProjectInviteInfo,
  ProjectMemberView,
  ProjectRole,
  UserRole,
  UserView,
} from "@ash/shared";
import { id, json, request } from "./apiClient.ts";

export interface UnbackedExecutor {
  id: string;
  name: string;
  type: string;
  reason: string;
}

export interface SetupPreflight {
  unbackedExecutors: UnbackedExecutor[];
  counts: Record<string, number>;
  host: string;
}

export const authApi = {
  state: () => request<AuthState>("/auth/state"),

  login: (key: string) => request<{ user: UserView }>("/auth/login", json("POST", { key })),
  logout: () => request<{ ok: true }>("/auth/logout", json("POST")),
  rotateKey: () => request<{ key: string }>("/auth/rotate-key", json("POST")),
  recoveryHint: () => request<{ command: string; note: string }>("/auth/recovery-hint"),

  setupPreflight: () => request<SetupPreflight>("/auth/setup/preflight"),
  chooseSingle: () => request<AuthState>("/auth/setup", json("POST", { mode: "single" })),
  chooseMulti: (input: {
    adminName: string;
    rootDir: string;
    dirName?: string;
    gitName?: string;
    gitEmail?: string;
    /** CLI 额度:true = 共用宿主机 CLI,false/缺省 = 每人自带 key(§八之二)。 */
    sharedHostCli?: boolean;
  }) =>
    request<{ key: string; user: UserView; claimed: Record<string, number>; rootDir: string }>(
      "/auth/setup",
      json("POST", { mode: "multi", ...input }),
    ),

  // 领取专属邀请链接。三步:看说明 → 领取(生成 key) → 「我已保存」作废链接。
  // 中间那步**不作废** —— 手滑点开就锁死是计划明确要避免的。
  invite: (token: string) => request<InviteInfo>(`/auth/claim/${id(token)}`),
  claim: (token: string) => request<{ key: string; user: UserView }>(`/auth/claim/${id(token)}`, json("POST")),
  confirmClaim: (token: string) => request<{ ok: true }>(`/auth/claim/${id(token)}/confirm`, json("POST")),

  projectInvite: (token: string) => request<ProjectInviteInfo>(`/auth/project-invite/${id(token)}`),
  joinProject: (token: string) => request<{ projectId: string }>(`/auth/project-invite/${id(token)}`, json("POST")),
};

export const userApi = {
  list: () => request<UserView[]>("/users"),
  create: (input: { name: string; role: UserRole; dirName?: string; gitName?: string; gitEmail?: string }) =>
    request<{ user: UserView; inviteUrl: string }>("/users", json("POST", input)),
  patch: (userId: string, patch: Partial<Pick<UserView, "name" | "role" | "gitName" | "gitEmail">>) =>
    request<UserView>(`/users/${id(userId)}`, json("PATCH", patch)),
  suspend: (userId: string) =>
    request<{ ok: true; stoppedTasks: string[]; pausedSchedules: number }>(
      `/users/${id(userId)}/suspend`,
      json("POST"),
    ),
  resume: (userId: string) =>
    request<{ ok: true; inviteUrl: string | null }>(`/users/${id(userId)}/resume`, json("POST")),
  reissueInvite: (userId: string) => request<{ inviteUrl: string }>(`/users/${id(userId)}/invite`, json("POST")),
  revokeInvite: (userId: string) => request<{ revoked: true }>(`/users/${id(userId)}/invite`, json("DELETE")),
  resetKey: (userId: string) => request<{ inviteUrl: string }>(`/users/${id(userId)}/reset-key`, json("POST")),
};

export const projectMemberApi = {
  list: (projectId: string) => request<ProjectMemberView[]>(`/projects/${id(projectId)}/members`),
  add: (projectId: string, userId: string, role: ProjectRole = "member") =>
    request<ProjectMemberView[]>(`/projects/${id(projectId)}/members`, json("POST", { userId, role })),
  setRole: (projectId: string, userId: string, role: ProjectRole) =>
    request<ProjectMemberView[]>(`/projects/${id(projectId)}/members/${id(userId)}`, json("PATCH", { role })),
  remove: (projectId: string, userId: string) =>
    request<{ removed: true }>(`/projects/${id(projectId)}/members/${id(userId)}`, json("DELETE")),
  inviteState: (projectId: string) =>
    request<{ active: boolean; expiresAt: string | null }>(`/projects/${id(projectId)}/invite`),
  createInvite: (projectId: string, days?: number) =>
    request<{ inviteUrl: string }>(`/projects/${id(projectId)}/invite`, json("POST", { days })),
  revokeInvite: (projectId: string) =>
    request<{ revoked: true }>(`/projects/${id(projectId)}/invite`, json("DELETE")),
};

export interface BrowseEntry {
  name: string;
  path: string;
  hasChildren: boolean;
  isRepo: boolean;
}

export const fsBrowseApi = {
  root: () =>
    request<{ root: string; name: string; clamped: boolean; entries: BrowseEntry[] }>("/fs/browse/root"),
  open: (path: string) =>
    request<{ path: string; entries: BrowseEntry[] }>(`/fs/browse?path=${encodeURIComponent(path)}`),
  mkdir: (path: string) => request<{ path: string }>("/fs/browse/mkdir", json("POST", { path })),
};

export const personalCliApi = {
  list: () =>
    request<{ mode: "single" | "multi"; sharedHostCli: boolean; envs: PersonalCliEnv[] }>("/me/cli-env"),
  one: (agentType: string) => request<PersonalCliEnv>(`/me/cli-env/${id(agentType)}`),
  readSkill: (agentType: string, name: string) =>
    request<{ name: string; body: string }>(`/me/cli-env/${id(agentType)}/skills/${id(name)}`),
  writeSkill: (agentType: string, name: string, body: string) =>
    request<PersonalCliEnv>(`/me/cli-env/${id(agentType)}/skills/${id(name)}`, json("PUT", { body })),
  deleteSkill: (agentType: string, name: string) =>
    request<PersonalCliEnv>(`/me/cli-env/${id(agentType)}/skills/${id(name)}`, json("DELETE")),
  readMemory: (agentType: string) => request<{ body: string }>(`/me/cli-env/${id(agentType)}/memory`),
  writeMemory: (agentType: string, body: string) =>
    request<{ ok: true }>(`/me/cli-env/${id(agentType)}/memory`, json("PUT", { body })),
};

export const configTransferApi = {
  exportBundle: (kinds: ConfigBundleKind[]) => request<ConfigBundle>("/me/config/export", json("POST", { kinds })),
  importBundle: (bundle: ConfigBundle) =>
    request<{ imported: Record<string, number>; skipped: string[]; notes: string[] }>(
      "/me/config/import",
      json("POST", bundle),
    ),
};
