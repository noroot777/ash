import { useState } from "react";
import type { GateAction, Task } from "@harness/shared";
import { CheckCircle, Question, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import type { DebateGate } from "./debateState.ts";
import { DebateHandoffBar } from "./DebateHandoff.tsx";

export function DebateGateControls({
  gate,
  round,
  maxRounds,
  busy,
  linkedTeam,
  onGate,
  onOpenTeam,
  onOpenTask,
}: {
  gate: DebateGate;
  round: number;
  maxRounds: number | null;
  busy: boolean;
  linkedTeam?: Task;
  onGate: (action: GateAction) => Promise<void>;
  onOpenTeam: () => void;
  onOpenTask: (task: Task) => void;
}) {
  const [mode, setMode] = useState<"inject" | "ask" | null>(null);
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"A" | "B" | "both">("both");
  const submit = async () => {
    const message = text.trim();
    if (!message || !mode) return;
    await onGate(mode === "inject"
      ? { kind: "inject", text: message }
      : { kind: "ask", text: message, target: target === "both" ? undefined : target });
    setText("");
    setMode(null);
    setTarget("both");
  };
  const consensus = !!gate.consensus;
  const consensusBy = gate.consensusBy ?? (consensus ? "both" : undefined);
  return (
    <section className="debate-control-shell">
      <div className="debate-control-summary">
        <span className={consensus ? "is-consensus" : "is-split"}>{consensus ? <CheckCircle size={13} weight="fill" /> : <WarningCircle size={13} weight="fill" />}{consensus ? (consensusBy === "both" ? "双方已收敛" : `辩手 ${consensusBy} 声明一致`) : "双方仍有分歧"}</span>
        <small>第 {round}{maxRounds ? ` / ${maxRounds}` : ""} 轮 · {gate.gate} 收敛门</small>
      </div>
      {(gate.conclusionA || gate.conclusionB) && (
        <div className="debate-gate-conclusions">
          {gate.conclusionA && <p><b>A</b>{gate.conclusionA}</p>}
          {gate.conclusionB && <p><b>B</b>{gate.conclusionB}</p>}
        </div>
      )}
      <div className="debate-control-actions">
        <DebateHandoffBar linkedTeam={linkedTeam} busy={busy} onOpenTeam={onOpenTeam} onOpenTask={onOpenTask} />
        <button type="button" className="is-approve" disabled={busy} onClick={() => void onGate({ kind: "approve" })}>放行结束</button>
        <button type="button" disabled={busy} onClick={() => void onGate({ kind: "reject" })}>打回终止</button>
        <button type="button" className={mode === "inject" ? "is-active" : ""} disabled={busy} onClick={() => setMode((current) => current === "inject" ? null : "inject")}>注入意见</button>
        <button type="button" className={mode === "ask" ? "is-active" : ""} disabled={busy} onClick={() => setMode((current) => current === "ask" ? null : "ask")}><Question size={12} />提问继续</button>
      </div>
      {mode && (
        <div className="debate-gate-composer">
          {mode === "ask" && <div className="debate-targets"><span>提问对象</span>{(["both", "A", "B"] as const).map((value) => <button type="button" className={target === value ? "is-selected" : ""} key={value} onClick={() => setTarget(value)}>{value === "both" ? "双方" : `辩手 ${value}`}</button>)}</div>}
          <textarea autoFocus rows={3} value={text} placeholder={mode === "inject" ? "补充意见，双方据此回炉再辩…" : "写下要澄清的问题…"} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }} />
          <button type="button" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? <SpinnerGap size={13} className="is-spinning" /> : null}提交并继续</button>
        </div>
      )}
    </section>
  );
}

export function DebateProgressBar({ round, maxRounds, gateEnabled }: { round: number; maxRounds: number | null; gateEnabled: boolean }) {
  return (
    <div className="debate-progress-bar">
      <span>第 {round || 1}{maxRounds ? ` / ${maxRounds}` : ""} 轮</span>
      <i />
      <small>{gateEnabled ? "结束前进入 G1 收敛门" : "达到共识或轮次上限后自动结束"}</small>
    </div>
  );
}
