import { useState } from "react";
import type { GateAction, Task } from "@harness/shared";
import { Robot, X } from "@phosphor-icons/react";
import type { DebateGate } from "./debateState";
import { isTeamCommand } from "./debateHandoff";
import { LinkedTeamCard, TeamHandoffButton } from "./DebateTeamHandoff";
import { Kbd, submitShortcutTitle, TopResizableTextarea } from "./ui";

export function DebateGateBar({
  gate,
  onGate,
  onTeam,
  onOpenTeam,
  teamBusy,
  linkedTeam,
  allTasks,
  onOpenTask,
  onDebateAgain,
  debateAgainBusy,
}: {
  gate: DebateGate;
  onGate: (action: GateAction) => void | Promise<unknown>;
  onTeam: (command: string) => Promise<boolean>;
  onOpenTeam: () => void;
  teamBusy: boolean;
  linkedTeam?: Task;
  allTasks: Task[];
  onOpenTask: (taskId: string) => void;
  onDebateAgain: (team: Task) => void;
  debateAgainBusy: boolean;
}) {
  const [mode, setMode] = useState<"inject" | "ask" | null>(null);
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"A" | "B" | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const isG1 = gate.gate === "G1";
  const consensus = !!gate.consensus;
  const consensusBy = gate.consensusBy ?? (consensus ? "both" : undefined);
  // 结论已经交给一支团队按它开干了。这时「打回终止 / 注入意见→回炉 / 提问→继续」都会
  // 让辩论和正在执行的团队各说一套（团队拿走的是交接那一刻的结论快照），所以只留把辩论
  // 本身收尾这一个动作，并把「只剩收尾」写进常驻文案而不是 hover 才看见的气泡。正常路径
  // 下 handoffToTeam 已经自动放行、这个分支根本不会出现；它兜的是自动放行失败、以及此
  // 改动之前留下的历史任务。
  const handedOff = isG1 && !!linkedTeam;
  const label = !isG1
    ? "历史代码门 · 等待你裁决"
    : handedOff
      ? "收敛门 · 结论已交给团队，辩论只剩收尾"
      : consensus
        ? `收敛门 · ${consensusBy === "both" ? "双方已达成共识" : "单方声明一致，待你确认"}`
        : "收敛门 · 双方仍有分歧（结论如下，供你定夺）";
  const nameA = "辩手A";
  const nameB = "辩手B";

  const canMention = isG1 && mode === "ask";
  const mentionCandidates = [{ key: "A" as const, name: nameA }, { key: "B" as const, name: nameB }];
  const mentionMatch = canMention ? /@([^\s@]*)$/.exec(text) : null;
  const candidates = mentionMatch
    ? mentionCandidates.filter((candidate) => {
        const query = (mentionMatch[1] ?? "").toLowerCase();
        return !query || candidate.name.includes(mentionMatch[1]) || candidate.key.toLowerCase().startsWith(query);
      })
    : [];
  const mentionOpen = !!mentionMatch && candidates.length > 0;
  const pick = (speaker: "A" | "B") => {
    setTarget(speaker);
    setText((current) => current.replace(/@[^\s@]*$/, ""));
    setMentionIndex(0);
  };
  const switchMode = (next: "inject" | "ask") => {
    setMode((current) => (current === next ? null : next));
    setTarget(null);
  };
  const submit = async () => {
    if (!text.trim() || !mode) return;
    if (isTeamCommand(text)) {
      if (await onTeam(text)) setText("");
      return;
    }
    if (mode === "ask") onGate({ kind: "ask", text: text.trim(), target: target ?? undefined });
    else onGate({ kind: "inject", text: text.trim() });
    setText("");
    setMode(null);
    setTarget(null);
  };

  return (
    <div className="border-t border-violet-500/40 bg-violet-500/[0.07] px-6 py-3">
      {isG1 && (
        <div className="mb-2 flex flex-col gap-0.5 text-xs">
          <div className={consensus ? "text-emerald-700" : "text-amber-700"}>
            {consensus
              ? consensusBy === "both"
                ? "✓ 双方均表示可收敛、自评结论一致（结论如下，若实际不符可打回或回炉）"
                : `✓ 辩手${consensusBy}表示可收敛且自评与对方一致（对方未再表态；结论如下，可打回或回炉）`
              : "⚠ 双方未达成一致，以下是两方各自结论："}
          </div>
          {gate.conclusionA || gate.conclusionB ? (
            <>
              {gate.conclusionA && <div className="text-ink"><b className="text-sky-700">{nameA}</b> · {gate.conclusionA}</div>}
              {gate.conclusionB && <div className="text-ink"><b className="text-emerald-700">{nameB}</b> · {gate.conclusionB}</div>}
            </>
          ) : (
            <div className="text-faint">（双方未给出明确「结论」行）</div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-violet-700">{label}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {isG1 && (
            linkedTeam ? (
              <LinkedTeamCard
                team={linkedTeam}
                allTasks={allTasks}
                onOpen={onOpenTask}
                compact
                onDebateAgain={onDebateAgain}
                debateAgainBusy={debateAgainBusy}
              />
            ) : (
              <TeamHandoffButton busy={teamBusy} onClick={onOpenTeam} />
            )
          )}
          {handedOff ? (
            <button onClick={() => onGate({ kind: "approve" })} className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-white">
              结束辩论
            </button>
          ) : (
            <>
              <button onClick={() => onGate({ kind: "approve" })} className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-white">
                {isG1 ? "放行→结束" : "放行"}
              </button>
              <button onClick={() => onGate({ kind: "reject" })} className="rounded-md border border-line2 px-3 py-1 text-xs text-ink">
                打回终止
              </button>
              <button onClick={() => switchMode("inject")} className="rounded-md border border-line2 px-3 py-1 text-xs text-ink">
                注入意见→回炉
              </button>
              <button onClick={() => switchMode("ask")} className="rounded-md border border-line2 px-3 py-1 text-xs text-ink">
                提问→继续
              </button>
            </>
          )}
        </div>
      </div>
      {mode && !handedOff && (
        <div className="relative mt-2">
          {mentionOpen && (
            <div className="absolute bottom-full left-0 z-10 mb-1 w-56 overflow-hidden rounded-lg border border-line2 bg-panel p-1 shadow-xl">
              <div className="px-2 py-1 text-[10px] text-faint">把问题定向给 · ↑↓ 选，回车确定</div>
              {candidates.map((candidate, index) => (
                <button
                  key={candidate.key}
                  onMouseEnter={() => setMentionIndex(index)}
                  onClick={() => pick(candidate.key)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink ${index === mentionIndex ? "bg-raised" : ""}`}
                >
                  <Robot size={14} className="text-muted" /> @{candidate.name}
                </button>
              ))}
            </div>
          )}
          {target && (
            <div className="mb-1.5 flex items-center text-[12px]">
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-ink">
                <Robot size={12} /> 只问 @{target === "A" ? nameA : nameB}
                <button onClick={() => setTarget(null)} className="text-faint hover:text-ink" title="改为问双方">
                  <X size={11} weight="bold" />
                </button>
              </span>
            </div>
          )}
          <div className="relative">
            <TopResizableTextarea
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (mentionOpen) {
                  if (event.key === "ArrowDown") { event.preventDefault(); setMentionIndex((index) => Math.min(candidates.length - 1, index + 1)); return; }
                  if (event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((index) => Math.max(0, index - 1)); return; }
                  if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    pick((candidates[mentionIndex] ?? candidates[0]).key);
                    return;
                  }
                }
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(); }
              }}
              placeholder={
                mode === "inject"
                  ? "补充意见，双方据此回炉再辩…"
                  : canMention
                    ? "向某位辩手提问，@ 指向单个（不填=问双方）…"
                    : "补充问题；提交后回到辩论继续…"
              }
              initialHeight={64}
              minHeight={56}
              maxHeight={300}
              className="rounded-lg border border-line bg-panel py-2 pl-2.5 pr-24 text-sm leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
            />
            <button
              disabled={!text.trim() || teamBusy}
              onClick={() => void submit()}
              title={submitShortcutTitle("提交并继续")}
              className="absolute bottom-2 right-2 inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-semibold text-accent-fg shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-40"
            >
              提交 <Kbd />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
