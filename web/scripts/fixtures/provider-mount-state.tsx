// 供应商列表要当面说清「有没有执行器挂它」—— 没人挂的那家在任务里是选不到的,
// 这页不说,用户就只能得出「加了但用不了」。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentExecutorProfile, LlmProvider } from "@ash/shared";
import { ProvidersSection } from "../../src/settings/ProvidersSection.tsx";
import "../../src/styles/global.css";

const provider = (id: string, name: string): LlmProvider => ({
  id,
  name,
  protocol: "anthropic",
  baseUrl: `https://${id}.example.com`,
  model: "relay-opus",
  protocolConversionEnabled: false,
  modelListMode: "pinned",
  pinnedModels: ["relay-opus"],
  context1mModels: [],
  hasKey: true,
  createdAt: new Date().toISOString(),
});

const PROVIDERS = [provider("p-mounted", "已挂中转"), provider("p-orphan", "没人挂的中转")];

const PROFILES: AgentExecutorProfile[] = [
  { id: "claude-relay", name: "claude@已挂中转", type: "claude", providerId: "p-mounted", isDefault: true },
];

function Fixture() {
  const [jumps, setJumps] = useState(0);
  return (
    // 卡片宽度跟着视口走(同 settings-card-fit 夹具的做法):状态列多了一颗药丸,
    // 窄下来时必须自己换行,而不是把这一行顶出卡片。
    <main className="settings-main" style={{ width: "min(880px, calc(100% - 32px))", margin: "24px auto" }}>
      <ProvidersSection
        providers={PROVIDERS}
        profiles={PROFILES}
        onOpenExecutors={() => setJumps((count) => count + 1)}
        onChanged={async () => {}}
        notify={() => {}}
      />
      <pre data-testid="jumps">{jumps}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
