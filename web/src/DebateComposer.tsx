import { useState } from "react";
import type { Task, DebateConfig, ProjectView } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { Robot, ArrowsClockwise, ShieldCheck, Scales } from "@phosphor-icons/react";
import { api } from "./api";
import { loadDefaults, saveDefault, saveDefaults } from "./debateDefaults";
import { ExecutorPicker, type ExecutorSelection, useExecutorProfiles } from "./ExecutorPicker";
import { Modal } from "./Modal";
import { Pill } from "./Menu";
import { RunLocation } from "./ui";

// /pair is a two-AI debate that produces a conclusion without modifying code.
export function DebateModal({
  project,
  onClose,
  onCreated,
}: {
  project: ProjectView;
  onClose: () => void;
  onCreated: (t: Task, run: boolean) => void;
}) {
  const projectId = project.id;
  const [cfg, setCfg] = useState<DebateConfig>(() => ({ ...loadDefaults(), topic: "", style: "debate" }));
  const [defaults, setDefaults] = useState(loadDefaults);
  const [busy, setBusy] = useState(false);
  const { profiles, providers } = useExecutorProfiles();
  const set = <K extends keyof DebateConfig>(k: K, v: DebateConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const who = (s: "A" | "B") => `辩手${s}`;

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
  const setDebater = (speaker: "A" | "B", selection: ExecutorSelection) => {
    setCfg((current) => speaker === "A"
      ? { ...current, debaterA: selection.agentType, debaterAExecutorId: selection.executorId }
      : { ...current, debaterB: selection.agentType, debaterBExecutorId: selection.executorId });
  };
  const pinDebaterDefault = (speaker: "A" | "B", selection: ExecutorSelection) => {
    const patch = speaker === "A"
      ? { debaterA: selection.agentType, debaterAExecutorId: selection.executorId }
      : { debaterB: selection.agentType, debaterBExecutorId: selection.executorId };
    saveDefaults(patch);
    setDefaults((current) => ({ ...current, ...patch }));
  };
  const selectionFor = (speaker: "A" | "B", source: DebateConfig): ExecutorSelection => speaker === "A"
    ? { agentType: source.debaterA, executorId: source.debaterAExecutorId ?? null }
    : { agentType: source.debaterB, executorId: source.debaterBExecutorId ?? null };
  const debaterLabel = (speaker: "A" | "B") => {
    const selection = selectionFor(speaker, cfg);
    const profile = selection.executorId ? profiles.find((item) => item.id === selection.executorId) : null;
    return `${who(speaker)} ${profile?.name ?? `默认 ${selection.agentType}`}`;
  };

  const launch = async () => {
    const topic = cfg.topic.trim();
    if (!topic || busy) return;
    setBusy(true);
    try {
      const t = await api.createTask({
        projectId,
        // Provisional title from the first line; the debate auto-generates a
        // short title on first run. The full topic remains in cfg.topic.
        title: topic.split("\n")[0].slice(0, 30) || "新建辩论",
        mode: "debate",
        autoTitle: true,
        debate: { ...cfg, topic, style: "debate" },
      });
      onCreated(t, true);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="新建辩论 · /pair"
      onClose={onClose}
      width={640}
      footer={(close) => (
        <>
          <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
          <button
            disabled={!cfg.topic.trim() || busy}
            onClick={launch}
            className="rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
          >
            开跑
          </button>
        </>
      )}
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && launch()}>
        <div className="flex items-center gap-2 text-[12px]">
          <Scales size={16} className="text-violet-600" weight="fill" />
          <span className="font-medium text-ink">辩论</span>
          <span className="text-faint">· 两个 AI 对抗，给你答案</span>
        </div>

        <textarea
          autoFocus
          value={cfg.topic}
          onChange={(e) => set("topic", e.target.value)}
          rows={4}
          placeholder="议题（必填）：让两个 AI 就什么展开对抗…（⌘↵ 开跑）"
          className="w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
        />
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-muted">{project.name}</span>
          <RunLocation project={project} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ExecutorPicker
            icon={<Robot size={14} />}
            selection={selectionFor("A", cfg)}
            onSelect={(selection) => setDebater("A", selection)}
            profiles={profiles}
            providers={providers}
            types={[...AGENT_TYPES]}
            includeTypeDefaults
            label={debaterLabel("A")}
            onSetDefault={(selection) => pinDebaterDefault("A", selection)}
            defaultSelection={selectionFor("A", defaults)}
            menuWidth={320}
          />
          <ExecutorPicker
            icon={<Robot size={14} />}
            selection={selectionFor("B", cfg)}
            onSelect={(selection) => setDebater("B", selection)}
            profiles={profiles}
            providers={providers}
            types={[...AGENT_TYPES]}
            includeTypeDefaults
            label={debaterLabel("B")}
            onSetDefault={(selection) => pinDebaterDefault("B", selection)}
            defaultSelection={selectionFor("B", defaults)}
            menuWidth={320}
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
            label={`收敛门 ${cfg.gateG1 === "on" ? "开" : "关"}`}
            value={cfg.gateG1}
            onChange={(v) => set("gateG1", v as "on" | "off")}
            options={[
              { value: "on", label: "开" },
              { value: "off", label: "关" },
            ]}
            defaultValue={defStr("gateG1")}
            onSetDefault={(v) => pinDefault("gateG1", v)}
          />
        </div>
        <p className="text-[11px] text-faint">
          辩论：盲态开局 → 多轮对抗 → 给出结论（不改代码）。收敛门开=收敛后停下让你定夺。
        </p>
      </div>
    </Modal>
  );
}
