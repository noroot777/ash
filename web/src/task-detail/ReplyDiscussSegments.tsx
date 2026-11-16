import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentExecutorProfile, AgentType, DiscussionRounds } from "@ash/shared";
import { MAX_DISCUSSION_GUESTS, discussionRoundsLabel } from "@ash/shared/discussion";
import { CaretDown, Check } from "@phosphor-icons/react";
import { AgentIcon } from "../components/AgentIcon.tsx";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";
import type { AgentModelSelection } from "./mentionPicker.ts";
import { discussPeople, nextRounds, type ReplyCall } from "./replyCall.ts";

/**
 * 选了「讨论」时底部那颗胶囊：第一段是「和谁」（点开多选，三方就是再勾一个），最后一段是「几轮」（点一下换一档，
 * 记着上次选的）。只叫了一个人时中间照旧是他的模型和智能水平（同一颗 RunTargetPicker）；叫了两个人时中间那两段
 * 不摆——两个人各自的模型挤在一颗胶囊里读不出谁是谁，就按上次对他用的那一套（replyCall 的 rememberedTarget）。
 */
export function DiscussCapsule({ call, types, profiles, ownAgent, disabled, model, effort, onToggle, onRounds, onCommit, onEffortChange }: {
  call: ReplyCall;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  ownAgent: AgentType;
  disabled: boolean;
  model: string | null;
  effort: string;
  onToggle: (agent: AgentType) => void;
  onRounds: (rounds: DiscussionRounds) => void;
  onCommit: (next: AgentModelSelection) => void;
  onEffortChange: (effort: string) => void;
}) {
  const people = discussPeople(call);
  const names = people.map((item) => item.agent).join("、");
  const who = <DiscussPeopleSegment people={people.map((item) => item.agent)} types={types} ownAgent={ownAgent} disabled={disabled} onToggle={onToggle} />;
  const rounds = <DiscussRoundsSegment rounds={call.rounds} disabled={disabled} onChange={onRounds} />;
  if (people.length > 1) {
    return (
      <div className="run-target-picker is-chip is-highlight" role="group" aria-label={`一起讨论的智能体：${names}`}>
        {who}
        {rounds}
      </div>
    );
  }
  return (
    <RunTargetPicker
      label={`一起讨论的智能体：${names}`}
      types={types}
      profiles={profiles}
      selection={{ agentType: call.target.agent, executorId: call.target.executorId }}
      model={model}
      effort={effort}
      variant="chip"
      highlight
      disabled={disabled}
      onCommit={onCommit}
      onEffortChange={onEffortChange}
      agentSegment={who}
      tail={rounds}
    />
  );
}

/**
 * 「和谁」那一段：写着叫了的人，点开一张多选的单子。这条任务自己的执行器在单子里但按不动（它本来就在）。
 * 单子挂到 body 上、贴着这一段定位（同选模型那张，见 usePanelPlacement）：胶囊是 `overflow: hidden` 的。
 */
function DiscussPeopleSegment({ people, types, ownAgent, disabled, onToggle }: {
  people: AgentType[];
  types: AgentType[];
  ownAgent: AgentType;
  disabled: boolean;
  onToggle: (agent: AgentType) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissable({ enabled: open, containerRef: menuRef, restoreFocusRef: triggerRef, onClose: () => setOpen(false) });
  const place = usePanelPlacement(triggerRef, menuRef, { minWidth: 220, fallbackHeight: 180, minHeight: 120, enabled: open });
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitemcheckbox]:not([aria-disabled=true])")?.focus();
  }, [open]);
  const candidates = types.includes(ownAgent) ? types : [ownAgent, ...types];
  const full = people.length >= MAX_DISCUSSION_GUESTS;
  const names = people.join("、");
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="run-target-seg run-target-seg--agent"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`和谁讨论：${names}；点击增减`}
        onClick={() => setOpen((value) => !value)}
      >
        <AgentIcon agent={people[0]} size={12} />
        <b className="discuss-people-names">{names}</b>
        <CaretDown size={9} weight="bold" className="run-target-caret" aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="discuss-people-menu" role="menu" aria-label="和谁讨论" style={placementStyle(place)}>
          <p>{full ? "最多三方：再勾别人会换掉后加的那一个" : "可以再叫一个，三方一起说"}</p>
          {candidates.map((agent) => {
            const own = agent === ownAgent;
            const on = own || people.includes(agent);
            const last = on && !own && people.length === 1;
            const held = own || last;
            return (
              <button
                key={agent}
                type="button"
                role="menuitemcheckbox"
                className="discuss-people-item"
                aria-checked={on}
                aria-disabled={held || undefined}
                onClick={() => { if (!held) onToggle(agent); }}
              >
                <AgentIcon agent={agent} size={13} />
                <span>{agent}</span>
                {own ? <em>这里的执行器</em> : last ? <em>至少一个</em> : null}
                {on && <Check size={12} weight="bold" aria-hidden="true" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 「几轮」那一段：1 轮 / 2 轮 / 3 轮 / 谈拢为止，点一下换下一档。 */
function DiscussRoundsSegment({ rounds, disabled, onChange }: {
  rounds: DiscussionRounds;
  disabled: boolean;
  onChange: (rounds: DiscussionRounds) => void;
}) {
  const next = nextRounds(rounds);
  return (
    <button
      type="button"
      className="run-target-seg run-target-seg--tail"
      disabled={disabled}
      aria-label={`来回几轮：${discussionRoundsLabel(rounds)}；点击改成${discussionRoundsLabel(next)}`}
      onClick={() => onChange(next)}
    ><span>{discussionRoundsLabel(rounds)}</span></button>
  );
}
