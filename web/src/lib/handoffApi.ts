// 任务接力(跨机器 handoff)的端点清单。从 `api.ts` 拆出来只有一个理由:那份文件到
// 700 行了(全局约定的上限)。调用点不用改:它整份被 spread 进 `api`,`api.handoffPeers()`
// 这类写法一字不动。
//
// 这一族天然自成一块:它是唯一会**跨出本机**的一组端点,而且方向有三种,别混:
//  · `handoff*` / `remoteTask*` —— 出站,本机 → 对端(本机服务端代签名转发,浏览器
//    永远只跟本机说话)。
//  · `handoffPeers` / `setHandoffPeerStatus` —— 入站信任表,管「谁能把任务推进本机」。
//  · `handoffTargets` —— 出站目标机清单。多人模式下**按人存**,里面装着「我在对端的
//    账号 key」,所以读侧永不回显 key,只报 hasKey(§十一)。
import type {
  HandoffApprovalResult,
  HandoffExportResult,
  HandoffIdentity,
  HandoffOutboundStateResult,
  HandoffPeer,
  HandoffPreflightResult,
  HandoffReturnGrant,
  HandoffTarget,
  Task,
} from "@ash/shared";
import type { RemoteTaskSnapshot, ReplyTaskResult } from "./apiTypes.ts";
import { id, json, request } from "./apiClient.ts";

export type TaskScopedHandoffPreflightResult = HandoffPreflightResult & { taskScopedReturn: boolean };

export const handoffApi = {
  // 任务接力:preflight 只读探测对端与本地可搬运的东西;handoffTask 会真的停下任务、
  // 打包 git 分支与 CLI 会话文件推给对端(可能上百 MB,调用点要给持续的忙碌反馈)。
  handoffPreflight: (
    taskId: string,
    targetUrl: string,
    options?: { allowReturnFallback?: boolean },
  ): Promise<TaskScopedHandoffPreflightResult> =>
    request(`/tasks/${id(taskId)}/handoff/preflight`, json("POST", { targetUrl, ...options })),
  handoffTask: (
    taskId: string,
    body: { targetUrl: string; targetProjectId: string; targetName?: string; autoResume?: boolean },
  ): Promise<HandoffExportResult> =>
    request(`/tasks/${id(taskId)}/handoff`, json("POST", body)),
  // 侧栏定时问一次「我交出去的那些任务，在对端现在什么样」。本机那一行的 status 停在
  // 交出去的那一刻，不问就只能拿冻住的旧状态当真。联系不上的机器进 offline，不算失败。
  outboundState: (): Promise<HandoffOutboundStateResult> =>
    request("/tasks/outbound-state", json("POST", {})),
  remoteTaskSnapshot: (taskId: string, targetUrl: string): Promise<RemoteTaskSnapshot> =>
    request(`/tasks/${id(taskId)}/remote-snapshot`, json("POST", { targetUrl })),
  remoteTaskReply: (taskId: string, targetUrl: string, text: string): Promise<ReplyTaskResult> =>
    request(`/tasks/${id(taskId)}/remote-reply`, json("POST", { targetUrl, text })),
  remoteTaskAnswer: (taskId: string, targetUrl: string, answer: string): Promise<unknown> =>
    request(`/tasks/${id(taskId)}/remote-answer`, json("POST", { targetUrl, answer })),
  remoteTaskReturn: (taskId: string, targetUrl: string): Promise<{ task: Task }> =>
    request(`/tasks/${id(taskId)}/remote-return`, json("POST", { targetUrl })),
  // 恢复送达未知的本机任务前，会先让目标机确认未收到并持久登记撤销，防止旧请求晚到。
  clearHandoff: (taskId: string, force = false): Promise<{
    cleared: true;
    restored: "in" | "local";
    forced: boolean;
  }> => request(`/tasks/${id(taskId)}/handoff`, force
    ? json("DELETE", { force: true, acknowledgeDuplicateRisk: true })
    : { method: "DELETE" }),

  // 接力身份与配对:本机身份(拿去和对端设置页上的指纹肉眼核对)、入站来源的审批。
  // 只有被批准的机器能把任务接力进本机 —— 出站方向的信任是 handoffTargets 上的 peerFp。
  requestHandoffApproval: (targetUrl: string): Promise<HandoffApprovalResult> =>
    request("/handoff/request", json("POST", { targetUrl })),
  handoffIdentity: (): Promise<HandoffIdentity> => request("/handoff/identity"),
  handoffTargetIdentity: (targetUrl: string): Promise<HandoffIdentity> =>
    request("/handoff/identity-probe", json("POST", { targetUrl })),
  handoffReturnTarget: async (taskId: string): Promise<HandoffTarget> =>
    (await request<{ target: HandoffTarget }>(`/tasks/${id(taskId)}/handoff/return-target`)).target,
  handoffPeers: async (): Promise<HandoffPeer[]> =>
    (await request<{ peers: HandoffPeer[] }>("/handoff/peers")).peers,
  handoffReturnGrants: async (): Promise<HandoffReturnGrant[]> =>
    (await request<{ grants: HandoffReturnGrant[] }>("/handoff/return-grants")).grants,
  setHandoffPeerStatus: (fingerprint: string, action: "approve" | "block"): Promise<HandoffPeer> =>
    request(`/handoff/peers/${id(fingerprint)}/${action}`, { method: "POST" }),
  unblockHandoffPeer: (fingerprint: string): Promise<{ unblocked: true; peer: HandoffPeer | null }> =>
    request(`/handoff/peers/${id(fingerprint)}/unblock`, { method: "POST" }),
  // 忘记这台机器:它再来敲门会重新进待批准列表(要永久拒绝用 block)。
  forgetHandoffPeer: (fingerprint: string): Promise<{ deleted: true }> =>
    request(`/handoff/peers/${id(fingerprint)}`, { method: "DELETE" }),

  // 多人模式:目标机清单**按人**存(里面有「我在对端的账号 key」,是凭证)。
  // 自用模式这几条也通,但读回的是 app_settings 里那份公共清单,写侧只允许 add——
  // 那条路必须与本功能上线前逐字节一致,所以自用模式的编辑仍走 patchSettings。
  handoffTargets: async (): Promise<HandoffTarget[]> =>
    (await request<{ targets: HandoffTarget[] }>("/handoff/targets")).targets,
  addHandoffTarget: async (input: { name: string; url: string; peerKey?: string }): Promise<HandoffTarget[]> =>
    (await request<{ targets: HandoffTarget[] }>("/handoff/targets", json("POST", input))).targets,
  patchHandoffTarget: async (
    targetId: string,
    patch: { name?: string; url?: string; peerKey?: string },
  ): Promise<HandoffTarget[]> =>
    (await request<{ targets: HandoffTarget[] }>(`/handoff/targets/${id(targetId)}`, json("PATCH", patch))).targets,
  deleteHandoffTarget: async (targetId: string): Promise<HandoffTarget[]> =>
    (await request<{ targets: HandoffTarget[] }>(`/handoff/targets/${id(targetId)}`, { method: "DELETE" })).targets,
  // 按**地址**配「我在对端的账号 key」。两种模式、三个表面(设置页两份清单 + 接力对话框
  // 里的就地补填)共用这一条:调用点手上常常只有地址——自用模式那份清单存在 app_settings
  // 里,压根没有行 id。空串 = 清除。
  setHandoffTargetKey: async (url: string, peerKey: string): Promise<HandoffTarget[]> =>
    (await request<{ targets: HandoffTarget[] }>("/handoff/targets/key", json("PUT", { url, peerKey }))).targets,
};
