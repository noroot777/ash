// 派活单（task-detail/DispatchPlanCard.tsx）的夹具：真的 ReplyBox + QuestionSlot 接管那一格、真的左抽屉宿主。
// 「派出去」「发回去改」「派出去的活交给谁」交出来的东西原样写在页面底下，回归照着它断言。
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import type { DispatchPlan, DispatchRunTarget } from "@ash/shared/dispatch-plan";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { LeftDrawerProvider, useLeftDrawerHost } from "../../src/components/LeftDrawer.tsx";
import "../../src/styles/global.css";

const plan: DispatchPlan = {
  id: "plan-1", order: "serial", proposedAt: "2026-11-15T01:00:00.000Z",
  question: "派出这 3 个任务（一个接一个）：\n1. 服务端接口\n2. 前端卡片\n3. 回归测试",
  items: [
    { title: "服务端接口", body: "## 服务端接口\n\n加一条摆单端点，落暂停。", note: "先做，后两条依赖它", target: null },
    { title: "前端卡片", body: "照答题卡的骨架画派活单。", note: "", target: { agentType: "codex", executorId: "codex-main", model: null, reasoningEffort: null } },
    { title: "回归测试", body: "覆盖派出与发回。", note: "跑绿再交", target: null },
  ],
};
const initial = {
  id: "dispatch-plan-fixture", projectId: "fixture", title: "派活单", body: "", mode: "single", status: "paused",
  question: plan.question, questionOptions: null, questionItems: null, dispatchPlan: plan, dispatchTarget: null,
  createdAt: "2026-11-15T01:00:00.000Z", updatedAt: "2026-11-15T01:00:00.000Z",
  labels: [], dependsOn: [], resumeDependsOn: [], agentType: "claude", executorId: "claude-main", archived: false,
} as unknown as Task;

function Fixture() {
  const [task, setTask] = useState<Task>(initial);
  const [log, setLog] = useState("");
  const [fail, setFail] = useState(false);
  // 「第一笔写回慢」：派出去的活交给谁的第一次保存晚 2.5 秒才落地（模拟网络慢、先发的后到），落地的先后记在「写回记录」里。
  const [slowFirst, setSlowFirst] = useState(false);
  const saves = useRef(0);
  const [trail, setTrail] = useState<string[]>([]);
  const note = (line: string) => setTrail((current) => [...current, line]);
  const drawer = useLeftDrawerHost({ resetKey: task.id });
  const settle = () => setTask((current) => ({ ...current, question: null, dispatchPlan: null }));
  return <LeftDrawerProvider value={drawer.api}>
    <main style={{ height: "100dvh", maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", background: "var(--canvas)", position: "relative" }}>
      <header style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 12, borderBottom: "1px solid var(--line)", fontSize: 12 }}>
        <b>派活单交互验证</b>
        <button onClick={() => { setTask(initial); setLog(""); setFail(false); setTrail([]); saves.current = 0; }}>重置</button>
        <button onClick={() => setTask((current) => ({ ...current, status: current.status === "running" ? "paused" : "running" }))}>切换摆单状态</button>
        <label><input type="checkbox" checked={fail} onChange={(event) => setFail(event.target.checked)} />模拟派出失败</label>
        <label><input type="checkbox" checked={slowFirst} onChange={(event) => setSlowFirst(event.target.checked)} />第一笔写回慢</label>
      </header>
      <div className="task-detail-main" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        <div style={{ flex: 1 }} />
        <ReplyBox task={task} hasConversation onSend={async () => ({ started: true })} onStandingExecutorChange={async () => undefined}
          onAnswer={async (answer) => { setLog(JSON.stringify({ kind: "answer", answer })); settle(); }}
          onLaunchPlan={async (input) => {
            if (fail) throw new Error("派出失败，卡上的改动都还在。");
            note("launch"); setLog(JSON.stringify({ kind: "launch", ...input })); settle();
          }}
          onDispatchTargetChange={async (target: DispatchRunTarget | null) => {
            if (slowFirst && ++saves.current === 1) await new Promise((resolve) => setTimeout(resolve, 2500));
            note(`save:${target?.agentType ?? "same"}`);
            setLog(JSON.stringify({ kind: "target", target })); setTask((current) => ({ ...current, dispatchTarget: target }));
          }} />
        {drawer.drawer}
      </div>
      {trail.length > 0 && <pre aria-label="写回记录" style={{ padding: 12, margin: 0, fontSize: 11 }}>{trail.join(" ")}</pre>}
      {log && <pre aria-label="交出去的东西" style={{ padding: 12, margin: 0, borderTop: "1px solid var(--line)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{log}</pre>}
    </main>
  </LeftDrawerProvider>;
}
createRoot(document.getElementById("root")!).render(<DraftProvider><Fixture /></DraftProvider>);
