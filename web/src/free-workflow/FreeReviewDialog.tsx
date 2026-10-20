import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentExecutorProfile, FreeReviewCheckMode, FreeReviewExecutorOverride, ReviewerProfile } from "@ash/shared";
import { MAX_FREE_REVIEW_RETRIES } from "@ash/shared/free-workflow";
import { CheckCircle, MagnifyingGlass, Plus, SpinnerGap, Trash, X } from "@phosphor-icons/react";
import { registeredAgentTypes } from "../lib/agentAvailability.ts";
import { reviewerDeleteMessage, settledDisputeRounds } from "./freeReviewCopy.ts";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { selectAllOnFocus } from "../lib/selectAllOnFocus.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { isSendKeyEvent } from "../lib/sendKey.ts";
import { useSendKeyLabels } from "../lib/useComposerSendKey.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
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
  const [deleteTarget, setDeleteTarget] = useState<ReviewerProfile | null>(null);
  // 这份表单只在「打开这一次」初始化一次。对话框开着的时候远端预约字段照样会变 —— 别的
  // 页面改了预约、自动复审推进了一轮，以及**在这个对话框里删掉被预约引用的那位审查者**
  // （服务端会顺手取消那条预约）。这些都不等于「用户重新打开了对话框」：正在写的草稿不
  // 是已经保存的旧预约，不该被一次远端刷新冲掉（实测：删掉另一位审查者，刚改好的审查者、
  // 检查类型、复审轮数和整段附言会一起被打回）。三个入口都写成
  // `{open && <FreeReviewDialog …>}`，所以「挂载一次 = 打开一次」，这个 ref 跟着对话框活。
  const initialized = useRef(false);
  // 审查者清单的代次：每成功写一次（删除 / 新建 / 覆盖）就 +1，比它旧的在飞响应整份丢弃。
  // `alive` 只能证明这个 effect 还活着，证明不了这份响应比最近一次写操作新 —— 一个先发后
  // 到的 GET 会把刚删掉的那位又贴回清单，而提示还写着「已删除」。
  const listGen = useRef(0);
  const invalidateReviewerList = () => { listGen.current += 1; };
  // 初始化要读「清单回来那一刻」的状态，而不是某次渲染闭包里的那一份。
  const stateRef = useRef(state);
  stateRef.current = state;
  const hasState = !!state;
  const refocusAfterDelete = useRef(false);
  const postMerge = !!postMergeTarget;
  const parsedRetryLimit = parseRetryLimit(retryLimit);
  // 合并结果审查本来就不复审（提交时写死 0），别让那条禁用的输入卡住它的提交按钮。
  const retryLimitInvalid = !postMerge && parsedRetryLimit === null;
  const dialogTitle = postMerge
    ? "审查合并结果"
    : reservationMode ? (state?.reviewReservation?.armed ? "调整预约审查" : "预约审查") : "派审查";
  const types = useMemo(() => registeredAgentTypes(profiles), [profiles]);
  const sendKeys = useSendKeyLabels();
  // 已裁定「不在本任务里修」的那几轮：服务端派审时会自动讲给审查者听（见后端
  // free-review-settled.ts）。这里摆一句，否则用户不知道这件事已经自动化了，只会
  // 照旧每轮手打「有异议的已经转为新任务，只审查本次改动内容」。
  const settled = useMemo(() => settledDisputeRounds(state?.reviews), [state?.reviews]);
  // 轮号跨 run 会重复（第二条审查链又从第 1 轮数起），所以这里只报条数、不报轮号。
  const noteHint = settled.length
    ? `${sendKeys.send} 提交 · ${sendKeys.newline} 换行 · 已有 ${settled.length} 处意见被你裁定「不在本任务里修」` +
      "（转为独立任务或作废），派审时会自动讲给审查者，不必在这里重复说明"
    : `${sendKeys.send} 提交 · ${sendKeys.newline} 换行`;
  const selectedReviewer = reviewers.find((item) => item.id === selectedId) ?? null;
  const runChanged = !sameAsReviewer(runDraft, selectedReviewer);
  // 对话框开着期间**始终**登记在那摞可关闭层里。`enabled` 跟着 busy 翻动等于「退出这摞
  // 再重新 push」，层序会被改写成最新 push 的那一个 —— 父层跑到里面那个确认框前面去，
  // 于是点确认框被父层判成「点了外面」，两个框一起关掉（删除失败后再点一次「删除」，
  // 实测就是两个一起消失、请求一次都没发出去）。要禁的是「这会儿不许关」，那归 onClose
  // 判，跟层序无关；`useDismissable` 的 onClose 是每次渲染写进 ref 的，不会因此重登记。
  useDismissable({ enabled: true, containerRef: scrim, onClose: () => { if (!busy) onClose(); } });

  // 换审查者 = 换了参照系：草稿、保存方式、新名字整套回到这位审查者的原配置。
  const selectReviewer = (reviewer: ReviewerProfile) => {
    setSelectedId(reviewer.id);
    setRunDraft(reviewerRunDraft(reviewer));
    setSaveMode("once");
    setNewName("");
  };

  useEffect(() => { dialog.current?.focus(); }, []);

  useEffect(() => {
    // 已经按一份真实状态初始化过就不再来第二遍（见 initialized 的说明）。
    if (initialized.current) return;
    let alive = true;
    const read = () => {
      const gen = listGen.current;
      Promise.all([api.reviewerProfiles(), api.agents()]).then(([nextReviewers, nextProfiles]) => {
        if (!alive) return;
        // 这中间写过一次（删 / 新建 / 覆盖）：手上这份清单已经是旧世界的，整份丢掉重读
        // 一次。直接铺上去的话，刚删掉的那位会原样回到清单里，而提示还写着「已删除」。
        if (gen !== listGen.current) { read(); return; }
        // 读的是「清单回来那一刻」的状态，不是某次渲染闭包里的那一份。
        const opened = stateRef.current;
        // 状态还没到（父层那条 GET 还在飞）就先按默认值摆出来，等它到了再补这一次初始化。
        initialized.current = !!opened;
        setReviewers(nextReviewers);
        setProfiles(nextProfiles);
        setDraft(createReviewerDraft(nextProfiles));
        const preferred = opened?.selectedReviewerId && nextReviewers.some((item) => item.id === opened.selectedReviewerId)
          ? opened.selectedReviewerId
          : nextReviewers[0]?.id ?? "";
        setSelectedId(preferred);
        setCheckMode(opened?.reviewReservation?.checkMode ?? "logic");
        setRetryLimit(String(opened?.reviewReservation?.retryLimit ?? 1));
        setNote(opened?.reviewReservation?.note ?? "");
        // 「调整预约审查」再打开时要看到上次改后的那套配置，而不是审查者的原配置——
        // 预约里存着覆盖就回显它，保存方式跟着回到「仅本次使用」。
        const reserved = opened?.reviewReservation?.override ?? null;
        const reviewer = nextReviewers.find((item) => item.id === preferred) ?? null;
        setRunDraft(reserved && reviewer ? reviewerRunDraftFrom(reserved) : reviewerRunDraft(reviewer));
        setSaveMode("once");
        setNewName("");
        setCreating(nextReviewers.length === 0);
      }).catch((error) => notify(error instanceof Error ? error.message : "审查者读取失败"))
        .finally(() => { if (alive) setLoading(false); });
    };
    read();
    return () => { alive = false; };
  }, [hasState, notify]);

  // 删成功那一下，原来那颗删除按钮已经不在了；确认框只在「原来那个元素还连着」时才还
  // 焦点，于是焦点掉到 body 上，键盘就从对话框里掉了出去。给它补一个落点：对话框本身。
  useEffect(() => {
    if (deleteTarget || !refocusAfterDelete.current) return;
    refocusAfterDelete.current = false;
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
  }, [deleteTarget]);

  const create = async () => {
    if (!draft.name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await api.createReviewerProfile(reviewerPayload(draft, profiles));
      invalidateReviewerList();
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

  // 删审查者删的是一份**全局配置**，别的任务也在用它，所以跟设置页同一套口径：先确认，
  // 再照服务端的真实后果写清楚（历史审查记录留的是当时的配置快照，不受影响）。
  const reservation = state?.reviewReservation;
  // 自动复审的续轮预约（runId 非空）配置已冻结在 run 行里，删了照样能续；只有手动预约会断，
  // 服务端在那种情况下会顺手 disarm，所以确认框要提前把这句说在前面。
  const deleteBreaksReservation = !!deleteTarget
    && !!reservation?.armed
    && !reservation.runId
    && reservation.reviewerId === deleteTarget.id;

  const removeReviewer = async () => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    try {
      await api.deleteReviewerProfile(deleteTarget.id);
      // 先作废在飞的清单读取，再整体写回：这之后不会再有旧响应把这位贴回来。
      invalidateReviewerList();
      const rest = reviewers.filter((item) => item.id !== deleteTarget.id);
      setReviewers(rest);
      // 删掉的正是当前选中的那位时要补一个选中项：下一位顶上；一个都不剩就把新建表单摊开。
      // 否则对话框会停在「没有选中、提交按钮永远灰着」的死角，用户只能关掉重开。
      if (deleteTarget.id === selectedId) {
        if (rest[0]) selectReviewer(rest[0]);
        else {
          setSelectedId("");
          setRunDraft(reviewerRunDraft(null));
          setSaveMode("once");
          setNewName("");
          setCreating(true);
        }
      }
      refocusAfterDelete.current = true;
      setDeleteTarget(null);
      notify(`已删除审查者「${deleteTarget.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "审查者删除失败");
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
        invalidateReviewerList();
        setReviewers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      } else if (payload && saveMode === "new") {
        const created = await api.createReviewerProfile({ name: newName.trim(), ...payload });
        invalidateReviewerList();
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
      notify(postMerge ? `已派出 ${name} 审查合并结果` : reservationMode ? `已预约由「${name}」审查，执行回合正常结束后开始` : `已派出 ${name}`);
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
          <div><h2 id="free-review-title">{dialogTitle}</h2><p>{postMerge ? "在验收时冻结的目标分支快照上做一次可选检查；未通过时另建修复任务。" : reservationMode ? "选择审查者与检查深度；执行回合正常结束后自动开始。托盘里还排着消息时先把它们发完，停止、异常或等待答复时保留预约。" : "选择一套审查者配置，再决定检查深度与失败后的自动复审次数。"}</p></div>
          <button type="button" aria-label={`关闭${dialogTitle}`} disabled={busy} onClick={onClose}><X size={15} /></button>
        </header>
        {loading ? <div className="free-review-loading"><SpinnerGap size={15} className="is-spinning" />正在读取审查者…</div> : (
          <div className="free-review-dialog-body">
            <section className="free-review-reviewers">
              <div className="free-review-section-title"><b>审查者</b><button type="button" onClick={() => setCreating((value) => !value)}><Plus size={11} />新建</button></div>
              <div className="free-review-reviewer-list">
                {reviewers.map((reviewer) => (
                  <div key={reviewer.id} className="free-review-reviewer-row">
                    <button className="free-review-reviewer-pick" type="button" aria-selected={selectedId === reviewer.id} onClick={() => { selectReviewer(reviewer); setCreating(false); }}>
                      <span><b>{reviewer.name}</b><ReviewerProfileSummary reviewer={reviewer} profiles={profiles} /></span>
                      {selectedId === reviewer.id && <CheckCircle size={16} weight="fill" />}
                    </button>
                    <button
                      className="free-review-reviewer-delete"
                      type="button"
                      aria-label={`删除审查者「${reviewer.name}」`}
                      disabled={busy}
                      onClick={() => setDeleteTarget(reviewer)}
                    ><Trash size={13} /></button>
                  </div>
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
                  // 这个小表单里只有单行输入，所以它**不跟**「输入框发送键」那一档（设置 →
                  // 默认规则 → 输入框）：单行输入里回车提交是浏览器自己的表单语义，到处都
                  // 一样，没有第二种读法；跟着那一档走只会变成「填完名字按回车没反应」。
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
                    if (!isSendKeyEvent(event)) return;
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }}
                />
                <small id="free-review-note-hint">{noteHint}</small>
              </label>
              <p>{postMerge ? "这次只检查冻结的合并快照，不改动原任务。若发现问题，可从审查记录创建基于该 merge commit 的独立修复任务。" : "默认 1 轮：首次审查未通过后，执行方修完会自动再审一次。逻辑检查遇到可见前端改动时必须真实打开页面并截图。"}</p>
            </section>
          </div>
        )}
        <footer>
          {!postMerge && state?.reviewReservation?.armed && <button type="button" disabled={busy} onClick={() => void cancelReservation()}>取消预约</button>}
          <button type="button" disabled={busy} onClick={onClose}>{!postMerge && state?.reviewReservation?.armed ? "关闭" : "取消"}</button>
          <button className="is-primary" type="submit" aria-keyshortcuts={sendKeys.ariaShortcut} disabled={busy || loading || !selectedId || retryLimitInvalid}>
            {busy ? (reservationMode && !postMerge ? "保存中…" : "启动中…") : postMerge ? "开始审查" : reservationMode ? (state?.reviewReservation?.armed ? "保存预约" : "预约审查") : "开始审查"}
          </button>
        </footer>
      </form>
      {/* 自己 portal 到 body、自己进那摞可关闭层，所以挂在这里不会被遮罩的「点外面」判成关闭。 */}
      {deleteTarget && (
        <ConfirmDialog
          title="删除审查者"
          message={reviewerDeleteMessage(deleteTarget.name, { breaksReservation: deleteBreaksReservation })}
          confirmLabel="删除"
          danger
          busy={busy}
          onConfirm={() => void removeReviewer()}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>,
    document.body,
  );
}
