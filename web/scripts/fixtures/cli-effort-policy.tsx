// 「CLI 额度」热切换之后,档位菜单该不该跟着翻面(第 2 轮审查那条)。
//
// 这一屏刻意把两件真东西摆在一起:一个真的 RunTargetPicker(它的第三段读
// `useCliModelCatalog().modelEfforts`),和一个真的 `api.patchSettings({ sharedHostCli })`
// —— 设置页那个开关按下去走的就是这一条。中间那段「学到新政策 → 让目录缓存作废 →
// 替已挂载的选择器重取」没接上的话,这一屏点完开关,菜单里还留着旧那一档的档位。
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentType } from "@ash/shared";
import { RunTargetPicker } from "../../src/components/RunTargetPicker.tsx";
import type { AgentModelSelection } from "../../src/task-detail/mentionPicker.ts";
import { api } from "../../src/lib/api.ts";
import "../../src/styles/global.css";

const TYPES: AgentType[] = ["codex"];

function Ash() {
  const [selection, setSelection] = useState<{ agentType: AgentType; executorId: string | null }>({
    agentType: "codex",
    executorId: null,
  });
  // 报告里那条用例:codex + codex-auto-review。隔离档没有规则命中,档位是 CLI 并集
  // (含 ultra);共用档下探针说它只有 low..max。
  const [model, setModel] = useState<string | null>("codex-auto-review");
  const [effort, setEffort] = useState("high");
  const [shared, setShared] = useState(false);
  const [note, setNote] = useState("");

  // 真设置页要先把 AppSettings 渲染出来才点得到那个开关,所以挂载时必有这一次 GET。
  // 前端学到「当前是哪一档」的唯一来源就是它(见 lib/hostCliPolicy.ts)。
  useEffect(() => {
    void api.settings().then((settings) => setShared(settings.sharedHostCli));
  }, []);

  const commit = (next: AgentModelSelection) => {
    setSelection({ agentType: next.agent, executorId: next.executorId });
    if (next.model !== null) setModel(next.model);
  };

  return (
    <main style={{ width: 560, padding: 80 }}>
      <RunTargetPicker
        label="测试执行目标"
        types={TYPES}
        profiles={[]}
        selection={selection}
        model={model}
        effort={effort}
        onCommit={commit}
        onEffortChange={setEffort}
      />
      <button
        type="button"
        data-testid="toggle-quota"
        onClick={async () => {
          const next = !shared;
          const settings = await api.patchSettings({ sharedHostCli: next });
          setShared(settings.sharedHostCli);
          setNote(settings.sharedHostCli ? "共用" : "隔离");
        }}
      >
        切换 CLI 额度
      </button>
      <output data-testid="quota-note">{note}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Ash />);
