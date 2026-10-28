// 任务备忘的回归夹具。三件事脱开真壳子就测不出来，所以这里用的是真 `InspectorHost`
// （默认 340px 宽）+ 真 `MemoSelectionScope`（生产那条选文入口）+ 真 store：
// - 从会话里选一段点「添加到备忘」之后，面板**真的切过去**而且指得出刚进来的是哪条
//   （切面板的是 Host，写入的是模块级 store，两边不在同一棵子树里——拆开单测必然失真）；
// - 长正文折到几行、溢出才给「展开全文」：是不是真溢出要量 scrollHeight，静态渲染量不到；
// - 侧边栏铺开那一格「追问和备忘哪个新显示哪个」，以及悬浮卡里备忘排在追问下面；
// - `?fetch=1`：**真 `useSidebarSpread` 自己去取**备忘摘要（不是静态数据）——「第 201 个
//   任务也拿得到」只能这样测，批次是 hook 内部的事，从外面喂数据永远是绿的。
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Info, NotePencil } from "@phosphor-icons/react";
import type { TaskListItem, TaskFollowUp } from "@ash/shared";
import type { TaskMemoDigest } from "@ash/shared/task-memo";
import { InspectorHost, type InspectorDescriptor } from "../../src/inspector/index.ts";
import { MemoSelectionScope } from "../../src/task-memos/MemoSelectionScope.tsx";
import { setMemoEditDraft } from "../../src/task-memos/taskMemoDrafts.ts";
import { addTaskMemo, editTaskMemo, useTaskMemos } from "../../src/task-memos/taskMemoStore.ts";
import { TaskMemoInspector } from "../../src/task-memos/TaskMemoInspector.tsx";
import { useTaskMemoTab } from "../../src/task-memos/useTaskMemoTab.tsx";
import { SpreadPeekCard, SpreadRowCells, type SpreadRowContext } from "../../src/workspace/TaskSpread.tsx";
import { useSidebarSpread, type SidebarSpread } from "../../src/workspace/useSidebarSpread.ts";
import type { TaskScope } from "../../src/workspace/taskScope.ts";
import "../../src/styles/global.css";

const TASK_ID = "task-a";
const notice = (text: string) => { window.__notices.push(text); };

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
    render: (context) => <TaskMemoInspector taskId={context.taskId} notify={notice} />,
  },
];

/** 绕过界面写进草稿的那几个字。测试脚本（mjs，没法 import 这份 TSX）里照抄同一串。 */
const POKED = "第二版：绕开界面写进来的那几个字";

/**
 * 在途保存期间从**别的入口**改草稿。
 *
 * 界面上那个框这会儿是禁用的，但 store 的写入口不止面板一处（会话浮条也直接进 store），
 * 所以「清草稿要带版本号」是独立的第二道防线 —— 只靠 disabled 的话，任何绕过界面的改动
 * 都会在旧那一发回来时被清掉。这颗按钮就是那个绕过界面的入口。
 */
function DraftPoker() {
  const { memos } = useTaskMemos(TASK_ID);
  const first = memos.at(0);
  if (!first) return null;
  return (
    <button
      type="button"
      data-testid="poke-draft"
      onClick={() => setMemoEditDraft(TASK_ID, first.id, POKED)}
    >
      绕开界面改草稿
    </button>
  );
}

/** 连发两发编辑时各自的正文。测试脚本里照抄同一串。 */
const RACE_A = "先发那一发：只过严格增长门";
const RACE_B = "后发那一发：严格增长门和回归一起过";

/**
 * 绕开界面对同一条备忘连发两发编辑。
 *
 * 界面上发不出来（在途期间那颗按钮是禁用的，store 的占位也会拒第二发），但 store 的 API
 * 是公开的 —— 这颗按钮测的是**应答逆序返回时谁赢**：后发的那一发先落地、先发的后到，
 * 晚到那份带的是旧正文，不许拿它盖回去（第 3 轮审查 F1 的并发伴随项）。
 */
function RaceWriter() {
  const { memos } = useTaskMemos(TASK_ID);
  const first = memos.at(0);
  if (!first) return null;
  return (
    <button
      type="button"
      data-testid="race-edits"
      onClick={() => {
        void editTaskMemo(TASK_ID, first.id, RACE_A).catch(() => undefined);
        void editTaskMemo(TASK_ID, first.id, RACE_B).catch(() => undefined);
      }}
    >
      绕开界面连发两发编辑
    </button>
  );
}

function PanelFixture() {
  const inspectors = useTaskMemoTab(DESCRIPTORS, TASK_ID);
  return (
    <main style={{ display: "flex", height: "100dvh", minHeight: 0 }}>
      <InspectorHost contextKey={`task:${TASK_ID}`} descriptors={inspectors} context={{ taskId: TASK_ID }}>
        {({ openTab }) => (
          <nav style={{ flex: 1, padding: 12 }}>
            {/* 生产那条路就是这个组件（TaskDetail 和 TeamView 共用它），所以夹具也用它 ——
                「存完自己切到备忘那一格」这条就在它里面，绕过去测等于没测。 */}
            <MemoSelectionScope
              taskId={TASK_ID}
              openTab={openTab}
              notify={notice}
              onAsk={() => openTab("side-chat")}
              // 三颗都摆上，顺序才测得出来（备忘排在前两颗之后，用户指定的位置）。
              onAddToReply={(text) => { window.__notices.push(`reply:${text}`); }}
            >
              <p data-testid="said">验收前先把 kb/feeds 那条严格增长门再过一遍</p>
            </MemoSelectionScope>
            {/* 团队调度台那种形态：那一页没有侧聊格，所以 onAsk 不传，浮条上只该出
                「添加到备忘」一颗（第 1 轮审查 F4 补的入口）。 */}
            <MemoSelectionScope taskId={TASK_ID} openTab={openTab} notify={notice}>
              <p data-testid="team-said">调度台这一轮为什么把活拆成三份</p>
            </MemoSelectionScope>
            <DraftPoker />
            <RaceWriter />
          </nav>
        )}
      </InspectorHost>
    </main>
  );
}

// ── 真 hook 自己去取备忘摘要（`?fetch=1`） ───────────────────────────────────

/** 比 TASK_BATCH_LIMIT(200) 多一个：最后那个排在第 201 位，只有真分批才问得到它。 */
const FETCH_COUNT = 201;

/** 写入按钮存的那条备忘。同上，测试脚本里照抄同一串。 */
const FETCHED_MEMO = "第三版：刚刚存上的那条备忘";
const FETCH_SCOPE: TaskScope = { kind: "project", projectId: "p" };

/**
 * `?fetch=1` 的任务数可以用 `&n=` 调小。
 *
 * 默认 201 是为了「第 201 个也问得到」那条；而「迟到的旧批量摘要不许倒退」那条要的恰好
 * 相反 —— 得让 bulk **一批就问完**，否则按批大小分不出哪一发是 bulk、哪一发是写入之后
 * 只问一个任务的补发。
 */
function FetchFixture({ count }: { count: number }) {
  // updatedAt 递减 → hook 按它排序，`old-tail` 稳定落在最后一位。
  const tasks = useMemo<TaskListItem[]>(
    () => Array.from({ length: count }, (_, at) => ({
      ...task(at === count - 1 ? "old-tail" : `t${at}`),
      updatedAt: new Date(Date.parse(NEW) - at * 60_000).toISOString(),
    })),
    [count],
  );
  const spread = useSidebarSpread(tasks, FETCH_SCOPE, 0);
  // 铺开一次就行。`toggle` 是取反，StrictMode 把 effect 跑两遍就正好翻回收起态
  // （调试时它的症状是「一个请求都没发」），所以用 ref 挡住第二次。
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    spread.toggle();
  }, [spread]);
  const tail = tasks[count - 1];
  const ctx: SpreadRowContext = { spread, peekAt: () => undefined, peekOut: () => undefined };
  return (
    <main style={{ padding: 16 }}>
      {/* 只画最后那一行：它是「排在首批之外」的那个任务。 */}
      <div data-testid="row-old-tail" style={{ display: "flex", width: 560, gap: 8 }}>
        <SpreadRowCells task={tail} ctx={ctx} onOpen={() => undefined} />
      </div>
      {/* 真写一条进 store：这一下推动写入版本，那一列据此补发只问这个任务的摘要。 */}
      <button type="button" data-testid="write-memo" onClick={() => void addTaskMemo(tail.id, FETCHED_MEMO)}>
        写一条备忘
      </button>
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

const query = new URLSearchParams(window.location.search);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {query.has("spread")
      ? <SpreadFixture />
      : query.has("fetch")
        ? <FetchFixture count={Number(query.get("n")) || FETCH_COUNT} />
        : <PanelFixture />}
  </StrictMode>,
);
