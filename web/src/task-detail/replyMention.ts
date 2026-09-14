import { useState, type KeyboardEvent } from "react";
import type { AgentExecutorProfile, AgentType } from "@ash/shared";
import { registeredAgentTypes } from "../lib/agentAvailability.ts";
import { fileMentionRows, type MentionRow } from "../components/MentionMenu.tsx";
import { useFileMention } from "../lib/useFileMention.ts";

/**
 * 单飞对话框那一个 `@` 的全部状态：**同一个符号**既召唤智能体、又引用工作区文件，
 * 两类候选合并成一张列表走同一条上下键。
 *
 * 合并是刻意的 —— 用户敲 `@` 时想的是「引用点什么」，不是「我该用哪个选择器」。谁排
 * 前面由 token 自己决定：纯字母两边都可能命中，智能体在前（它换的是「谁来干」，代价
 * 大、要一眼看见）；token 里一出现 `/` 或 `.`，智能体那段整个让位，否则用户敲着路径
 * 回车却把这一回合派给了别的 CLI。
 *
 * 单独成文件还有一个原因：ReplyBox 已经贴着 700 行，而这套东西自成一体。
 */
export function useReplyMention({
  value,
  setValue,
  taskId,
  profiles,
  profilesReady,
  profilesFailed,
  disabled,
  onPickAgent,
  onPicked,
}: {
  value: string;
  setValue: (next: string) => void;
  taskId: string;
  profiles: AgentExecutorProfile[];
  profilesReady: boolean;
  profilesFailed: boolean;
  /** 这会儿根本不该弹（非单飞 / 已归档 / 正在配派生命令 / 正在选模型）。 */
  disabled: boolean;
  /** 选中智能体：由调用方接着弹「选模型」那一步。 */
  onPickAgent: (agent: AgentType) => void;
  onPicked: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const match = /(?:^|\s)@([^\s@]*)$/.exec(value);
  const token = match?.[1] ?? "";
  // 智能体只认「还像个类型名」的 token：敲到 `@src/` 那一刻用户显然在说路径。
  const agents = match && /^[a-z0-9_-]*$/i.test(token)
    ? registeredAgentTypes(profiles).filter((type) => type.startsWith(token.toLowerCase()))
    : [];
  const files = useFileMention({
    value,
    setValue,
    scope: { kind: "task", taskId },
    disabled: disabled || dismissed,
    onPicked,
  });
  const rows: MentionRow[] = [
    ...agents.map((agent) => ({ kind: "agent" as const, key: `agent:${agent}`, agent })),
    ...fileMentionRows(files.hits),
  ];
  const open = !disabled && !dismissed && !!match;
  const selectedIndex = Math.min(index, Math.max(0, rows.length - 1));
  // 文件那半边还没回来时要说一句，否则「@ 了一下什么都没有」看着像功能坏了。
  const status = files.loading && !files.hits.length ? "正在搜索工作区文件…"
    : files.failed ? "工作区文件搜索失败，仍可直接手打路径"
      : rows.length > 0 ? null
        : !profilesReady ? "正在读取已注册智能体…"
          : profilesFailed ? "执行器列表读取失败；也没有匹配的文件"
            : "没有匹配的智能体或文件";

  const pick = (row: MentionRow) => {
    if (row.kind === "agent") onPickAgent(row.agent as AgentType);
    else files.pick(row.hit);
  };

  /** 接在 textarea 的 onChange 里。 */
  const onValueChange = () => {
    setIndex(0);
    setDismissed(false);
  };

  const reset = () => {
    setIndex(0);
    setDismissed(false);
  };

  /** 返回 true = 这个按键已经被菜单吃掉了。 */
  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!open) return false;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length) {
      event.preventDefault();
      setIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
      return true;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      // 菜单开着时回车归菜单，哪怕文件那半边还没到货（智能体那半边是同步算的，有就直接
      // 选）。放它去插换行会把 `@token` 顶到非行尾，菜单当场收起，用户还得退回来重敲。
      event.preventDefault();
      if (rows.length) pick(rows[selectedIndex]!);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    return false;
  };

  return {
    open,
    rows,
    token,
    status,
    index: selectedIndex,
    setIndex,
    // 第一条是智能体时提示「回车后继续选模型」，是文件时提示「回车插入路径」——
    // 同一颗回车在这张列表里做两件事，不写清楚用户按下去才知道。
    hint: `召唤智能体加入，或引用工作区文件 · ↑↓ 选择，回车${
      rows[selectedIndex]?.kind === "agent" ? "后继续选模型" : "插入路径"}`,
    pick,
    onKeyDown,
    onValueChange,
    reset,
  };
}
