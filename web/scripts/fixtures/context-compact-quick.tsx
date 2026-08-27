import { createRoot } from "react-dom/client";
import type { Session } from "@ash/shared";
import { ContextMeterChip } from "../../src/components/ContextMeterChip.tsx";
import "../../src/styles/global.css";

// 一条走 claude 的会话：胶囊里那颗「压缩设置」要能定位到它的执行器 profile。
const session = {
  id: "s1",
  taskId: "t1",
  role: "single",
  agentType: "claude",
  executor: "claude@官方·opus",
  executorId: "claude-official",
  model: "opus-5",
  cliSessionId: "01a03152-a54f",
  usage: null,
  context: { used: 183_842, window: 1_000_000, windowEstimated: false, compactWindow: 400_000 },
  startedAt: "2026-08-26T03:23:00.000Z",
  endedAt: null,
} as unknown as Session;

// 同一颗胶囊挂在 codex 会话上：那家 CLI 没有可覆盖的配置，快捷设置一个字都不该出现。
const codexSession = { ...session, id: "s2", agentType: "codex", executor: "codex@local" } as unknown as Session;

createRoot(document.getElementById("root")!).render(
  <main style={{ display: "flex", gap: 24, width: 900, margin: "160px auto" }}>
    <span data-testid="claude-chip">
      <ContextMeterChip context={session.context} session={session} />
    </span>
    <span data-testid="codex-chip">
      <ContextMeterChip context={codexSession.context} session={codexSession} />
    </span>
  </main>,
);
