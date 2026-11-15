// 夹具里「读全文那一屉」的宿主：左边是主区（`.task-detail`，那一屉从它左边推出来，只盖这一栏），
// 右边摆调用方给的那几格侧边栏——线上 TaskDetail / InspectorHost 的骨架。
import type { ReactNode } from "react";
import { LeftDrawerProvider, useLeftDrawerHost } from "../../src/components/LeftDrawer.tsx";

export function ReadingStage({ resetKey, height = 640, children }: { resetKey: string; height?: number; children: ReactNode }) {
  const host = useLeftDrawerHost({ resetKey });
  return (
    <LeftDrawerProvider value={host.api}>
      <div style={{ display: "flex", gap: 20, height }}>
        <div className="task-detail">{host.drawer}</div>
        {children}
      </div>
    </LeftDrawerProvider>
  );
}
