import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { registerInspectorSectionOwner } from "../../src/inspector/sections.ts";
import { FOLLOW_UPS_SECTION_ID } from "../../src/task-detail/followUpsSection.ts";
import { TaskFollowUps } from "../../src/task-detail/TaskFollowUps.tsx";
import { useWorkspaceShortcuts } from "../../src/workspace/useWorkspaceShortcuts.ts";
import "../../src/styles/global.css";

// 真按 Q（走 useWorkspaceShortcuts 那一路），看信息面板里「后续追问」那一节弹没弹开。
// Inspector 宿主换成一个只认这一节的假的：面板一直挂着，「切到那一格」无事可做。
const long = (label: string) => `${label}\n${"这一条写得很长，好把面板撑出滚动条。\n".repeat(8)}`;
const followUps = [
  { text: long("最早那条"), attachments: [], at: "2026-11-03T01:00:00.000Z" },
  { text: long("中间那条"), attachments: [], at: "2026-11-03T02:00:00.000Z" },
  { text: long("最新那条"), attachments: [], at: "2026-11-03T03:00:00.000Z" },
];
const noop = () => {};

function Fixture() {
  useEffect(() => registerInspectorSectionOwner({ has: (id) => id === FOLLOW_UPS_SECTION_ID, open: noop }), []);
  useWorkspaceShortcuts({
    enabled: true,
    paletteOpen: false,
    composerOpen: false,
    spreadOpen: false,
    onNavigate: noop,
    onTogglePalette: noop,
    onCreate: noop,
    onToggleSpread: noop,
    onCloseSpread: noop,
    onToggleTaskMode: noop,
    onOpenSettings: noop,
    onToggleCommands: noop,
    onToggleTerminal: noop,
  });
  return (
    <>
      <input data-testid="text-entry" aria-label="文本输入" />
      <main className="task-inspector" style={{ width: 340, height: 320 }}>
        <div className="task-inspector-scroll">
          <section>
            <details open>
              <summary>原始需求</summary>
              <pre>{"原始需求正文\n".repeat(6)}</pre>
            </details>
            <TaskFollowUps followUps={followUps} />
          </section>
        </div>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
