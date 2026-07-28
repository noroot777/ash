import { useState } from "react";
import type { AgentExecutorProfile, DebateConfig, LlmProvider } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { ArrowsClockwise, Robot, ShieldCheck } from "@phosphor-icons/react";
import { loadDefaults, saveDefault, saveDefaults } from "./debateDefaults";
import { ExecutorPicker, type ExecutorSelection } from "./ExecutorPicker";
import { Pill } from "./Menu";

export function createDebateConfig(): DebateConfig {
  return { ...loadDefaults(), topic: "", style: "debate" };
}

// The debate-specific fields live inside TaskComposer. Keeping them controlled lets
// the parent own the common title, mode switch, submission, and keyboard shortcut.
export function DebateComposerFields({
  value,
  onChange,
  profiles,
  providers,
  onOpenAgents,
}: {
  value: DebateConfig;
  onChange: (value: DebateConfig) => void;
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  onOpenAgents?: () => void;
}) {
  const [defaults, setDefaults] = useState(loadDefaults);
  const set = <K extends keyof DebateConfig>(key: K, next: DebateConfig[K]) => {
    onChange({ ...value, [key]: next });
  };
  const who = (speaker: "A" | "B") => `辩手${speaker}`;

  const pinDefault = (key: keyof DebateConfig, raw: string) => {
    const next = (key === "maxRounds" ? (raw === "" ? null : Number(raw)) : raw) as never;
    saveDefault(key, next);
    setDefaults((current) => ({ ...current, [key]: next }));
  };
  const defaultString = (key: keyof DebateConfig) => {
    const current = defaults[key];
    return key === "maxRounds" ? (current === null ? "" : String(current)) : String(current ?? "");
  };
  const selectionFor = (speaker: "A" | "B", source: DebateConfig): ExecutorSelection => speaker === "A"
    ? { agentType: source.debaterA, executorId: source.debaterAExecutorId ?? null }
    : { agentType: source.debaterB, executorId: source.debaterBExecutorId ?? null };
  const setDebater = (speaker: "A" | "B", selection: ExecutorSelection) => {
    onChange(speaker === "A"
      ? { ...value, debaterA: selection.agentType, debaterAExecutorId: selection.executorId }
      : { ...value, debaterB: selection.agentType, debaterBExecutorId: selection.executorId });
  };
  const pinDebaterDefault = (speaker: "A" | "B", selection: ExecutorSelection) => {
    const patch = speaker === "A"
      ? { debaterA: selection.agentType, debaterAExecutorId: selection.executorId }
      : { debaterB: selection.agentType, debaterBExecutorId: selection.executorId };
    saveDefaults(patch);
    setDefaults((current) => ({ ...current, ...patch }));
  };
  const debaterLabel = (speaker: "A" | "B") => {
    const selection = selectionFor(speaker, value);
    const profile = selection.executorId ? profiles.find((item) => item.id === selection.executorId) : null;
    return `${who(speaker)} ${profile?.name ?? `默认 ${selection.agentType}`}`;
  };

  return (
    <div className="flex flex-col gap-3">
      <textarea
        autoFocus
        value={value.topic}
        onChange={(event) => set("topic", event.target.value)}
        rows={5}
        placeholder="议题（必填）：让两个 AI 就什么展开对抗…"
        className="w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <ExecutorPicker
          icon={<Robot size={14} />}
          selection={selectionFor("A", value)}
          onSelect={(selection) => setDebater("A", selection)}
          profiles={profiles}
          providers={providers}
          types={[...AGENT_TYPES]}
          includeTypeDefaults
          includeManage={!!onOpenAgents}
          onOpenAgents={onOpenAgents}
          label={debaterLabel("A")}
          onSetDefault={(selection) => pinDebaterDefault("A", selection)}
          defaultSelection={selectionFor("A", defaults)}
          menuWidth={320}
        />
        <ExecutorPicker
          icon={<Robot size={14} />}
          selection={selectionFor("B", value)}
          onSelect={(selection) => setDebater("B", selection)}
          profiles={profiles}
          providers={providers}
          types={[...AGENT_TYPES]}
          includeTypeDefaults
          includeManage={!!onOpenAgents}
          onOpenAgents={onOpenAgents}
          label={debaterLabel("B")}
          onSetDefault={(selection) => pinDebaterDefault("B", selection)}
          defaultSelection={selectionFor("B", defaults)}
          menuWidth={320}
        />
        <Pill
          icon={<ArrowsClockwise size={14} />}
          label={`轮数 ${value.maxRounds ?? "不设限"}`}
          value={value.maxRounds === null ? "" : String(value.maxRounds)}
          onChange={(next) => set("maxRounds", next === "" ? null : Number(next))}
          menuWidth={200}
          options={[
            { value: "", label: "不设限" },
            { value: "3", label: "3 轮" },
            { value: "5", label: "5 轮" },
            { value: "10", label: "10 轮" },
          ]}
          defaultValue={defaultString("maxRounds")}
          onSetDefault={(next) => pinDefault("maxRounds", next)}
          header={({ select }) => (
            <input
              type="number"
              min={1}
              placeholder="自定义轮数，回车确认"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  const rounds = Math.floor(Number((event.target as HTMLInputElement).value));
                  if (rounds >= 1) select(String(rounds));
                }
              }}
              className="w-full rounded-md border border-line bg-canvas px-2 py-1 text-[12px] text-ink outline-none placeholder:text-faint focus:border-accent"
            />
          )}
        />
        <Pill
          icon={<ShieldCheck size={14} />}
          label={`收敛门 ${value.gateG1 === "on" ? "开" : "关"}`}
          value={value.gateG1}
          onChange={(next) => set("gateG1", next as "on" | "off")}
          options={[
            { value: "on", label: "开" },
            { value: "off", label: "关" },
          ]}
          defaultValue={defaultString("gateG1")}
          onSetDefault={(next) => pinDefault("gateG1", next)}
        />
      </div>
      <p className="text-[11px] text-faint">
        盲态开局 → 多轮对抗 → 给出结论（不改代码）。收敛门开=收敛后停下让你定夺。
      </p>
    </div>
  );
}
