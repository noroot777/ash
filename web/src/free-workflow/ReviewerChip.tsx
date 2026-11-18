import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReviewerProfile } from "@ash/shared";
import { reviewerOfChoice, type CreateReviewChoice } from "@ash/shared/review-on-create";
import { CaretDown, MagnifyingGlass } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";

/**
 * 派出去那几处（派活单的每一行、可以派出去的活那一行、回复框里「派出去」）跟「交给谁」那颗胶囊并排的
 * 「谁来审」：同一身小胶囊，一段，写着这条建出来会交给哪位审查者，没人审就写「不审查」。点开一列审查者加一行
 * 「不审查」。只多这一个选择 —— 轮数和检查类型跟默认走（shared/src/review-on-create.ts），要改的人任务建出来
 * 之后在预约审查框里改。
 *
 * `value` 是选择本身（"default" 跟着设置里的默认走），画出来的是它此刻落到的那一位；清单还没读到时先写「默认」。
 */
export function ReviewerChip({ value, reviewers, label, disabled = false, onChange }: {
  value: CreateReviewChoice;
  /** null = 还没读到。 */
  reviewers: ReviewerProfile[] | null;
  /** 可访问名称的前半句（「第 2 条」「这条新任务」）。 */
  label: string;
  disabled?: boolean;
  onChange: (next: CreateReviewChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const picked = reviewers ? reviewerOfChoice(value, reviewers) : null;
  const pending = !reviewers && value !== "none";
  const name = pending ? "默认" : picked?.name ?? "不审查";
  const pickable = !disabled && !!reviewers?.length;
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
    ...(reviewers ?? []).map((reviewer) => ({ key: reviewer.id, text: reviewer.name, selected: picked?.id === reviewer.id, choice: { reviewer: reviewer.id } as CreateReviewChoice })),
    { key: "none", text: "不审查", selected: !picked && !pending, choice: "none" as CreateReviewChoice },
  ];

  return (
    <div className={`run-target-picker is-chip reviewer-chip${picked || pending ? "" : " is-off"}`} role="group" aria-label={`${label}谁来审`}>
      <button
        ref={triggerRef}
        type="button"
        className="run-target-seg"
        disabled={!pickable}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}${picked ? `交给 ${picked.name} 审查` : pending ? "交给默认审查者审查" : "不审查"}${pickable ? "；点击更改" : ""}`}
        onClick={() => setOpen((current) => !current)}
      >
        <MagnifyingGlass size={12} aria-hidden="true" />
        <span>{name}</span>
        {pickable && <CaretDown size={9} weight="bold" className="run-target-caret" aria-hidden="true" />}
      </button>
      {open && createPortal(
        <div className="effort-picker-panel" ref={panelRef} tabIndex={-1} style={placementStyle(place)} role="listbox" aria-label={`${label}谁来审`}>
          {rows.map((row) => (
            <button type="button" role="option" key={row.key} aria-selected={row.selected} onClick={() => choose(row.choice)}>
              <b>{row.text}</b>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
