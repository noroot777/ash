import { useEffect, useRef, useState } from "react";
import type { Task, AgentType, DebateConfig } from "@harness/shared";
import { api } from "./api";
import { loadDefaults, saveDefault } from "./debateDefaults";

const AGENTS: AgentType[] = ["claude", "codex", "antigravity"];

// Composer input. Plain text + Enter → single task. Typing `/debate ` morphs the
// input into the Tab-cyclable slot bar (DESIGN.md §7).
export function Composer({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: (t: Task, run: boolean) => void;
}) {
  const [text, setText] = useState("");
  const isDebate = text.trimStart().toLowerCase().startsWith("/debate");

  if (isDebate) {
    const seedTopic = text.replace(/^\s*\/debate\s?/i, "");
    return <DebateSlots projectId={projectId} seedTopic={seedTopic} onCancel={() => setText("")} onCreated={onCreated} />;
  }

  return (
    <div className="mx-4 mb-1">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key === "Enter" && text.trim()) {
            const t = await api.createTask({ projectId, title: text.trim(), mode: "single", agentType: "claude" });
            onCreated(t, false);
            setText("");
          }
        }}
        placeholder="新建任务，或输入 /debate 发起对抗…"
        className="w-full rounded-md border border-line bg-raised/50 px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-line2"
      />
      {text === "/" && (
        <div className="mt-1 rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-muted">
          <span className="text-ink">/debate</span> 发起两 AI 对抗
        </div>
      )}
    </div>
  );
}

type SlotKey = "topic" | "debaterA" | "debaterB" | "implementer" | "maxRounds" | "gateG1" | "gateG2";
const SLOT_ORDER: SlotKey[] = ["topic", "debaterA", "debaterB", "implementer", "maxRounds", "gateG1", "gateG2"];
const SLOT_LABEL: Record<SlotKey, string> = {
  topic: "议题",
  debaterA: "辩手A",
  debaterB: "辩手B",
  implementer: "实现方",
  maxRounds: "轮数",
  gateG1: "共识门G1",
  gateG2: "代码门G2",
};

function DebateSlots({
  projectId,
  seedTopic,
  onCancel,
  onCreated,
}: {
  projectId: string;
  seedTopic: string;
  onCancel: () => void;
  onCreated: (t: Task, run: boolean) => void;
}) {
  const [cfg, setCfg] = useState<DebateConfig>(() => ({ ...loadDefaults(), topic: seedTopic }));
  const [focus, setFocus] = useState(0);
  const topicRef = useRef<HTMLInputElement>(null);
  const roundsRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (SLOT_ORDER[focus] === "topic") topicRef.current?.focus();
    else if (SLOT_ORDER[focus] === "maxRounds") roundsRef.current?.focus();
    else topicRef.current?.blur();
  }, [focus]);

  const options = (k: SlotKey): string[] | null => {
    if (k === "debaterA" || k === "debaterB" || k === "implementer")
      return k === "implementer" ? ["A", "B"] : AGENTS;
    if (k === "gateG1" || k === "gateG2") return ["on", "off"];
    return null;
  };

  const valueText = (k: SlotKey): string => {
    if (k === "topic") return cfg.topic || "（必填）";
    if (k === "maxRounds") return cfg.maxRounds === null ? "不设限" : String(cfg.maxRounds);
    if (k === "implementer") return cfg.implementer === "A" ? "辩手A" : "辩手B";
    if (k === "gateG1" || k === "gateG2") return cfg[k] === "on" ? "开" : "关";
    return String(cfg[k]);
  };

  const cycle = (k: SlotKey, dir: 1 | -1) => {
    const opts = options(k);
    if (!opts) return;
    const cur = String(cfg[k as keyof DebateConfig]);
    const i = (opts.indexOf(cur) + dir + opts.length) % opts.length;
    setCfg((c) => ({ ...c, [k]: opts[i] }));
  };

  const launch = async () => {
    if (!cfg.topic.trim()) {
      setFocus(0);
      return;
    }
    const t = await api.createTask({
      projectId,
      title: cfg.topic.trim().slice(0, 80),
      mode: "debate",
      debate: { ...cfg, topic: cfg.topic.trim() },
    });
    onCreated(t, true);
    onCancel();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      setFocus((f) => (f + (e.shiftKey ? -1 : 1) + SLOT_ORDER.length) % SLOT_ORDER.length);
    } else if (e.key === "Escape") {
      onCancel();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      launch();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      if (options(SLOT_ORDER[focus])) {
        e.preventDefault();
        cycle(SLOT_ORDER[focus], -1);
      }
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      if (options(SLOT_ORDER[focus])) {
        e.preventDefault();
        cycle(SLOT_ORDER[focus], 1);
      }
    } else if (e.key === "Enter") {
      const k = SLOT_ORDER[focus];
      if (k === "topic" || k === "maxRounds") launch();
    }
  };

  const focusedKey = SLOT_ORDER[focus];
  const focusedOpts = options(focusedKey);

  return (
    <div
      className="mx-3 mb-1 rounded-lg border border-violet-500/40 bg-raised/60 p-2"
      onKeyDown={onKey}
      tabIndex={-1}
    >
      <div className="mb-1.5 flex items-center gap-1 px-1 text-[11px] text-violet-300/80">
        <span className="font-medium">/debate</span>
        <span className="text-faint">Tab 切槽 · ←→ 改值 · ⌘↵ 开跑 · Esc 取消</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {SLOT_ORDER.map((k, i) => {
          const active = i === focus;
          return (
            <button
              key={k}
              onClick={() => setFocus(i)}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                active ? "border-violet-400 bg-violet-500/15" : "border-line bg-panel"
              }`}
            >
              <span className="text-muted">{SLOT_LABEL[k]}</span>
              {k === "topic" ? (
                <input
                  ref={topicRef}
                  value={cfg.topic}
                  onChange={(e) => setCfg((c) => ({ ...c, topic: e.target.value }))}
                  onFocus={() => setFocus(0)}
                  placeholder="必填…"
                  className="w-40 bg-transparent text-ink outline-none placeholder:text-faint"
                />
              ) : k === "maxRounds" ? (
                <input
                  ref={roundsRef}
                  value={cfg.maxRounds === null ? "" : cfg.maxRounds}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    setCfg((c) => ({ ...c, maxRounds: v === "" ? null : Math.max(1, Number(v) || 1) }));
                  }}
                  onFocus={() => setFocus(4)}
                  placeholder="不设限"
                  className="w-12 bg-transparent text-ink outline-none placeholder:text-faint"
                />
              ) : (
                <span className="text-ink">{valueText(k)}</span>
              )}
            </button>
          );
        })}
        <button onClick={launch} className="rounded-md bg-violet-500 px-3 py-1 text-xs font-medium text-white">
          开跑
        </button>
      </div>

      {focusedOpts && (
        <div className="mt-1.5 flex items-center gap-1 px-1 text-xs">
          <span className="text-faint">{SLOT_LABEL[focusedKey]}:</span>
          {focusedOpts.map((o) => {
            const sel = String(cfg[focusedKey as keyof DebateConfig]) === o;
            return (
              <button
                key={o}
                onClick={() => setCfg((c) => ({ ...c, [focusedKey]: o }))}
                className={`rounded px-2 py-0.5 ${sel ? "bg-violet-500/30 text-violet-200" : "bg-overlay text-muted"}`}
              >
                {focusedKey === "implementer" ? (o === "A" ? "辩手A" : "辩手B") : o === "on" ? "开" : o === "off" ? "关" : o}
              </button>
            );
          })}
          <button
            onClick={() => saveDefault(focusedKey as keyof DebateConfig, cfg[focusedKey as keyof DebateConfig])}
            className="ml-2 rounded border border-line2 px-2 py-0.5 text-muted hover:text-ink"
            title="把当前值设为以后 /debate 的默认"
          >
            设为默认
          </button>
        </div>
      )}
    </div>
  );
}
