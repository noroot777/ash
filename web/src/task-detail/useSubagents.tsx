import { useCallback, useMemo, useRef, useState } from "react";
import { Robot } from "@phosphor-icons/react";
import type { TaskStatus } from "@ash/shared";
import { SideDrawer } from "../components/SideDrawer.tsx";
import type { InspectorDescriptor } from "../inspector/index.ts";
import type { ConversationItem } from "./conversationModel.ts";
import { NativeAgentConversation } from "./NativeAgentConversation.tsx";
import type { NativeWorkInspectorProps } from "./NativeWorkInspector.tsx";
import { buildNativeWork, NATIVE_WORK_STATUS_LABELS } from "./nativeWorkModel.ts";

export interface SubagentSource {
  items: ConversationItem[];
  status: TaskStatus;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}

/**
 * 子智能体那一格：Inspector 里是列表，执行详情从左侧抽屉推出来——和团队模式点执行者
 * 完全一样的手感（列表留在右边看得见，详情盖住中间那一栏）。
 *
 * 选中状态放在这里而不是 NativeWorkInspector 里面：抽屉得挂到视图的主区容器上
 * （`.team-view` / `.task-detail`）才能只盖住中间那一栏，Inspector 面板装不下它。
 *
 * options.onOpen 给宿主做互斥用（团队视图里打开子智能体抽屉要先收起执行者抽屉）。
 */
export function useSubagents<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  source: SubagentSource,
  options: { onOpen?: () => void } = {},
) {
  const { items, status, loading, error, onRetry } = source;
  const rows = useMemo(() => buildNativeWork(items, status), [items, status]);
  const [openId, setOpenId] = useState<string | null>(null);
  // 宿主传进来的回调每轮渲染都是新的，进 ref 以免 open 的身份跟着抖。
  const onOpenRef = useRef(options.onOpen);
  onOpenRef.current = options.onOpen;
  // 会话记录重取后这一行可能已经不在了（换了任务、或记录读不全）：认不出来就等于抽屉该关。
  const openAgent = openId
    ? rows.find((row) => row.id === openId && row.kind === "agent") ?? null
    : null;
  const hasSubagents = rows.some((row) => row.kind === "agent");
  const incomplete = !!error;
  const close = useCallback(() => setOpenId(null), []);
  const open = useCallback((id: string) => {
    onOpenRef.current?.();
    setOpenId(id);
  }, []);

  const inspectors = useMemo(() => descriptors.map((descriptor) => {
    if (descriptor.id !== "subagents" || (!hasSubagents && !incomplete)) return descriptor;
    return {
      ...descriptor,
      title: incomplete ? `${descriptor.title}（记录读取不完整）` : descriptor.title,
      icon: hasSubagents
        ? <Robot size={14} weight="bold" className="task-subagents-icon--populated" />
        : descriptor.icon,
    };
  }), [descriptors, hasSubagents, incomplete]);

  const nativeWork: NativeWorkInspectorProps = {
    rows,
    loading,
    error,
    onRetry,
    openAgentId: openAgent?.id ?? null,
    onOpenAgent: open,
  };

  const drawer = openAgent ? (
    <SideDrawer
      variant="subagent"
      contentKey={openAgent.id}
      kind="子智能体"
      title={openAgent.title}
      ariaLabel={`子智能体执行详情：${openAgent.title}`}
      closeLabel="关闭子智能体抽屉"
      onClose={close}
    >
      <NativeAgentConversation
        key={openAgent.id}
        row={openAgent}
        statusLabel={NATIVE_WORK_STATUS_LABELS[openAgent.status]}
        error={error}
        onRetry={onRetry}
      />
    </SideDrawer>
  ) : null;

  return { inspectors, nativeWork, drawer, openAgentId: openAgent?.id ?? null, closeAgent: close };
}
