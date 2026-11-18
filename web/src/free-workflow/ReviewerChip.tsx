import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { reviewerOfChoice, type CreateReviewChoice } from "@ash/shared/review-on-create";
import { CaretDown, MagnifyingGlass } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";
import type { ReviewerList } from "./useReviewerList.ts";

/**
 * 派出去那几处（派活单的每一行、可以派出去的活那一行、回复框里「派出去」）跟「交给谁」那颗胶囊并排的
 * 「谁来审」：同一身小胶囊，一段，写着这条建出来会交给哪位审查者，没人审就写「不审查」。点开一列审查者加一行
 * 「不审查」。只多这一个选择 —— 轮数和检查类型跟默认走（shared/src/review-on-create.ts），要改的人任务建出来
 * 之后在预约审查框里改。
 *
 * `value` 是选择本身（"default" 跟着设置里的默认走），画出来的是它此刻落到的那一位。清单还没读到时写「读取中」，
 * 读失败了写「没读到」—— 都不冒充成「默认」；这时照样点得开，「不审查」不靠清单、随时能选，读失败了还多一行
 * 「重新读取」（派出键那边由 useReviewerList.ts `reviewHold` 拦着，不拿看不出是谁的选择派出去）。
 */
export function ReviewerChip({ value, list, label, disabled = false, onChange }: {
  value: CreateReviewChoice;
  list: ReviewerList;
  /** 可访问名称的前半句（「第 2 条」「这条新任务」）。 */
  label: string;
  disabled?: boolean;
  onChange: (next: CreateReviewChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { reviewers, failed } = list;
  const picked = reviewers ? reviewerOfChoice(value, reviewers) : null;
  const pending = !reviewers && value !== "none";
  const name = pending ? (failed ? "没读到" : "读取中") : picked?.name ?? "不审查";
  // 读到了却一位都没有：只剩「不审查」，没什么可选的。
  const pickable = !disabled && (!reviewers || reviewers.length > 0);
  const place = usePanelPlacement(triggerRef, panelRef, { minWidth: 180, minHeight: 80, fallbackHeight: 160, enabled: open });
  useDismissable({ enabled: open, containerRef: panelRef, onClose: () => setOpen(false), restoreFocusRef: triggerRef });
  useLayoutEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const choose = (next: CreateReviewChoice) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };
  const rows = [
    ...(reviewers ?? []).map((reviewer) => ({ key: reviewer.id, text: reviewer.name, selected: picked?.id === reviewer.id, pick: () => choose({ reviewer: reviewer.id }) })),
    { key: "none", text: "不审查", selected: !picked && !pending, pick: () => choose("none") },
    ...(failed ? [{ key: "retry", text: "重新读取审查者", selected: false, pick: () => { list.retry(); setOpen(false); triggerRef.current?.focus(); } }] : []),
  ];
  const spoken = picked ? `交给 ${picked.name} 审查` : pending ? (failed ? "审查者清单没读到" : "正在读审查者清单") : "不审查";

  return (
    <div className={`run-target-picker is-chip reviewer-chip${picked || (pending && !failed) ? "" : " is-off"}`} role="group" aria-label={`${label}谁来审`}>
      <button
        ref={triggerRef}
        type="button"
        className="run-target-seg"
        disabled={!pickable}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}${spoken}${pickable ? "；点击更改" : ""}`}
        onClick={() => setOpen((current) => !current)}
      >
        <MagnifyingGlass size={12} aria-hidden="true" />
        <span>{name}</span>
        {pickable && <CaretDown size={9} weight="bold" className="run-target-caret" aria-hidden="true" />}
      </button>
      {open && createPortal(
        <div className="effort-picker-panel" ref={panelRef} tabIndex={-1} style={placementStyle(place)} role="listbox" aria-label={`${label}谁来审`}>
          {rows.map((row) => (
            <button type="button" role="option" key={row.key} aria-selected={row.selected} onClick={row.pick}>
              <b>{row.text}</b>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
