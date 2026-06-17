import { useState } from "react";
import type { Task, AgentType, DebateConfig, DebateStyle, ProjectView } from "@harness/shared";
import { Robot, Hammer, ArrowsClockwise, ShieldCheck, Scales, Handshake } from "@phosphor-icons/react";
import { api } from "./api";
import { loadDefaults, saveDefault } from "./debateDefaults";
import { Modal } from "./Modal";
import { Pill } from "./Menu";
import { RunLocation } from "./ui";

const AGENTS: AgentType[] = ["claude", "codex", "antigravity"];
const agentOpts = AGENTS.map((a) => ({ value: a, label: a }));

// Two-AI task composer (entered from the /pair slash picker, which has already
// chosen the style). 辩论给你答案 · 协作给你代码 — the style drives which pills
// show: 辩论 hides 实现方/审查方/代码门 (no code), 协作 shows them.
export function DebateModal({
  project,
  initialStyle,
  onClose,
  onCreated,
}: {
  project: ProjectView;
  initialStyle: DebateStyle;
  onClose: () => void;
  onCreated: (t: Task, run: boolean) => void;
}) {
  const projectId = project.id;
  const [cfg, setCfg] = useState<DebateConfig>(() => ({ ...loadDefaults(), topic: "", style: initialStyle }));
  const [defaults, setDefaults] = useState(loadDefaults);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof DebateConfig>(k: K, v: DebateConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const collab = cfg.style === "collaborate";
  const who = (s: "A" | "B") => (collab ? `成员${s}` : `辩手${s}`); // 称谓随风格变
  const other = cfg.implementer === "A" ? "B" : "A";
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
    const topic = cfg.topic.trim();
    if (!topic || busy) return;
    setBusy(true);
    try {
      const t = await api.createTask({
        projectId,
        // Provisional title from the first line; the debate auto-generates a
        // short title on first run (autoTitle), same as a normal task. The full
        // topic lives in cfg.topic and shows in the task's body box.
        title: topic.split("\n")[0].slice(0, 30) || (collab ? "新建协作" : "新建辩论"),
        mode: "debate",
        autoTitle: true,
        debate: { ...cfg, topic },
      });
      onCreated(t, true);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={collab ? "新建协作 · /pair" : "新建辩论 · /pair"}
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
        {/* 当前模式（在 /pair 选择器里已选定，这里只读展示） */}
        <div className="flex items-center gap-2 text-[12px]">
          {collab ? <Handshake size={16} className="text-teal-600" weight="fill" /> : <Scales size={16} className="text-violet-600" weight="fill" />}
          <span className="font-medium text-ink">{collab ? "协作" : "辩论"}</span>
          <span className="text-faint">· {collab ? "一方实现、一方审查，给你代码" : "两个 AI 对抗，给你答案"}</span>
        </div>

        <textarea
          autoFocus
          value={cfg.topic}
          onChange={(e) => set("topic", e.target.value)}
          rows={4}
          placeholder={collab ? "任务（必填）：让两个 AI 一起完成什么…（⌘↵ 开跑）" : "议题（必填）：让两个 AI 就什么展开对抗…（⌘↵ 开跑）"}
          className="w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
        />
        {/* Run location — discussion reads here; implement writes here (temp dir if missing) */}
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-muted">{project.name}</span>
          <RunLocation project={project} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill icon={<Robot size={14} />} label={`${who("A")} ${cfg.debaterA}`} value={cfg.debaterA} onChange={(v) => set("debaterA", v as AgentType)} options={agentOpts} defaultValue={defStr("debaterA")} onSetDefault={(v) => pinDefault("debaterA", v)} />
          <Pill icon={<Robot size={14} />} label={`${who("B")} ${cfg.debaterB}`} value={cfg.debaterB} onChange={(v) => set("debaterB", v as AgentType)} options={agentOpts} defaultValue={defStr("debaterB")} onSetDefault={(v) => pinDefault("debaterB", v)} />
          {/* 实现方 / 审查方 / 代码门 —— 只有「协作（出代码）」才出现 */}
          {collab && (
            <>
              <Pill
                icon={<Hammer size={14} />}
                label={`实现方 ${who(cfg.implementer)}`}
                value={cfg.implementer}
                onChange={(v) => set("implementer", v as "A" | "B")}
                options={[
                  { value: "A", label: who("A") },
                  { value: "B", label: who("B") },
                ]}
                defaultValue={defStr("implementer")}
                onSetDefault={(v) => pinDefault("implementer", v)}
              />
              <span
                title="审查方自动取另一位成员（实现方写、它来 review）"
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-line bg-panel/40 px-2.5 py-1 text-[12px] text-muted"
              >
                <ShieldCheck size={14} /> 审查方 {who(other)}（自动）
              </span>
            </>
          )}
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
            label={`${collab ? "方案门" : "收敛门"} ${cfg.gateG1 === "on" ? "开" : "关"}`}
            value={cfg.gateG1}
            onChange={(v) => set("gateG1", v as "on" | "off")}
            options={[
              { value: "on", label: "开" },
              { value: "off", label: "关" },
            ]}
            defaultValue={defStr("gateG1")}
            onSetDefault={(v) => pinDefault("gateG1", v)}
          />
          {collab && (
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
          )}
        </div>
        <p className="text-[11px] text-faint">
          {collab
            ? "协作：各自提案 → 查缺补漏合并 → 实现方落地、审查方 review。门全关=全自动到提交。"
            : "辩论：盲态开局 → 多轮对抗 → 给出结论（不改代码）。收敛门开=收敛后停下让你定夺。"}
        </p>
      </div>
    </Modal>
  );
}
