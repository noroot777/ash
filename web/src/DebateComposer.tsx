import { useEffect, useState } from "react";
import type { AgentExecutorProfile, DebateConfig, LlmProvider } from "@harness/shared";
import { ArrowsClockwise, Robot, ShieldCheck } from "@phosphor-icons/react";
import { loadDefaults, saveDefault, saveDefaults } from "./debateDefaults";
import { ExecutorPicker, type ExecutorSelection } from "./ExecutorPicker";
import { Pill } from "./Menu";
import { fallbackExecutor, isExecutorPickable, useAvailableTypes } from "./useDetectedAgents";

export function createDebateConfig(): DebateConfig {
  return { ...loadDefaults(), topic: "", style: "debate" };
}

// The debate-specific fields live inside TaskComposer. Keeping them controlled lets
// the parent own the common title, mode switch, submission, and keyboard shortcut.
// `fill` 让整块跟着外层高度伸缩、议题框吃掉全部剩余空间（内嵌新建面板用）；派生
// 弹层那种「一小块表单」的调用点保持原来的固定 5 行 + 可手动拉伸。
export function DebateComposerFields({
  value,
  onChange,
  profiles,
  providers,
  onOpenAgents,
  fill = false,
  correctUnavailable = false,
}: {
  value: DebateConfig;
  onChange: (value: DebateConfig) => void;
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  onOpenAgents?: () => void;
  fill?: boolean;
  /**
   * true = 这是一份**新建**的配置（种子来自 `createDebateConfig()`：localStorage 里 pin 过的
   * 默认，或工厂默认 claude vs codex）。检测结果回来后，把本机跑不起来的默认辩手顺移到能跑
   * 的那个。**编辑既有配置的调用点不要开**：那份配置是既成事实（可能是别的机器上建的辩论），
   * 悄悄改写用户存量数据比留着一个显式标注「本机未检测到」的值更糟。
   */
  correctUnavailable?: boolean;
}) {
  const [defaults, setDefaults] = useState(loadDefaults);
  // 辩手候选同其它「选谁干活」的表面：只列本机探到的 available + 已注册 profile。
  const { detected, types: debaterTypes } = useAvailableTypes();
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

  // 检测结果回来后校正新建默认:辩手默认是 claude vs codex(或用户 pin 的那对),这台机器上
  // 装的未必是它们 —— 不校正的话辩论能带着一个「本机未检测到」的类型默认项直接开跑
  // (2026-07-30 第二轮审查抓到)。指名 profile 的选择不动(ssh 远端探不到也照样能跑),
  // 只顺移「按类型默认」那种不成立的;B 尽量避开 A 的类型,保住「两个视角」的本意。
  // 两个辩手要在同一个 onChange 里一起修:分两次调会用同一份闭包 value,后一次盖掉前一次。
  useEffect(() => {
    if (!correctUnavailable || detected === null) return;
    const patch: Partial<DebateConfig> = {};
    const fixA = isExecutorPickable(selectionFor("A", value), debaterTypes, profiles)
      ? null
      : fallbackExecutor(debaterTypes, profiles, value.debaterB);
    if (fixA) {
      patch.debaterA = fixA.agentType;
      patch.debaterAExecutorId = fixA.executorId;
    }
    const avoidForB = patch.debaterA ?? value.debaterA;
    const fixB = isExecutorPickable(selectionFor("B", value), debaterTypes, profiles)
      ? null
      : fallbackExecutor(debaterTypes, profiles, avoidForB);
    if (fixB) {
      patch.debaterB = fixB.agentType;
      patch.debaterBExecutorId = fixB.executorId;
    }
    if (Object.keys(patch).length > 0) onChange({ ...value, ...patch });
  }, [correctUnavailable, detected, debaterTypes, profiles, value, onChange]);

  return (
    <div className={`flex flex-col gap-3 ${fill ? "h-full min-h-0" : ""}`}>
      <textarea
        autoFocus
        value={value.topic}
        onChange={(event) => set("topic", event.target.value)}
        rows={fill ? undefined : 5}
        placeholder="议题（必填）：让两个 AI 就什么展开对抗…"
        className={`w-full rounded-md border border-line bg-canvas px-3 py-2 text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent ${
          // 撑满模式下和普通/团队模式的正文框同一套尺寸策略：吃掉剩余空间、不手动拉伸，
          // 但保留同样的 180px 下限，免得三个 tab 来回切时输入区高度忽大忽小。
          fill ? "min-h-[180px] flex-1 resize-none" : "resize-y"
        }`}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <ExecutorPicker
          icon={<Robot size={14} />}
          selection={selectionFor("A", value)}
          onSelect={(selection) => setDebater("A", selection)}
          profiles={profiles}
          providers={providers}
          types={debaterTypes}
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
          types={debaterTypes}
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
