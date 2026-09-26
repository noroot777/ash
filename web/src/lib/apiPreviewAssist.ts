// 「AI 协助填启动脚本」的端点。跟别的预览端点分开一份，是因为它是一台**短命作业**的
// 控制面（开一个 / 问进度 / 取消），而不是读写项目配置；api.ts 那份已经顶到 700 行上限。
import type { PreviewAssistState } from "@ash/shared/preview-assist";
import { id, json, request } from "./apiClient.ts";

export interface PreviewAssistStartBody {
  /** 页面上此刻的脚本（可能还没保存），给智能体当参考。 */
  script: string;
  /** 页面上此刻的启动范围，试跑时按它递 `$ASH_PREVIEW_MODE`。 */
  launch: string;
  executorId?: string | null;
  agentType?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export const previewAssistApi = {
  previewAssist: (projectId: string): Promise<{ job: PreviewAssistState | null }> =>
    request(`/projects/${id(projectId)}/preview/assist`),
  startPreviewAssist: (projectId: string, body: PreviewAssistStartBody): Promise<{ job: PreviewAssistState }> =>
    request(`/projects/${id(projectId)}/preview/assist`, json("POST", body)),
  cancelPreviewAssist: (projectId: string): Promise<{ canceled: boolean; job: PreviewAssistState | null }> =>
    request(`/projects/${id(projectId)}/preview/assist`, { method: "DELETE" }),
};
