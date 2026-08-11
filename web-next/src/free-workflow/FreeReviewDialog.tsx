import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentExecutorProfile, FreeReviewCheckMode, ReviewerProfile } from "@harness/shared";
import { CheckCircle, MagnifyingGlass, Plus, SpinnerGap, X } from "@phosphor-icons/react";
import { registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import {
  createReviewerDraft,
  ReviewerProfileSummary,
  ReviewerProfileFields,
  reviewerPayload,
  type ReviewerDraft,
} from "./ReviewerProfileFields.tsx";

export function FreeReviewDialog({
  taskId,
  state,
  reservationMode,
  onChanged,
  onClose,
  notify,
}: {
  taskId: string;
  state: FreeWorkflowApiState | null;
  reservationMode: boolean;
  onChanged: (state: FreeWorkflowApiState) => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const scrim = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLFormElement>(null);
  const [reviewers, setReviewers] = useState<ReviewerProfile[]>([]);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [selectedId, setSelectedId] = useState(state?.selectedReviewerId ?? "");
  const [checkMode, setCheckMode] = useState<FreeReviewCheckMode>(state?.reviewReservation?.checkMode ?? "logic");
  const [retryLimit, setRetryLimit] = useState(String(state?.reviewReservation?.retryLimit ?? 1));
  const [note, setNote] = useState(state?.reviewReservation?.note ?? "");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ReviewerDraft>(() => createReviewerDraft());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const dialogTitle = reservationMode ? (state?.reviewReservation?.armed ? "调整预约审查" : "预约审查") : "派审查";
  const types = useMemo(() => registeredAgentTypes(profiles), [profiles]);
  useDismissable({ enabled: !busy, containerRef: scrim, onClose });

  useEffect(() => { dialog.current?.focus(); }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([api.reviewerProfiles(), api.agents()]).then(([nextReviewers, nextProfiles]) => {
      if (!alive) return;
      setReviewers(nextReviewers);
      setProfiles(nextProfiles);
      setDraft(createReviewerDraft(nextProfiles));
      const preferred = state?.selectedReviewerId && nextReviewers.some((item) => item.id === state.selectedReviewerId)
        ? state.selectedReviewerId
        : nextReviewers[0]?.id ?? "";
      setSelectedId(preferred);
      setCheckMode(state?.reviewReservation?.checkMode ?? "logic");
      setRetryLimit(String(state?.reviewReservation?.retryLimit ?? 1));
      setNote(state?.reviewReservation?.note ?? "");
      setCreating(nextReviewers.length === 0);
    }).catch((error) => notify(error instanceof Error ? error.message : "审查者读取失败"))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [
    notify,
    state?.reviewReservation?.checkMode,
    state?.reviewReservation?.note,
    state?.reviewReservation?.retryLimit,
    state?.selectedReviewerId,
  ]);

  const create = async () => {
    if (!draft.name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await api.createReviewerProfile(reviewerPayload(draft, profiles));
      setReviewers((current) => [created, ...current]);
      setSelectedId(created.id);
      setCreating(false);
      notify(`已创建并选中审查者「${created.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "审查者创建失败");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!selectedId || busy || loading) return;
    setBusy(true);
    try {
      const input = {
        reviewerId: selectedId,
        checkMode,
        retryLimit: Number(retryLimit),
        note,
      };
      const next = reservationMode
        ? await api.reserveFreeReview(taskId, input)
        : await api.dispatchFreeReview(taskId, input);
      onChanged(next);
      const name = reviewers.find((item) => item.id === selectedId)?.name ?? "审查者";
      notify(reservationMode ? `已预约完成后由「${name}」审查` : `已派出 ${name}`);
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : reservationMode ? "预约审查失败" : "派审失败");
    } finally {
      setBusy(false);
    }
  };

  const cancelReservation = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await api.cancelFreeReviewReservation(taskId);
      onChanged(next);
      notify("已取消审查预约");
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : "取消审查预约失败");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="task-modal-scrim" ref={scrim} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <form
        ref={dialog}
        className="free-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="free-review-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header>
          <span><MagnifyingGlass size={17} weight="bold" /></span>
          <div><h2 id="free-review-title">{dialogTitle}</h2><p>{reservationMode ? "选择审查者与检查深度；任务确认完成后自动开始。" : "选择一套审查者配置，再决定检查深度与失败后的自动复审次数。"}</p></div>
          <button type="button" aria-label={`关闭${dialogTitle}`} disabled={busy} onClick={onClose}><X size={15} /></button>
        </header>
        {loading ? <div className="free-review-loading"><SpinnerGap size={15} className="is-spinning" />正在读取审查者…</div> : (
          <div className="free-review-dialog-body">
            <section className="free-review-reviewers">
              <div className="free-review-section-title"><b>审查者</b><button type="button" onClick={() => setCreating((value) => !value)}><Plus size={11} />新建</button></div>
              <div className="free-review-reviewer-list">
                {reviewers.map((reviewer) => (
                  <button key={reviewer.id} type="button" aria-selected={selectedId === reviewer.id} onClick={() => { setSelectedId(reviewer.id); setCreating(false); }}>
                    <span><b>{reviewer.name}</b><ReviewerProfileSummary reviewer={reviewer} profiles={profiles} /></span>
                    {selectedId === reviewer.id && <CheckCircle size={16} weight="fill" />}
                  </button>
                ))}
              </div>
              {creating && (
                <div className="free-review-create" onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.target instanceof HTMLButtonElement) return;
                  event.preventDefault();
                  void create();
                }}>
                  <ReviewerProfileFields draft={draft} profiles={profiles} types={types} disabled={busy} onChange={setDraft} />
                  <button type="button" disabled={busy || !draft.name.trim() || !profiles.length} onClick={() => void create()}>{busy ? "创建中…" : "创建并选中"}</button>
                </div>
              )}
            </section>
            <section className="free-review-options">
              <label><span>检查类型</span><select value={checkMode} onChange={(event) => setCheckMode(event.target.value as FreeReviewCheckMode)}><option value="logic">逻辑检查</option><option value="syntax">只做语法检查</option></select></label>
              <label><span>失败后自动复审</span><select value={retryLimit} onChange={(event) => setRetryLimit(event.target.value)}>{[0, 1, 2, 3, 5].map((value) => <option key={value} value={value}>{value} 轮</option>)}</select></label>
              <label className="free-review-note">
                <span>附言（可选）</span>
                <textarea
                  value={note}
                  maxLength={2000}
                  disabled={busy}
                  placeholder="补充希望审查者重点关注的内容"
                  aria-describedby="free-review-note-hint"
                  onChange={(event) => setNote(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }}
                />
                <small id="free-review-note-hint">Enter 提交 · Shift+Enter 换行</small>
              </label>
              <p>默认 1 轮：首次审查未通过后，执行方修完会自动再审一次。逻辑检查遇到可见前端改动时必须真实打开页面并截图。</p>
            </section>
          </div>
        )}
        <footer>
          {state?.reviewReservation?.armed && <button type="button" disabled={busy} onClick={() => void cancelReservation()}>取消预约</button>}
          <button type="button" disabled={busy} onClick={onClose}>{state?.reviewReservation?.armed ? "关闭" : "取消"}</button>
          <button className="is-primary" type="submit" aria-keyshortcuts="Enter" disabled={busy || loading || !selectedId}>
            {busy ? (reservationMode ? "保存中…" : "启动中…") : reservationMode ? (state?.reviewReservation?.armed ? "保存预约" : "预约审查") : "开始审查"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
