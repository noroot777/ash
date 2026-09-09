import { useMemo } from "react";
import { Robot } from "@phosphor-icons/react";
import type { InspectorDescriptor } from "../inspector/index.ts";
import type { NativeWorkInspectorProps } from "./NativeWorkInspector.tsx";
import { buildNativeWork } from "./nativeWorkModel.ts";

export function useSubagentInspectors<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  { items, status, error }: Pick<NativeWorkInspectorProps, "items" | "status" | "error">,
) {
  const hasSubagents = useMemo(
    () => buildNativeWork(items, status).some((row) => row.kind === "agent"),
    [items, status],
  );
  const incomplete = !!error;
  return useMemo(() => descriptors.map((descriptor) => {
    if (descriptor.id !== "subagents" || (!hasSubagents && !incomplete)) return descriptor;
    return {
      ...descriptor,
      title: incomplete ? `${descriptor.title}（记录读取不完整）` : descriptor.title,
      icon: hasSubagents
        ? <Robot size={14} className="task-subagents-icon--populated" />
        : descriptor.icon,
    };
  }), [descriptors, hasSubagents, incomplete]);
}
