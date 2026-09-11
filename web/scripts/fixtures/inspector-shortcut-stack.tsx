import { StrictMode, act, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Robot } from "@phosphor-icons/react";
import type { AgentEvent, Session } from "@ash/shared";
import type { SessionTraceEntry } from "../../src/lib/api.ts";
import { InspectorHost, type InspectorDescriptor } from "../../src/inspector/index.ts";
import { activateInspectorShortcut, hasInspectorShortcutTarget, type InspectorShortcutKey } from "../../src/inspector/shortcuts.ts";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import { useSubagents } from "../../src/task-detail/useSubagents.tsx";
import "../../src/styles/global.css";

type Context = null;
const session = { id: "shortcut-stack", taskId: "outer", agentType: "codex", role: "single", executor: "fixture", startedAt: "2026-09-10T00:00:00.000Z", endedAt: null } as unknown as Session;
type NativeWork = NonNullable<Extract<AgentEvent, { kind: "tool" }>["nativeWork"]>;
const native = (nativeWork: NativeWork): SessionTraceEntry => ({ at: session.startedAt, turnStartedAt: session.startedAt, event: { kind: "tool", name: "fixture", nativeWork } });
const populatedItems = buildConversationItems([{ session, output: "fixture", trace: [
  native({ type: "call", id: "spawn", name: "spawn_agent", input: { description: "fixture child" } }),
  native({ type: "result", id: "spawn", result: JSON.stringify({ agent_id: "child" }), failed: false }),
] }], [session], []);
const panel = (name: string) => () => <p data-panel={name}>{name}</p>;
const outerBase: InspectorDescriptor<Context>[] = [
  { id: "subagents", title: "子智能体", shortcut: "s", icon: <Robot size={14} />, render: panel("outer-subagents") },
  { id: "outer-info", title: "外层信息", shortcut: "i", icon: <Robot size={14} />, render: panel("outer-info") },
  { id: "outer-extra", title: "外层专属", shortcut: "e", icon: <Robot size={14} />, render: panel("outer-extra") },
];

function App() {
  const [error, setError] = useState<Error | null>(null);
  const [populated, setPopulated] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [remapped, setRemapped] = useState(false);
  const outer = useSubagents(outerBase, { taskId: "outer", items: populated ? populatedItems : [], status: "running", error }).inspectors;
  const drawerDescriptors = useMemo<InspectorDescriptor<Context>[]>(() => remapped ? [
    { id: "drawer-fresh", title: "抽屉最新映射", shortcut: "f", icon: <Robot size={14} />, render: panel("drawer-fresh") },
    { id: "drawer-info", title: "抽屉信息", shortcut: "i", icon: <Robot size={14} />, render: panel("drawer-info") },
  ] : [
    { id: "drawer-files", title: "抽屉文件", shortcut: "f", icon: <Robot size={14} />, render: panel("drawer-files") },
    { id: "drawer-info", title: "抽屉信息", shortcut: "i", icon: <Robot size={14} />, render: panel("drawer-info") },
  ], [remapped]);
  return <>
    <button id="error-on" onClick={() => setError(new Error("trace"))}>error on</button>
    <button id="error-off" onClick={() => setError(null)}>error off</button>
    <button id="agent-on" onClick={() => setPopulated(true)}>agent on</button>
    <button id="agent-off" onClick={() => setPopulated(false)}>agent off</button>
    <button id="drawer-on" onClick={() => setDrawer(true)}>drawer on</button>
    <button id="drawer-off" onClick={() => setDrawer(false)}>drawer off</button>
    <button id="remap" onClick={() => setRemapped(true)}>remap</button>
    <section data-host="outer"><InspectorHost contextKey="shortcut-outer" descriptors={outer} context={null}>{() => <main />}</InspectorHost></section>
    {drawer && <section data-host="drawer"><InspectorHost contextKey="shortcut-drawer" descriptors={drawerDescriptors} context={null} defaultVisible={false}>{() => <main />}</InspectorHost></section>}
  </>;
}

const storageKeys = ["ash:inspector:shortcut-outer", "ash:inspector:shortcut-drawer"];
const clearStorage = () => storageKeys.forEach((key) => window.localStorage.removeItem(key));
clearStorage();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const root = createRoot(document.getElementById("root")!);
const result = document.getElementById("result")!;
const click = async (id: string) => { await act(async () => document.getElementById(id)!.click()); };
const activate = async (key: InspectorShortcutKey) => {
  let handled = false;
  await act(async () => { handled = activateInspectorShortcut(key); });
  return handled;
};
const active = (host: string) => document.querySelector(`[data-host="${host}"] [role="tab"][aria-selected="true"]`)?.getAttribute("data-tab-id") ?? null;
const visible = (host: string) => !!document.querySelector(`[data-host="${host}"] .inspector-host`);
const panelVisible = (name: string) => !!document.querySelector(`[data-panel="${name}"]`);
const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

async function run() {
  const log: string[] = [];
  await act(async () => root.render(<StrictMode><App /></StrictMode>));
  expect(hasInspectorShortcutTarget(), "outer should register on mount");
  expect(await activate("s"), "outer should handle s");
  expect(active("outer") === "subagents", "outer should open subagents");

  await click("drawer-on");
  expect(!visible("drawer"), "drawer inspector should start collapsed");
  expect(await activate("f"), "collapsed drawer should handle f");
  expect(active("drawer") === "drawer-files" && visible("drawer"), "drawer should open files");

  for (const id of ["error-on", "error-off", "agent-on", "agent-off"]) {
    await click(id);
    const key = id === "error-on" || id === "agent-on" ? "i" : "f";
    expect(await activate(key), `drawer should keep priority after ${id}`);
    expect(active("outer") === "subagents", `outer must stay unchanged after ${id}`);
    expect(active("drawer") === (key === "i" ? "drawer-info" : "drawer-files"), `drawer should handle ${key} after ${id}`);
    log.push(id);
  }

  const drawerBeforeUnhandled = active("drawer");
  expect(!await activate("e"), "unhandled drawer key should return false");
  expect(active("drawer") === drawerBeforeUnhandled, "unhandled key must not change drawer");
  expect(!panelVisible("outer-extra"), "unhandled key must not fall through to outer");

  await click("remap");
  expect(await activate("f"), "drawer should read latest shortcut mapping");
  expect(active("drawer") === "drawer-fresh" && panelVisible("drawer-fresh"), "latest descriptor id and openTab closure should be used");

  await click("drawer-off");
  expect(await activate("e"), "outer should recover after drawer unmount");
  expect(active("outer") === "outer-extra", "outer should handle shortcut after drawer unmount");
  await act(async () => root.unmount());
  expect(!hasInspectorShortcutTarget(), "all shortcut registrations should be removed");
  expect(!activateInspectorShortcut("i"), "no shortcut should be handled after final unmount");
  clearStorage();
  result.textContent = `PASS\n${log.join(" -> ")}\nlatest mapping and cleanup passed`;
  result.dataset.status = "pass";
}
run().catch((reason) => {
  clearStorage();
  result.textContent = `FAIL\n${reason instanceof Error ? reason.stack : String(reason)}`;
  result.dataset.status = "fail";
});
