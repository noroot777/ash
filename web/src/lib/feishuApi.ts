// 飞书通道（设置 → 飞书）的端点清单。从 `api.ts` 拆出来是为了守 700 行；它整份被 spread
// 进 `api`，调用点照旧写 `api.feishuStatus()`。契约类型在 shared/src/im.ts。
//
// 两种发法别混：
//  · `humanAction` —— 换凭证、清凭证、生成绑定码、确认绑定。这几下决定「哪个飞书账号能指挥
//    这台机器」，自用模式下本机 agent 裸 curl 拿到的也是机主身份，所以服务端只认带页面凭据的
//    真人请求（方案 §6.2 / §6.5）。走它还顺带排队串行，凭据是一次性的。
//  · `request` —— 其余的读和改。拒绝、解绑这类只会让绑定**变少**的动作不需要真人凭据。
import type { FeishuBinding, FeishuGroups, FeishuStatus, ImBindCode, ImDomain, ImOptions } from "@ash/shared";
import { id, json, request } from "./apiClient.ts";
import { humanAction } from "./humanActionToken.ts";

export interface FeishuCredentialsInput {
  appId: string;
  /** 不带 = 沿用已存的那一把。 */
  appSecret?: string;
  domain: ImDomain;
}

export interface FeishuGroupPatch {
  projectId?: string;
  pushCards?: boolean;
}

export const feishuApi = {
  feishuStatus: (): Promise<FeishuStatus> => request("/im/feishu/status"),
  saveFeishuCredentials: (input: FeishuCredentialsInput): Promise<FeishuStatus> =>
    humanAction("/im/feishu/credentials", json("PUT", input)),
  clearFeishuCredentials: (): Promise<FeishuStatus> =>
    humanAction("/im/feishu/credentials", { method: "DELETE" }),
  patchFeishuOptions: (patch: Partial<ImOptions>): Promise<FeishuStatus> =>
    request("/im/feishu/options", json("PATCH", patch)),
  reconnectFeishu: (): Promise<FeishuStatus> =>
    request("/im/feishu/reconnect", { method: "POST" }),
  sendFeishuTestCard: (): Promise<{ ok: true }> =>
    request("/im/feishu/test", { method: "POST" }),

  feishuBinding: (): Promise<FeishuBinding> => request("/im/feishu/binding"),
  createFeishuBindCode: (): Promise<ImBindCode> =>
    humanAction("/im/feishu/binding/code", { method: "POST" }),
  acceptFeishuBinding: (codeId: string): Promise<FeishuBinding> =>
    humanAction("/im/feishu/binding/confirm", json("POST", { codeId })),
  rejectFeishuBinding: (codeId: string): Promise<FeishuBinding> =>
    request("/im/feishu/binding/reject", json("POST", { codeId })),
  setFeishuBindingProject: (projectId: string | null): Promise<FeishuBinding> =>
    request("/im/feishu/binding", json("PATCH", { projectId })),
  unbindFeishu: (): Promise<FeishuBinding> =>
    request("/im/feishu/binding", { method: "DELETE" }),

  feishuGroups: (): Promise<FeishuGroups> => request("/im/feishu/groups"),
  createFeishuGroupCode: (projectId: string): Promise<ImBindCode> =>
    humanAction("/im/feishu/groups/code", json("POST", { projectId })),
  acceptFeishuGroup: (codeId: string): Promise<FeishuGroups> =>
    humanAction("/im/feishu/groups/confirm", json("POST", { codeId })),
  rejectFeishuGroup: (codeId: string): Promise<FeishuGroups> =>
    request("/im/feishu/groups/reject", json("POST", { codeId })),
  patchFeishuGroup: (chatId: string, patch: FeishuGroupPatch): Promise<FeishuGroups> =>
    request(`/im/feishu/groups/${id(chatId)}`, json("PATCH", patch)),
  unbindFeishuGroup: (chatId: string): Promise<FeishuGroups> =>
    request(`/im/feishu/groups/${id(chatId)}`, { method: "DELETE" }),
};
