import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HandoffTarget, ProjectView, Task, TaskListItem } from "@ash/shared";
import { TaskTree } from "../../src/workspace/TaskTree.tsx";
import { useSidebarTaskNavigation } from "../../src/workspace/sidebarNavigation.ts";
import { spreadVisibleTasks, type SidebarSpread } from "../../src/workspace/useSidebarSpread.ts";
import type { TaskScope } from "../../src/workspace/taskScope.ts";
import { useWorkspaceShortcuts } from "../../src/workspace/useWorkspaceShortcuts.ts";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/styles/task-tree.css";

// J/K 必须按**屏幕上看得见的那份列表**走。这个 fixture 把屏幕和模型故意摆成两种顺序：
// 任务模式下「任务」那一节按项目再分一层，而模型那份（spreadVisibleTasks）是纯更新时间
// 倒序 —— 两家的行序因此必然不同，正是「按一下 J 跳过好几行」的来源。除此之外还摆上了
// 年龄闸折起来的旧行、团队行底下的执行者、可折叠的项目分组、「其他项目」那一叠、
// 「其他机器」那一节，每一处都是只有屏幕知道、模型看不见的状态。

const now = Date.now();
const recent = (minutes: number) => new Date(now - minutes * 60 * 1000).toISOString();
const stale = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();

const project = (id: string, name: string): ProjectView => ({
  id,
  name,
  repoPath: `/tmp/${id}`,
  workflowId: null,
  useWorktreeDefault: false,
  createdAt: recent(600),
  health: { exists: true, isRepo: true },
});

const ash = project("p1", "ash");
const other = project("p2", "隔壁项目");

function task(id: string, title: string, updatedAt: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    projectId: ash.id,
    groupId: null,
    parentId: null,
    title,
    body: "",
    mode: "single",
    // 在跑 = 任务模式也收它（见 taskScope 的 inTaskMode）。旧行那两条例外，它们要的正是
    // 「盖过章的出局」—— 不然年龄闸会豁免它们，就造不出「屏幕上没有、模型里有」的行了。
    status: "running",
    stage: null,
    labels: [],
    dependsOn: [],
    resumeDependsOn: [],
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  };
}

/** 年龄闸外面那种行：跑完、盖过章，所以既不活着也不等人，会被折进「展开(N/N)」。 */
function settled(id: string, title: string, updatedAt: string): Task {
  return task(id, title, updatedAt, { status: "done", stage: "accepted" });
}

const target: HandoffTarget = { name: "mac-mini", url: "http://mac-mini:4317", peerFp: "a".repeat(64) };

// 更新时间故意交错两个项目：模型那份（纯时间倒序）会把两家的行拌在一起，而屏幕上
// 任务模式按项目分组，一家接一家 —— 两种顺序对不上，J/K 跟哪一份一按就看出来。
const tasks: Task[] = [
  task("pin", "置顶的那条", recent(300), { pinnedAt: now - 1000 }),
  task("a1", "A 项目 最新", recent(10)),
  task("b1", "B 项目 第二新", recent(20), { projectId: other.id }),
  task("a2", "A 项目 第三新", recent(30)),
  task("b2", "B 项目 第四新", recent(40), { projectId: other.id }),
  task("team", "人多的团队", recent(50), { mode: "team" }),
  task("w1", "执行者 一号", recent(52), { parentId: "team", createdAt: recent(120) }),
  task("w2", "执行者 二号", recent(54), { parentId: "team", createdAt: recent(110) }),
  settled("old1", "旧任务 一", stale(48)),
  settled("old2", "旧任务 二", stale(72)),
  // 接力出去的那条：单项目态下它从主列表里摘掉，改在「其他机器」那一节露面。
  task("gone", "交给 mac-mini 了", recent(60), {
    handoff: {
      direction: "out",
      peerUrl: target.url,
      peerName: target.name,
      peerFp: target.peerFp,
      originFp: "b".repeat(64),
      peerTaskId: "gone",
      at: recent(60),
      sessions: 1,
      git: "bundle",
    },
  }),
  ...Array.from({ length: 3 }, (_, index) =>
    task(`o${index + 1}`, `隔壁任务 ${index + 1}`, recent(70 + index), { projectId: other.id }),
  ),
];

const nativeFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/handoff/targets")) {
    return new Response(JSON.stringify({ targets: [target] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return nativeFetch(input as RequestInfo, init);
}) as typeof window.fetch;

const idleSpread: SidebarSpread = {
  open: false,
  laidOut: false,
  filter: "all",
  setFilter: () => {},
  followUps: new Map(),
  bodies: new Map(),
  loaded: new Set(),
  toggle: () => {},
  close: () => {},
};

function Ash() {
  const [taskMode, setTaskMode] = useState(false);
  // 「所有项目分组都收起」那一档要求屏幕上一行都不剩,而「置顶」那一节是不可折叠的
  // （用户 2026-09-08 拍板),所以用例得先把置顶摘掉。
  const [pinned, setPinned] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRemoteTaskId, setSelectedRemoteTaskId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const spread = useMemo(() => idleSpread, []);
  const rows = useMemo(
    () => pinned ? tasks : tasks.map((item) => item.id === "pin" ? { ...item, pinnedAt: null } : item),
    [pinned],
  );
  const scope: TaskScope = taskMode ? { kind: "tasks" } : { kind: "project", projectId: ash.id };
  // 模型那份顺序：侧栏收起时 J/K 的退路，也是这个 fixture 用来证明「两种顺序确实不同」的对照。
  const modelOrder = useMemo(() => spreadVisibleTasks(rows, scope, "all"), [rows, scope]);

  const select = (next: TaskListItem) => {
    // 接力出去的行点开进的是远端那份实时会话（真实里走 selectRemoteTask），
    // 选中身份因此落在另一个字段上 —— 对这份列表来说两者是同一件事：亮着的那一行。
    if (next.handoff?.direction === "out" && !next.handoff.pending) {
      setSelectedTaskId(null);
      setSelectedRemoteTaskId(next.id);
      return;
    }
    setSelectedRemoteTaskId(null);
    setSelectedTaskId(next.id);
  };

  const navigate = useSidebarTaskNavigation({
    tasks: rows,
    fallbackOrder: modelOrder,
    selectedTaskId,
    selectedRemoteTaskId,
    onTask: select,
  });

  useWorkspaceShortcuts({
    enabled: true,
    paletteOpen: false,
    composerOpen: false,
    spreadOpen: false,
    onNavigate: navigate,
    onTogglePalette: () => {},
    onCreate: () => {},
    onToggleSpread: () => {},
    onCloseSpread: () => {},
    onToggleTaskMode: () => {},
    onOpenSettings: () => {},
    onToggleCommands: () => {},
    onToggleTerminal: () => {},
  });

  return (
    <main>
      <p data-testid="selected">{selectedTaskId ?? selectedRemoteTaskId ?? ""}</p>
      <p data-testid="model-order">{modelOrder.map((item) => item.id).join(" ")}</p>
      <button type="button" data-testid="toggle-mode" onClick={() => setTaskMode((value) => !value)}>
        切换任务模式
      </button>
      {/* 回到「一行都没选」：没有选中时 J 该落在列表第一行上，每段用例都从这里起步。 */}
      <button
        type="button"
        data-testid="clear-selection"
        onClick={() => { setSelectedTaskId(null); setSelectedRemoteTaskId(null); }}
      >
        清空选中
      </button>
      {/* 侧栏收起 = 屏幕上没有这份列表，J/K 只能退回模型顺序。 */}
      <button type="button" data-testid="toggle-sidebar" onClick={() => setSidebarOpen((value) => !value)}>
        收起/展开侧栏
      </button>
      <button type="button" data-testid="toggle-pin" onClick={() => setPinned((value) => !value)}>
        切换置顶
      </button>
      {sidebarOpen && (
        <aside className="workspace-sidebar" style={{ width: 320, minHeight: 520 }}>
          <TaskTree
            projects={[ash, other]}
            currentProjectId={ash.id}
            scope={scope}
            tasks={rows}
            selectedTaskId={selectedTaskId}
            selectedRemoteTaskId={selectedRemoteTaskId}
            spread={spread}
            onTask={select}
            onRemoteTask={(next) => { setSelectedTaskId(null); setSelectedRemoteTaskId(next.id); }}
            onTaskStarred={() => {}}
            onHandoffFinished={() => {}}
            outbound={{ outboundCount: 1, offlinePeers: [], asked: false, refreshing: false, onRefresh: () => {} }}
            notify={() => {}}
          />
        </aside>
      )}
    </main>
  );
}

window.localStorage.clear();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);
