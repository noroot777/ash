// 哨兵面板的回归夹具。三件事要在**真壳子**里才测得出来，所以这里用的是真的
// `InspectorHost`（默认宽 340px）加真的 `useMonitorInspector`：
// - 卡片在 340px 下会不会把「停掉」按钮挤出面板（脱开这层壳单测组件复现不出布局）；
// - 切任务时上一个任务的迟到响应会不会盖到当前面板上（hook 挂在 Host 之外，
//   跟 TaskDetail 一样——Host 自己是按 contextKey 重挂的，hook 不是）；
// - 「用过才浮现」那条规矩落到图标条上是什么样（`?rail=1`，见下）：挂没挂过哨兵决定它
//   上不上条，底色来自 CSS 的 `:has(.inspector-rail-icon--used)`，类名一改就悄悄没了。
// - 回复框上那条「在等哨兵」展开之后说了什么（`?wait=pending|claimed`）：它默认折叠，正文
//   **要点开才渲染**，所以静态渲染根本摸不到那段文案（第 21 轮审查 N2：上一版那条静态断言
//   查的是折叠态，于是「不含某句话」在任何实现下都成立）。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Info, Pulse } from "@phosphor-icons/react";
import type { TaskMonitor } from "@ash/shared/monitor";
import { InspectorHost, type InspectorDescriptor } from "../../src/inspector/index.ts";
import { MonitorInspector } from "../../src/monitors/MonitorInspector.tsx";
import { MonitorWaitCard } from "../../src/monitors/MonitorWaitCard.tsx";
import { useMonitorInspector } from "../../src/monitors/useMonitorInspector.tsx";
import type { TaskMonitorsState } from "../../src/monitors/useTaskMonitors.ts";
import "../../src/styles/global.css";

interface Context { monitors: TaskMonitorsState }

const MONITORS: InspectorDescriptor<Context> = {
  id: "monitors",
  title: "哨兵",
  icon: <Pulse size={14} />,
  shortcut: "m",
  render: (context) => <MonitorInspector monitors={context.monitors} blockedReason={null} />,
};

// 默认只有哨兵这一格：`defaultState` 的兜底（一格 defaultOpen 都没有就开第一格）让它直接
// 摊开，上面那两段测的是面板内部的事。`?rail=1` 再加一格真·默认开的「信息」顶住兜底，
// 这时哨兵上不上图标条才真由「用过没用过」说了算——真实的 TASK_INSPECTORS 就是后者。
const DESCRIPTORS: readonly InspectorDescriptor<Context>[] =
  new URLSearchParams(window.location.search).has("rail")
    ? [{ id: "info", title: "信息", icon: <Info size={14} />, defaultOpen: true, shortcut: "i", render: () => <p>信息</p> }, MONITORS]
    : [MONITORS];

/** 「在等哨兵」那张卡的台子：pid 还空着（认领受阻）与正常在盯两种，正文只有点开才有。 */
const WAIT_BASE: TaskMonitor = {
  id: "m-wait", taskId: "task-a", kind: "ash", nativeId: null, lifetime: "bounded",
  command: "tail -F build.log", description: "盯构建日志", cwd: "/repo", status: "running",
  pid: 4242, events: 3, exitCode: null,
  startedAt: "2026-10-17T02:00:00.000Z", expiresAt: "2026-10-17T04:00:00.000Z",
  timeoutMs: 7_200_000, endedAt: null, endedReason: null,
};
const WAIT_PENDING: TaskMonitor = {
  ...WAIT_BASE, pid: null, events: 0,
  endedReason: "server 重启后这一刻认不回它：起进程时没来得及记下 pid（身份边条这一刻读不出来："
    + "读盘报错：EIO），所以一个信号都没发；这条创建意图原样留着：日志和期限已经有人接着管，"
    + "ash 同时在按间隔重问身份，认回来就把这句话撤掉（日志路径见这一行）",
};

function WaitFixture({ mode }: { mode: string }) {
  return (
    <main style={{ padding: 16 }}>
      <MonitorWaitCard
        monitors={[mode === "pending" ? WAIT_PENDING : WAIT_BASE]}
        builtinCount={0}
        status="paused"
        resumePrompt="继续：接着做 tts 这一段"
        reviewArmed={false}
        onOpenPanel={() => undefined}
      />
    </main>
  );
}

function Fixture() {
  const [taskId, setTaskId] = useState("task-a");
  const { inspectors, monitors } = useMonitorInspector(DESCRIPTORS, taskId);
  return (
    <main style={{ display: "flex", height: "100dvh", minHeight: 0 }}>
      <InspectorHost contextKey={`task:${taskId}`} descriptors={inspectors} context={{ monitors }}>
        {() => (
          <nav style={{ flex: 1, padding: 12 }}>
            <button type="button" onClick={() => setTaskId(taskId === "task-a" ? "task-b" : "task-a")}>
              切换任务
            </button>
            <output data-testid="task">{taskId}</output>
            <output data-testid="ids">{monitors.monitors.map((monitor) => monitor.id).join(",")}</output>
            <output data-testid="error">{monitors.error ?? ""}</output>
          </nav>
        )}
      </InspectorHost>
    </main>
  );
}

const waitMode = new URLSearchParams(window.location.search).get("wait");
createRoot(document.getElementById("root")!).render(
  <StrictMode>{waitMode ? <WaitFixture mode={waitMode} /> : <Fixture />}</StrictMode>,
);
