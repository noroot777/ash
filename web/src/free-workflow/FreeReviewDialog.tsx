import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentExecutorProfile, FreeReviewCheckMode, FreeReviewExecutorOverride, ReviewerProfile } from "@ash/shared";
import { MAX_FREE_REVIEW_RETRIES } from "@ash/shared/free-workflow";
import { CheckCircle, MagnifyingGlass, Plus, SpinnerGap, X } from "@phosphor-icons/react";
import { registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { selectAllOnFocus } from "../lib/selectAllOnFocus.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import {
  createReviewerDraft,
  ReviewerProfileSummary,
  ReviewerProfileFields,
  reviewerPayload,
  type ReviewerDraft,
} from "./ReviewerProfileFields.tsx";
import {
  ReviewerRunOverride,
  reviewerRunDraft,
  reviewerRunDraftFrom,
  reviewerRunPayload,
  sameAsReviewer,
  type ReviewerRunDraft,
  type ReviewerRunSaveMode,
} from "./ReviewerRunOverride.tsx";

/**
 * 复审轮数是手填的：空串、小数、负号、超上限都要在这里判死，别让它走到提交那一刻
 * 才被后端（`free-review-input.ts` 的同一个上限）打回。null = 这串不是合法轮数。
 */
function parseRetryLimit(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return parsed <= MAX_FREE_REVIEW_RETRIES ? parsed : null;
}

export function FreeReviewDialog({
  taskId,
  state,
  reservationMode,
  postMergeTarget,
  onChanged,
  onClose,
  notify,
}: {
  taskId: string;
  state: FreeWorkflowApiState | null;
  reservationMode: boolean;
  postMergeTarget?: { branch: string; baseCommit: string; mergeCommit: string } | null;
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
  // 「这一次用谁跑」：进来先等于选中审查者的配置，改动的去向由 saveMode 决定。
  const [runDraft, setRunDraft] = useState<ReviewerRunDraft>(() => reviewerRunDraft(null));
  const [saveMode, setSaveMode] = useState<ReviewerRunSaveMode>("once");
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const postMerge = !!postMergeTarget;
  const parsedRetryLimit = parseRetryLimit(retryLimit);
  // 合并结果审查本来就不复审（提交时写死 0），别让那条禁用的输入卡住它的提交按钮。
  const retryLimitInvalid = !postMerge && parsedRetryLimit === null;
  const dialogTitle = postMerge
    ? "审查合并结果"
    : reservationMode ? (state?.reviewReservation?.armed ? "调整预约审查" : "预约审查") : "派审查";
  const types = useMemo(() => registeredAgentTypes(profiles), [profiles]);
  // 预约里的覆盖每次轮询都是新对象，直接进依赖会把用户正在改的草稿冲掉；按值序列化当键。
  const reservedOverrideKey = JSON.stringify(state?.reviewReservation?.override ?? null);
  const selectedReviewer = reviewers.find((item) => item.id === selectedId) ?? null;
  const runChanged = !sameAsReviewer(runDraft, selectedReviewer);
  useDismissable({ enabled: !busy, containerRef: scrim, onClose });

  // 换审查者 = 换了参照系：草稿、保存方式、新名字整套回到这位审查者的原配置。
  const selectReviewer = (reviewer: ReviewerProfile) => {
    setSelectedId(reviewer.id);
    setRunDraft(reviewerRunDraft(reviewer));
    setSaveMode("once");
    setNewName("");
  };

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
      // 「调整预约审查」再打开时要看到上次改后的那套配置，而不是审查者的原配置——
      // 预约里存着覆盖就回显它，保存方式跟着回到「仅本次使用」。
      const reserved = JSON.parse(reservedOverrideKey) as FreeReviewExecutorOverride | null;
      const reviewer = nextReviewers.find((item) => item.id === preferred) ?? null;
      setRunDraft(reserved && reviewer ? reviewerRunDraftFrom(reserved) : reviewerRunDraft(reviewer));
      setSaveMode("once");
      setNewName("");
      setCreating(nextReviewers.length === 0);
    }).catch((error) => notify(error instanceof Error ? error.message : "审查者读取失败"))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [
    notify,
    reservedOverrideKey,
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
      selectReviewer(created);
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
    if (retryLimitInvalid) {
      notify(`自动复审轮数必须是 0-${MAX_FREE_REVIEW_RETRIES} 的整数`);
      return;
    }
    if (runChanged && saveMode === "new" && !newName.trim()) {
      notify("请先给新审查者起个名字");
      return;
    }
    setBusy(true);
    try {
      // 三种去向的共同点：这一次审查一定按改后的配置跑。前两种把改动落进审查者配置
      // （落完就是它自己的配置，不必再带覆盖），「仅本次使用」才走 override。
      const payload = runChanged ? reviewerRunPayload(runDraft, profiles) : null;
      let reviewerId = selectedId;
      let override: FreeReviewExecutorOverride | null = null;
      if (payload && saveMode === "overwrite") {
        const updated = await api.patchReviewerProfile(selectedId, payload);
        setReviewers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      } else if (payload && saveMode === "new") {
        const created = await api.createReviewerProfile({ name: newName.trim(), ...payload });
        setReviewers((current) => [created, ...current]);
        setSelectedId(created.id);
        reviewerId = created.id;
      } else if (payload) {
        override = payload;
      }
      const input = {
        reviewerId,
        checkMode,
        retryLimit: postMerge ? 0 : (parsedRetryLimit ?? 0),
        note,
        override,
      };
      const next = postMerge
        ? await api.dispatchPostMergeReview(taskId, input)
        : reservationMode
          ? await api.reserveFreeReview(taskId, input)
          : await api.dispatchFreeReview(taskId, input);
      onChanged(next);
      const name = reviewerId === selectedId
        ? reviewers.find((item) => item.id === selectedId)?.name ?? "审查者"
        : newName.trim();
      notify(postMerge ? `已派出 ${name} 审查合并结果` : reservationMode ? `已预约完成后由「${name}」审查` : `已派出 ${name}`);
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : postMerge ? "合并结果审查启动失败" : reservationMode ? "预约审查失败" : "派审失败");
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
          <div><h2 id="free-review-title">{dialogTitle}</h2><p>{postMerge ? "在验收时冻结的目标分支快照上做一次可选检查；未通过时另建修复任务。" : reservationMode ? "选择审查者与检查深度；任务确认完成后自动开始。" : "选择一套审查者配置，再决定检查深度与失败后的自动复审次数。"}</p></div>
          <button type="button" aria-label={`关闭${dialogTitle}`} disabled={busy} onClick={onClose}><X size={15} /></button>
        </header>
        {loading ? <div className="free-review-loading"><SpinnerGap size={15} className="is-spinning" />正在读取审查者…</div> : (
          <div className="free-review-dialog-body">
            <section className="free-review-reviewers">
              <div className="free-review-section-title"><b>审查者</b><button type="button" onClick={() => setCreating((value) => !value)}><Plus size={11} />新建</button></div>
              <div className="free-review-reviewer-list">
                {reviewers.map((reviewer) => (
                  <button key={reviewer.id} type="button" aria-selected={selectedId === reviewer.id} onClick={() => { selectReviewer(reviewer); setCreating(false); }}>
                    <span><b>{reviewer.name}</b><ReviewerProfileSummary reviewer={reviewer} profiles={profiles} /></span>
                    {selectedId === reviewer.id && <CheckCircle size={16} weight="fill" />}
                  </button>
                ))}
              </div>
              {!creating && selectedReviewer && (
                <ReviewerRunOverride
                  reviewer={selectedReviewer}
                  profiles={profiles}
                  types={types}
                  draft={runDraft}
                  changed={runChanged}
                  saveMode={saveMode}
                  newName={newName}
                  disabled={busy}
                  onChange={setRunDraft}
                  onSaveModeChange={setSaveMode}
                  onNewNameChange={setNewName}
                />
              )}
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
              {postMergeTarget && (
                <dl className="free-review-target">
                  <div><dt>目标分支</dt><dd>{postMergeTarget.branch}</dd></div>
                  <div><dt>审查区间</dt><dd>{postMergeTarget.baseCommit.slice(0, 8)} → {postMergeTarget.mergeCommit.slice(0, 8)}</dd></div>
                </dl>
              )}
              <label><span>检查类型</span><select value={checkMode} onChange={(event) => setCheckMode(event.target.value as FreeReviewCheckMode)}><option value="logic">逻辑检查</option><option value="syntax">只做语法检查</option></select></label>
              {!postMerge && (
                <label className="free-review-retry">
                  <span>失败后自动复审</span>
                  <span className={`free-review-retry-field${retryLimitInvalid ? " is-invalid" : ""}`}>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={MAX_FREE_REVIEW_RETRIES}
                      step={1}
                      value={retryLimit}
                      disabled={busy}
                      aria-invalid={retryLimitInvalid}
                      aria-describedby="free-review-retry-hint"
                      onChange={(event) => setRetryLimit(event.target.value)}
                      {...selectAllOnFocus}
                    />
                    <em>轮</em>
                  </span>
                  <small id="free-review-retry-hint">
                    {retryLimitInvalid
                      ? `请填 0-${MAX_FREE_REVIEW_RETRIES} 之间的整数`
                      : `直接填 0-${MAX_FREE_REVIEW_RETRIES} 的整数；0 = 未通过就停下来等你处理`}
                  </small>
                </label>
              )}
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
              <p>{postMerge ? "这次只检查冻结的合并快照，不改动原任务。若发现问题，可从审查记录创建基于该 merge commit 的独立修复任务。" : "默认 1 轮：首次审查未通过后，执行方修完会自动再审一次。逻辑检查遇到可见前端改动时必须真实打开页面并截图。"}</p>
            </section>
          </div>
        )}
        <footer>
          {!postMerge && state?.reviewReservation?.armed && <button type="button" disabled={busy} onClick={() => void cancelReservation()}>取消预约</button>}
          <button type="button" disabled={busy} onClick={onClose}>{!postMerge && state?.reviewReservation?.armed ? "关闭" : "取消"}</button>
          <button className="is-primary" type="submit" aria-keyshortcuts="Enter" disabled={busy || loading || !selectedId || retryLimitInvalid}>
            {busy ? (reservationMode && !postMerge ? "保存中…" : "启动中…") : postMerge ? "开始审查" : reservationMode ? (state?.reviewReservation?.armed ? "保存预约" : "预约审查") : "开始审查"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
