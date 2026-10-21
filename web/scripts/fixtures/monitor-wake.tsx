import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Session, Task } from "@ash/shared";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import { TeamFeed } from "../../src/team/TeamFeed.tsx";
import { api } from "../../src/lib/api.ts";
import "../../src/styles/global.css";

api.taskQuestionHistory = async () => [];
class FixtureEvents extends EventTarget {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    super();
    queueMicrotask(() => this.onopen?.());
  }
  close() {}
}
window.EventSource = FixtureEvents as unknown as typeof EventSource;

const at = "2026-10-21T04:24:00.000Z";
const output = "【哨兵事件】全量回归（补完第六处闸之后）（monitorId=ePcGkgxYwEYV）\nRan 3471 tests in 719.547s\nOK (skipped=1)\nSWEEP_EXIT=0\n全文在 /tmp/kb-sweep5.log";
const endNotice = "【哨兵结束】全量回归（清静机器上的提交前那一遍）（monitorId=bZMEcdQ29utf），退出码 0。命令自己跑完了";
const currentEndNotice = "【哨兵结束】全量回归（补完第六处闸之后）（monitorId=ePcGkgxYwEYV），退出码 0。命令自己跑完了";
const scenarios = {
  result: { label: "新结果到达", text: output, reply: "收到这轮全量回归结果：共运行 3471 项测试，整轮通过（跳过 1 项），退出码 0。\n\n我会据此核对最终改动和提交状态，再完成收尾。" },
  ended: { label: "旧哨兵结束", text: endNotice, reply: "刚才这条是旧哨兵的结束通知，不是新结果。\n\n提交前那一遍全量还在跑；等它收尾后我再提交。" },
  batch: { label: "多事件合并", text: output + "\n\n" + currentEndNotice + "\n\n【你当初留下的续跑交代】核对结果后再收尾。", reply: "收到合并输入里的回归输出和结束通知，我会一起核对这轮结果。\n\n这次只继续处理一轮，不会把结束通知直接当作任务完成。" },
  long: { label: "长输出", text: output + "\n" + "long-output-".repeat(1200), reply: "完整输出仍在输入详情里，先核对最后的结果。" },
};
const session = {
  id: "wake-session", taskId: "wake-fixture", agentType: "claude", role: "single", executor: "claude@nodemach",
  model: "claude-opus-5", reasoningEffort: "xhigh", startedAt: "2026-10-21T04:18:00.000Z", endedAt: "2026-10-21T04:25:27.000Z",
} as unknown as Session;
const task = { id: "wake-fixture", title: "补齐校验闸，跑完全量回归", body: "", status: "done", mode: "single" } as unknown as Task;
const sentinel = (kind: string, text: string, time: string, extra = {}) => `\n\x1e${JSON.stringify({ t: kind, text, at: time, ...extra })}\n`;

function Fixture() {
  const [scenario, setScenario] = useState<keyof typeof scenarios>("result");
  const [team, setTeam] = useState(false);
  const current = scenarios[scenario];
  const items = buildConversationItems([{ session, trace: [], output: [
    sentinel("user", "补完校验闸后，再跑一遍全量回归。等结果回来再收尾。", session.startedAt),
    "全量回归已经启动，我会等这一轮的结果，不用你再手动叫我。",
    sentinel("system", "哨兵结束：全量回归，退出码 0。命令自己跑完了", "2026-10-21T04:23:59.000Z", { aside: true }),
    sentinel("user", current.text, at, { by: "system" }),
    current.reply,
  ].join("\n") }], [session], []);
  return <main style={{ display: "flex", height: "100vh", flexDirection: "column", background: "var(--canvas)" }}>
    <header style={{ display: "flex", gap: 8, padding: 14, flexWrap: "wrap", borderBottom: "1px solid var(--line)" }}>
      <b style={{ fontSize: 12, marginRight: 12 }}>自动输入 · 正式组件</b>
      {Object.entries(scenarios).map(([value, entry]) => <button key={value} type="button" aria-pressed={scenario === value} onClick={() => setScenario(value as keyof typeof scenarios)}>{entry.label}</button>)}
      <button type="button" aria-pressed={team} onClick={() => setTeam(!team)}>{team ? "团队会话" : "任务会话"}</button>
    </header>
    <div style={{ minHeight: 0, flex: 1, width: "100%", maxWidth: 1080, alignSelf: "center" }}>
      {team
        ? <TeamFeed task={{ ...task, mode: "team" }} rows={items.map((item) => ({ kind: "conv", key: item.id, item }))} workers={[]} onOpenWorker={() => undefined} onAskLead={() => undefined} delegatingIds={new Set()} indicatorForTask={() => null} />
        : <ConversationFeed task={task} items={items} sessions={[session]} loading={false} error={null} />}
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
