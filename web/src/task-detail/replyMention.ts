import type { AgentType } from "@ash/shared";
import type { DraftHandle } from "../lib/DraftStore.tsx";
import { useMention } from "../components/useMention.ts";

/**
 * 单飞对话框那一个 `@`：在 useMention（随手记 + 工作区文件）前面再加一段智能体。
 *
 * 智能体只认「还像个类型名」的 token：纯字母时它和另外两段可能同时命中，智能体在前（它换
 * 的是「谁来干」，代价大、要一眼看见）；token 里一出现 `/` 或 `.`，这一段整个让位，否则
 * 用户敲着路径回车却把这一回合派给了别的 CLI。
 *
 * 单独成文件还有一个原因：ReplyBox 已经贴着 700 行。
 */
export function useReplyMention({
  value,
  setValue,
  draft,
  taskId,
  projectId,
  callable,
  profilesReady,
  profilesFailed,
  disabled,
  onPickAgent,
  onPicked,
}: {
  value: string;
  setValue: (next: string) => void;
  draft: Pick<DraftHandle, "update">;
  taskId: string;
  projectId: string;
  /** 这会儿能叫的智能体（已注册的；讨论时不含这条任务自己的执行器）。 */
  callable: AgentType[];
  profilesReady: boolean;
  profilesFailed: boolean;
  /** 这会儿根本不该弹（非单飞 / 已归档 / 正在配派生命令 / 框被裁定借着）。 */
  disabled: boolean;
  /** 选中智能体：由调用方叫上他（胶囊换成他，框顶多出「他来做什么」那一行）。 */
  onPickAgent: (agent: AgentType) => void;
  onPicked: () => void;
}) {
  return useMention({
    value,
    setValue,
    draft,
    scope: { kind: "task", taskId },
    projectId,
    disabled,
    label: "召唤智能体，或引用随手记、文件",
    agents: {
      match: (token) => (/^[a-z0-9_-]*$/i.test(token)
        ? callable.filter((type) => type.startsWith(token.toLowerCase()))
        : []),
      onPick: (agent) => onPickAgent(agent as AgentType),
    },
    emptyStatus: !profilesReady ? "正在读取已注册智能体…"
      : profilesFailed ? "执行器列表读取失败；也没有匹配的随手记或文件"
        : "没有匹配的智能体、随手记或文件",
    onPicked,
  });
}
