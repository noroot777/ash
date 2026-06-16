import { useState } from "react";
import type { Task, AgentType, DebateConfig } from "@harness/shared";
import { Robot, Hammer, ArrowsClockwise, ShieldCheck } from "@phosphor-icons/react";
import { api } from "./api";
import { loadDefaults, saveDefault } from "./debateDefaults";
import { Modal } from "./Modal";
import { Pill } from "./Menu";

const AGENTS: AgentType[] = ["claude", "codex", "antigravity"];
const agentOpts = AGENTS.map((a) => ({ value: a, label: a }));

// /debate config, built from the same Pill + Menu components as the create modal
// for one consistent visual language (DESIGN.md §7).
export function DebateModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (t: Task, run: boolean) => void;
}) {
  const [cfg, setCfg] = useState<DebateConfig>(() => ({ ...loadDefaults(), topic: "" }));
  const [defaults, setDefaults] = useState(loadDefaults);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof DebateConfig>(k: K, v: DebateConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  // Per-slot "set as default" (pin inside each dropdown).
  const pinDefault = (k: keyof DebateConfig, raw: string) => {
    const v = (k === "maxRounds" ? (raw === "" ? null : Number(raw)) : raw) as never;
    saveDefault(k, v);
    setDefaults((d) => ({ ...d, [k]: v }));
  };
  const defStr = (k: keyof DebateConfig) => {
    const v = defaults[k];
    return k === "maxRounds" ? (v === null ? "" : String(v)) : String(v ?? "");
  };

  const launch = async () => {
    if (!cfg.topic.trim() || busy) return;
    setBusy(true);
    try {
      const t = await api.createTask({
        projectId,
        title: cfg.topic.trim().slice(0, 80),
        mode: "debate",
        debate: { ...cfg, topic: cfg.topic.trim() },
      });
      onCreated(t, true);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="发起对抗 · /debate"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button onClick={onClose} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
          <button
            disabled={!cfg.topic.trim() || busy}
            onClick={launch}
            className="rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
          >
            开跑
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && launch()}>
        <input
          autoFocus
          value={cfg.topic}
          onChange={(e) => set("topic", e.target.value)}
          placeholder="议题（必填）：让两个 AI 就什么展开对抗…"
          className="w-full rounded-md border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none placeholder:text-faint focus:border-accent"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill icon={<Robot size={14} />} label={`辩手A ${cfg.debaterA}`} value={cfg.debaterA} onChange={(v) => set("debaterA", v as AgentType)} options={agentOpts} defaultValue={defStr("debaterA")} onSetDefault={(v) => pinDefault("debaterA", v)} />
          <Pill icon={<Robot size={14} />} label={`辩手B ${cfg.debaterB}`} value={cfg.debaterB} onChange={(v) => set("debaterB", v as AgentType)} options={agentOpts} defaultValue={defStr("debaterB")} onSetDefault={(v) => pinDefault("debaterB", v)} />
          <Pill
            icon={<Hammer size={14} />}
            label={`实现方 ${cfg.implementer === "A" ? "辩手A" : "辩手B"}`}
            value={cfg.implementer}
            onChange={(v) => set("implementer", v as "A" | "B")}
            options={[
              { value: "A", label: "辩手A" },
              { value: "B", label: "辩手B" },
            ]}
            defaultValue={defStr("implementer")}
            onSetDefault={(v) => pinDefault("implementer", v)}
          />
          <Pill
            icon={<ArrowsClockwise size={14} />}
            label={`轮数 ${cfg.maxRounds ?? "不设限"}`}
            value={cfg.maxRounds === null ? "" : String(cfg.maxRounds)}
            onChange={(v) => set("maxRounds", v === "" ? null : Number(v))}
            menuWidth={200}
            options={[
              { value: "", label: "不设限" },
              { value: "3", label: "3 轮" },
              { value: "5", label: "5 轮" },
              { value: "10", label: "10 轮" },
            ]}
            defaultValue={defStr("maxRounds")}
            onSetDefault={(v) => pinDefault("maxRounds", v)}
            header={({ select }) => (
              <input
                type="number"
                min={1}
                placeholder="自定义轮数，回车确认"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const n = Math.floor(Number((e.target as HTMLInputElement).value));
                    if (n >= 1) select(String(n));
                  }
                }}
                className="w-full rounded-md border border-line bg-canvas px-2 py-1 text-[12px] text-ink outline-none placeholder:text-faint focus:border-accent"
              />
            )}
          />
          <Pill
            icon={<ShieldCheck size={14} />}
            label={`共识门 ${cfg.gateG1 === "on" ? "开" : "关"}`}
            value={cfg.gateG1}
            onChange={(v) => set("gateG1", v as "on" | "off")}
            options={[
              { value: "on", label: "开" },
              { value: "off", label: "关" },
            ]}
            defaultValue={defStr("gateG1")}
            onSetDefault={(v) => pinDefault("gateG1", v)}
          />
          <Pill
            icon={<ShieldCheck size={14} />}
            label={`代码门 ${cfg.gateG2 === "on" ? "开" : "关"}`}
            value={cfg.gateG2}
            onChange={(v) => set("gateG2", v as "on" | "off")}
            options={[
              { value: "on", label: "开" },
              { value: "off", label: "关" },
            ]}
            defaultValue={defStr("gateG2")}
            onSetDefault={(v) => pinDefault("gateG2", v)}
          />
        </div>
        <p className="text-[11px] text-faint">
          Tab 切到某项会自动展开;方向键选、回车定、⌘↵ 开跑。每项下拉里点图钉=设为默认。门全关=全自动到提交。
        </p>
      </div>
    </Modal>
  );
}
