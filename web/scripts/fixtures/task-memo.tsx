// 任务备忘的回归夹具。三件事脱开真壳子就测不出来，所以这里用的是真 `InspectorHost`
// （默认 340px 宽）+ 真 `ConversationSelection` + 真 store：
// - 从会话里选一段点「添加到备忘」之后，面板**真的切过去**而且指得出刚进来的是哪条
//   （切面板的是 Host，写入的是模块级 store，两边不在同一棵子树里——拆开单测必然失真）；
// - 长正文折到几行、溢出才给「展开全文」：是不是真溢出要量 scrollHeight，静态渲染量不到；
// - 侧边栏铺开那一格「追问和备忘哪个新显示哪个」，以及悬浮卡里备忘排在追问下面。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Info, NotePencil } from "@phosphor-icons/react";
import type { TaskListItem, TaskFollowUp } from "@ash/shared";
import type { TaskMemoDigest } from "@ash/shared/task-memo";
import { InspectorHost, type InspectorDescriptor } from "../../src/inspector/index.ts";
import { ConversationSelection } from "../../src/side-chat/ConversationSelection.tsx";
import { TaskMemoInspector } from "../../src/task-memos/TaskMemoInspector.tsx";
import { useTaskMemoTab } from "../../src/task-memos/useTaskMemoTab.tsx";
import { addTaskMemo } from "../../src/task-memos/taskMemoStore.ts";
import { SpreadPeekCard, SpreadRowCells, type SpreadRowContext } from "../../src/workspace/TaskSpread.tsx";
import type { SidebarSpread } from "../../src/workspace/useSidebarSpread.ts";
import "../../src/styles/global.css";

const TASK_ID = "task-a";

const DESCRIPTORS: readonly InspectorDescriptor<{ taskId: string }>[] = [
  // 真表里「信息」是默认开的第一格，备忘排在它后面。这里照搬：少了它，`defaultState`
  // 的兜底会把备忘直接摊开，而「点浮条才切过去」那条断言就永远成立了。
  { id: "info", title: "信息", icon: <Info size={14} />, defaultOpen: true, shortcut: "i", render: () => <p>信息</p> },
  {
    id: "memos",
    title: "备忘",
    icon: <NotePencil size={14} />,
    defaultOpen: true,
    shortcut: "b",
    render: (context) => <TaskMemoInspector taskId={context.taskId} notify={(text) => { window.__notices.push(text); }} />,
  },
];

function PanelFixture() {
  const inspectors = useTaskMemoTab(DESCRIPTORS, TASK_ID);
  return (
    <main style={{ display: "flex", height: "100dvh", minHeight: 0 }}>
      <InspectorHost contextKey={`task:${TASK_ID}`} descriptors={inspectors} context={{ taskId: TASK_ID }}>
        {({ openTab }) => (
          <nav style={{ flex: 1, padding: 12 }}>
            <ConversationSelection
              taskId={TASK_ID}
              onAsk={() => openTab("side-chat")}
              // 三颗都摆上，顺序才测得出来（备忘排在前两颗之后，用户指定的位置）。
              onAddToReply={(text) => { window.__notices.push(`reply:${text}`); }}
              onAddToMemo={(text) => void (async () => {
                try {
                  await addTaskMemo(TASK_ID, text);
                  openTab("memos");
                } catch (reason) {
                  window.__notices.push(reason instanceof Error ? reason.message : String(reason));
                }
              })()}
            >
              <p data-testid="said">验收前先把 kb/feeds 那条严格增长门再过一遍</p>
            </ConversationSelection>
          </nav>
        )}
      </InspectorHost>
    </main>
  );
}

// ── 侧边栏铺开那一格 ─────────────────────────────────────────────────────────

const OLD = "2026-10-20T02:00:00.000Z";
const NEW = "2026-10-26T02:00:00.000Z";

function task(id: string): TaskListItem {
  return { id, projectId: "p", title: id, status: "done", createdAt: OLD, updatedAt: OLD } as TaskListItem;
}
function followUp(taskId: string, at: string | null): TaskFollowUp {
  return { taskId, text: "追问：这条命令要连后端一起测", truncated: false, at, attachments: [] };
}
function memo(taskId: string, at: string, count = 1): TaskMemoDigest {
  return { taskId, count, text: "备忘：验收时记得查严格增长门", truncated: false, at };
}

/** 四种组合各一行：备忘新 / 追问新 / 只有备忘 / 两样都没有。 */
const ROWS: { id: string; last?: TaskFollowUp; memo?: TaskMemoDigest }[] = [
  { id: "memo-newer", last: followUp("memo-newer", OLD), memo: memo("memo-newer", NEW, 3) },
  { id: "ask-newer", last: followUp("ask-newer", NEW), memo: memo("ask-newer", OLD) },
  { id: "memo-only", memo: memo("memo-only", NEW) },
  { id: "neither" },
];

function spreadOf(): SidebarSpread {
  return {
    open: true,
    laidOut: true,
    filter: "all",
    setFilter: () => undefined,
    followUps: new Map(ROWS.flatMap((row) => (row.last ? [[row.id, row.last]] : []))),
    memos: new Map(ROWS.flatMap((row) => (row.memo ? [[row.id, row.memo]] : []))),
    bodies: new Map(ROWS.map((row) => [row.id, "原始需求"])),
    loaded: new Set(ROWS.map((row) => row.id)),
    toggle: () => undefined,
    close: () => undefined,
  };
}

function SpreadFixture() {
  const ctx: SpreadRowContext = { spread: spreadOf(), peekAt: () => undefined, peekOut: () => undefined };
  return (
    <main style={{ padding: 16 }}>
      {ROWS.map((row) => (
        <div key={row.id} data-testid={`row-${row.id}`} style={{ display: "flex", width: 560, gap: 8 }}>
          <SpreadRowCells task={task(row.id)} ctx={ctx} onOpen={() => undefined} />
        </div>
      ))}
      {/* 悬浮卡：备忘那一段必须排在追问正文**下面**。 */}
      <SpreadPeekCard
        peek={{ task: task("memo-newer"), kind: "last", rect: new DOMRect(40, 320, 200, 20) }}
        last={followUp("memo-newer", OLD)}
        memo={memo("memo-newer", NEW, 3)}
        known
        body="原始需求"
        onHold={() => undefined}
        onLeave={() => undefined}
        onDismiss={() => undefined}
      />
    </main>
  );
}

declare global {
  interface Window { __notices: string[] }
}
window.__notices = [];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).has("spread") ? <SpreadFixture /> : <PanelFixture />}
  </StrictMode>,
);
