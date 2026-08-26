import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentExecutorProfile } from "@ash/shared";
import { AgentProfilesSection } from "../../src/settings/AgentProfilesSection.tsx";
import type { DetectedCli } from "../../src/lib/api.ts";
import "../../src/styles/global.css";

const profiles: AgentExecutorProfile[] = [{
  id: "codex-local",
  name: "codex@local",
  type: "codex",
  target: { kind: "local" },
  model: null,
  reasoningEffort: null,
  isDefault: true,
}];

const CODEX_WARNING = "Codex CLI 0.147.x 有已知工具注册/恢复异常，可能把终端调用路由到错误工具。"
  + "请运行 npm install -g @openai/codex，升级到 0.148.0 或更高版本。";

const detectedClis: DetectedCli[] = [{
  key: "codex",
  type: "codex",
  name: "Codex CLI",
  description: "OpenAI 官方 CLI",
  bins: ["codex"],
  docsUrl: "https://example.invalid",
  installCommand: "npm install -g @openai/codex",
  bin: "codex",
  available: true,
  path: "C:/stub/codex.cmd",
  version: "codex-cli 0.147.8",
  versionWarning: CODEX_WARNING,
  resident: true,
}];

function Fixture() {
  // null = 用户还没点过「检测本地智能体」。点一下才换成检测结果。
  const [detected, setDetected] = useState<DetectedCli[] | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  return (
    <main style={{ width: 900, margin: "24px auto" }}>
      <AgentProfilesSection
        profiles={profiles}
        providers={[]}
        loading={false}
        detecting={false}
        detected={detected}
        registeringKey={null}
        onDetect={() => setDetected(detectedClis)}
        onRegister={() => {}}
        onProfileChanged={() => {}}
        onProfileAdded={() => {}}
        onProfilesDeleted={() => {}}
        notify={(message) => setNotices((current) => [...current, message])}
      />
      <pre data-testid="notices">{JSON.stringify(notices)}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
