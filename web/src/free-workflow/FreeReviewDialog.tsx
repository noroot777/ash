import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentExecutorProfile, FreeReviewCheckMode, FreeReviewExecutorOverride, ReviewerProfile } from "@ash/shared";
import { MAX_FREE_REVIEW_RETRIES } from "@ash/shared/free-workflow";
import { SlidersHorizontal, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { Dropdown } from "../components/Dropdown.tsx";
import { RoundsStepper } from "../components/RoundsStepper.tsx";
import { InspButton, InspTool } from "../inspector/parts.tsx";
import { registeredAgentTypes } from "../lib/agentAvailability.ts";
import { settledDisputeRounds } from "./freeReviewCopy.ts";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { reviewerProfilesStore } from "./reviewerProfilesStore.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { isSendKeyEvent } from "../lib/sendKey.ts";
import { useSendKeyLabels } from "../lib/useComposerSendKey.ts";
import { reviewerRunText } from "./ReviewerProfileFields.tsx";
import {
  ReviewerRunOnce,
  reviewerRunDraft,
  reviewerRunDraftFrom,
  reviewerRunPayload,
  sameAsReviewer,
  type ReviewerRunDraft,
} from "./ReviewerRunOverride.tsx";
import { openReviewerSettings } from "./openReviewerSettings.ts";
import "../styles/free-review-dialog.css";

const CHECK_MODES = [
  { value: "logic", label: "逻辑检查", detail: "看得见的前端改动会真打开页面截图" },
  { value: "syntax", label: "只做语法检查" },
] as const;

/**
 * 派审 / 预约审查：四行（审查者、检查类型、失败后自动复审几轮、附言）、一个主动作。任务在跑时
 * 同一个对话框叫「预约审查」，约过了再打开是「调整预约审查」，这时多一颗「取消预约」。
 *
 * 审查者的新建、删除、长期改配置都在设置页「审查者」——下拉最底下那一项「管理审查者…」过去。
 * 这里只留一样设置页做不了的：**这一次**换个执行器跑（审查者行尾那颗小钮，点开才出），
 * 改了不写回那位审查者。
 */
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
  // 清单只从资源层来（`reviewerProfilesStore.ts`）：这个组件绝不自己拼清单 —— 某个闭包里
  // 捕获的那份旧清单会把别处刚删掉的那位贴回去。写操作只管调资源层，新清单由订阅送达。
  const [reviewers, setReviewers] = useState<ReviewerProfile[]>(() => reviewerProfilesStore.current() ?? []);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [selectedId, setSelectedId] = useState(state?.selectedReviewerId ?? "");
  const [checkMode, setCheckMode] = useState<FreeReviewCheckMode>(state?.reviewReservation?.checkMode ?? "logic");
  const [retryLimit, setRetryLimit] = useState(state?.reviewReservation?.retryLimit ?? 1);
  const [note, setNote] = useState(state?.reviewReservation?.note ?? "");
  // 「这一次用谁跑」：进来先等于选中审查者的配置；只有点开审查者行尾那颗钮才摆出来。
  const [runDraft, setRunDraft] = useState<ReviewerRunDraft>(() => reviewerRunDraft(null));
  const [runOpen, setRunOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(false);
  /*
   * 这个对话框里有两样东西，生命周期完全不同，必须分开管，别拿一个去挡另一个：
   *
   * ① **草稿**（选中谁、检查类型、轮数、附言、这一次的执行器）属于「某个任务的
   *    某一次打开」。它只按 taskId 初始化一次：远端预约字段在对话框开着的时候照样会变
   *    （别的页面改了预约、自动复审推进了一轮、在这里删掉被预约引用的那位审查者——服务端
   *    会顺手撤掉预约），那都不等于「用户重新打开了对话框」，正在写的草稿不是已经保存的
   *    旧预约。反过来，**任务一旦被换掉**（浏览器后退、侧栏切任务；容器没有按 task.id
   *    重建组件），这份草稿就不再属于当前任务了，必须整套重来 —— 否则会把给 A 写的附言
   *    保存到 B 身上。所以这里记的是「为哪个任务初始化过」，不是一个布尔开关。
   *
   * ② **审查者清单**是一份**全局配置**，别的页面（设置页的删除入口）随时能删掉其中一
   *    位。它必须跟着远端走：任务状态每变一次就重读一次权威清单，只更新清单本身和**确实
   *    失效**的选中项。保护用户输入不等于停止同步远端资源——那会让这里一直摆着一个已经
   *    不存在的配置，点下去才报「审查者不存在」。
   */
  const [initializedFor, setInitializedFor] = useState<string | null>(null);
  const initializedForRef = useRef<string | null>(null);
  initializedForRef.current = initializedFor;
  /*
   * 异步写回的身份门禁。这个对话框**不按 task.id 重建**（浏览器后退、侧栏切任务都只是换
   * props），所以「组件还活着」和「当前已经初始化完成」两条都证明不了「这次 await 回来的
   * 动作仍属于眼前这份草稿」。每个异步动作发起时记下身份（哪个任务、第几次初始化），回来
   * 先验一遍：服务端请求该做的照做（用户点的删除 / 派审本来就是冲着那个任务发的），但它
   * 不许再改一份已经不属于它的草稿、不许抢掉新对话框的忙碌态、更不许把新对话框关掉。
   *
   * 不做这道门禁的后果（实测）：在 A 上点了派审，等响应期间后退到 B，A 那次的返回会把
   * B 刚初始化好的对话框关掉、用 A 的状态盖住 B。
   */
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  const openGen = useRef(0);
  const identity = () => `${taskIdRef.current}#${openGen.current}`;
  const mine = (token: string) => identity() === token;
  // 初始化要读「清单回来那一刻」的状态，而不是某次渲染闭包里的那一份。
  const stateRef = useRef(state);
  stateRef.current = state;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const hasState = !!state;
  // 表单摊开的前提：**这个任务**的状态和审查者清单都到齐了。少一样都不许开放编辑 ——
  // 在还没有真实状态的空表单上写的东西，等状态到了会被那一次初始化整套盖掉。
  const ready = initializedFor === taskId && !loading;
  const postMerge = !!postMergeTarget;
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
  // 没裁定过就不摆这一行；发送键怎么按写在附言框的读屏说明和主键的快捷键属性上。
  const settledHint = settled.length
    ? `已有 ${settled.length} 处意见被你裁定「不在本任务里修」（转为独立任务或作废），派审时会自动讲给审查者，不必在这里重复说明`
    : "";
  const selectedReviewer = reviewers.find((item) => item.id === selectedId) ?? null;
  const runChanged = !sameAsReviewer(runDraft, selectedReviewer);
  // 对话框开着期间**始终**登记在那摞可关闭层里。`enabled` 跟着 busy 翻动等于「退出这摞
  // 再重新 push」，层序会被改写成最新 push 的那一个 —— 父层跑到里面那几只下拉浮层前面去，
  // 于是点浮层被父层判成「点了外面」，两层一起关掉。要禁的是「这会儿不许关」，那归 onClose
  // 判，跟层序无关；`useDismissable` 的 onClose 是每次渲染写进 ref 的，不会因此重登记。
  useDismissable({ enabled: true, containerRef: scrim, onClose: () => { if (!busy) onClose(); } });

  // 换审查者 = 换了参照系：「这一次用谁跑」回到这位审查者的原配置。
  const selectReviewer = (reviewer: ReviewerProfile) => {
    setSelectedId(reviewer.id);
    setRunDraft(reviewerRunDraft(reviewer));
  };

  const pickReviewer = (id: string) => {
    const reviewer = reviewers.find((item) => item.id === id);
    if (reviewer) selectReviewer(reviewer);
  };

  // 新建、删除、长期改配置都在设置页。先关掉对话框再走过去（草稿不保存：那边改完回来重新点开即可）。
  const manageReviewers = () => {
    onClose();
    openReviewerSettings();
  };

  useEffect(() => { dialog.current?.focus(); }, []);

  // ① 草稿初始化：每个任务只做一次（见上面那段说明）。
  useEffect(() => {
    if (initializedForRef.current === taskId) return;
    // 这个任务的状态还没到（父层那条 GET 还在飞）：先摆加载态，别让人在空表单上开写。
    if (!hasState) return;
    let alive = true;
    setLoadError(null);
    // 「读到哪一份算数」「写完怎么作废在飞的读」「删掉的那位不许被旧清单贴回来」都在资源
    // 层收口，这里只管拿结果，并且以它当时的缓存为准（这一拍可能刚被别处的变化更新过）。
    Promise.all([reviewerProfilesStore.read(), api.agents()]).then(([list, nextProfiles]) => {
      if (!alive) return;
      // 读的是「清单回来那一刻」的状态，不是某次渲染闭包里的那一份。
      const opened = stateRef.current;
      const nextReviewers = reviewerProfilesStore.current() ?? list;
      setReviewers(nextReviewers);
      setProfiles(nextProfiles);
      const preferred = opened?.selectedReviewerId && nextReviewers.some((item) => item.id === opened.selectedReviewerId)
        ? opened.selectedReviewerId
        : nextReviewers[0]?.id ?? "";
      setSelectedId(preferred);
      setCheckMode(opened?.reviewReservation?.checkMode ?? "logic");
      setRetryLimit(Math.min(MAX_FREE_REVIEW_RETRIES, Math.max(0, opened?.reviewReservation?.retryLimit ?? 1)));
      setNote(opened?.reviewReservation?.note ?? "");
      // 「调整预约审查」再打开时要看到上次改后的那套配置，而不是审查者的原配置——
      // 预约里存着覆盖就回显它，那颗「这一次换个执行器」直接摊开。
      const reserved = opened?.reviewReservation?.override ?? null;
      const reviewer = nextReviewers.find((item) => item.id === preferred) ?? null;
      const echoed = reserved && reviewer ? reviewerRunDraftFrom(reserved) : reviewerRunDraft(reviewer);
      setRunDraft(echoed);
      setRunOpen(!sameAsReviewer(echoed, reviewer));
      // 这一次初始化之前发出的异步动作，从这一刻起都不再属于眼前这份草稿。
      openGen.current += 1;
      setInitializedFor(taskId);
    }).catch((error) => {
      if (!alive) return;
      // 读不到清单就老实摆在那儿给一颗重试，别摊开一份空表单冒充「你还没有审查者」。
      const message = error instanceof Error ? error.message : "审查者读取失败";
      setLoadError(message);
      notify(message);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [hasState, notify, reloadToken, taskId]);

  // ② 任务一换，上一轮在飞的写操作就不再属于这个对话框：忙碌态立刻让位。
  //    否则新任务的对话框会顶着一个关不掉的「忙」——「取消」那颗键也是 disabled={busy}。
  useEffect(() => {
    setBusy(false);
  }, [taskId]);

  // ③ 清单同步：审查者是一份全局配置，谁都能删，所以重读的信号**不挂在「这项任务的状态
  //    变了」上** —— 别的页面删掉一位不被本任务引用的审查者时，这项任务的修订号一动不动，
  //    而用户在这里刚改选的那位本来就只是草稿，更不在持久化预约里。订阅期间由资源层自己
  //    保持新鲜（见那边的说明）。这里只做两件事：换上权威清单；选中项**确实失效**时补一个。
  //    附言 / 检查类型 / 轮数这些正在填的东西一个都不碰。
  useEffect(() => reviewerProfilesStore.subscribe((source) => {
    const next = reviewerProfilesStore.current() ?? [];
    setReviewers(next);
    const current = selectedIdRef.current;
    if (!current || next.some((item) => item.id === current)) return;
    // 选中的那位已经不在了。不能就这么摆着让人点一个注定失败的提交。
    const fallback = next[0];
    if (fallback) {
      selectReviewer(fallback);
      // 本机发起的那次删除自己会报「已删除审查者「X」」，别再叠一条。
      if (source === "remote") notify(`原先选中的审查者已被删除，已替你改选「${fallback.name}」`);
      return;
    }
    setSelectedId("");
    setRunDraft(reviewerRunDraft(null));
    setRunOpen(false);
    if (source === "remote") notify("审查者已被删除，请先在「管理审查者…」里新建一位再派审");
  }), [notify]);

  const submit = async () => {
    if (!selectedId || busy || !ready) return;
    // 草稿属于「这个任务的这一次打开」。任务在对话框开着的时候被换掉（浏览器后退、侧栏切
    // 任务——容器没有按 task.id 重建组件），这份草稿就不再属于当前任务了，绝不能拿它去
    // 提交：那会把写给 A 的附言保存到 B 身上。重新初始化期间这里只是挡一下，等它完成。
    if (initializedForRef.current !== taskId) {
      notify("任务已经切换，正在重新读取这项任务的审查配置");
      return;
    }
    // 用户按下这一下时选的是哪一位 —— 不是「await 之后 selectedId 变成了什么」。这中间
    // ③ 的订阅可能已经替他改选了别人，那也绝不能顶着「他点的是派审」把另一位派出去。
    const intended = selectedId;
    const token = identity();
    setBusy(true);
    try {
      // 派出去之前跟权威清单核一次：这中间别处（另一个标签页、另一台机器）删掉了这位，
      // 与其让服务端退一句「所选审查者不存在」，不如在这里就改选并说清楚。读失败不拦提交
      // —— 真的无效，服务端照样会拒。
      await reviewerProfilesStore.read().catch(() => {});
      const latest = reviewerProfilesStore.current();
      if (latest && !latest.some((item) => item.id === intended)) {
        // 「已替你改选成谁」由 ③ 的订阅自己报，这里只说清**这一次没派出去**，别叠一条重话。
        notify("所选审查者刚刚被删除了，这一次没有派出去；请确认改选后再派审");
        return;
      }
      // 这一次换了执行器就带上覆盖；审查者自己的配置不动。
      const override: FreeReviewExecutorOverride | null = runChanged ? reviewerRunPayload(runDraft, profiles) : null;
      const reviewerId = intended;
      const input = {
        reviewerId,
        checkMode,
        retryLimit: postMerge ? 0 : retryLimit,
        note,
        override,
      };
      // 这条请求冲着发起时那个任务发（`taskId` 是那一次渲染里的值），所以它该跑完就跑完。
      const next = postMerge
        ? await api.dispatchPostMergeReview(taskId, input)
        : reservationMode
          ? await api.reserveFreeReview(taskId, input)
          : await api.dispatchFreeReview(taskId, input);
      const name = reviewers.find((item) => item.id === intended)?.name ?? "审查者";
      notify(postMerge ? `已派出 ${name} 审查合并结果` : reservationMode ? `已预约由「${name}」审查，执行回合正常结束后开始` : `已派出 ${name}`);
      // 但返回的是**那个任务**的状态，对话框这会儿可能已经是另一个任务的了：把它交给
      // 容器就等于用 A 的状态盖 B，顺手 onClose() 更是关掉了一个别人正在填的对话框。
      if (!mine(token)) return;
      onChanged(next);
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : postMerge ? "合并结果审查启动失败" : reservationMode ? "预约审查失败" : "派审失败");
    } finally {
      if (mine(token)) setBusy(false);
    }
  };

  const cancelReservation = async () => {
    if (busy) return;
    const token = identity();
    setBusy(true);
    try {
      const next = await api.cancelFreeReviewReservation(taskId);
      notify("已取消审查预约");
      // 同上：取消本身该生效就生效，但 A 的状态不许盖到 B 身上，也不许关掉 B 的对话框。
      if (!mine(token)) return;
      onChanged(next);
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : "取消审查预约失败");
    } finally {
      if (mine(token)) setBusy(false);
    }
  };

  const armed = !postMerge && !!state?.reviewReservation?.armed;
  const primaryLabel = busy
    ? (reservationMode && !postMerge ? "保存中…" : "启动中…")
    : postMerge ? "开始审查" : reservationMode ? (armed ? "保存预约" : "预约审查") : "开始审查";
  const reviewerOptions = reviewers.map((reviewer) => ({
    value: reviewer.id,
    label: reviewer.name,
    detail: reviewerRunText(reviewer, profiles),
  }));

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
        <h2 id="free-review-title">{dialogTitle}</h2>
        {postMergeTarget && (
          <p className="free-review-dialog__target">
            合入 <code>{postMergeTarget.branch}</code> 的那次合并 · <code>{postMergeTarget.baseCommit.slice(0, 8)} → {postMergeTarget.mergeCommit.slice(0, 8)}</code>；不改动原任务，发现问题从审查记录另建修复任务
          </p>
        )}
        {!ready ? (
          <div className={`free-review-loading${loadError ? " is-error" : ""}`} role="status">
            {loadError
              ? <><WarningCircle size={14} aria-hidden="true" />{loadError}<InspButton size="sm" onClick={() => { setLoadError(null); setLoading(true); setReloadToken((value) => value + 1); }}>重试</InspButton></>
              : <><SpinnerGap size={14} className="is-spinning" aria-hidden="true" />{hasState ? "正在读取审查者…" : "正在读取任务状态…"}</>}
          </div>
        ) : (
          <div
            className="free-review-rows"
            onKeyDown={(event) => {
              // 停在审查者 / 检查类型那颗下拉上时：回车就是派审（选完一位，焦点回到下拉上，接着按回车
              // 就发出去），方向键往下才打开候选；空格照常打开。浮层里的按键 target 是浮层，不走这里。
              const target = event.target as HTMLElement;
              if (!target.classList.contains("ui-dropdown-trigger") || event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                target.closest("form")?.requestSubmit();
              } else if (event.key === "ArrowDown" && target.getAttribute("aria-expanded") !== "true") {
                event.preventDefault();
                target.click();
              }
            }}
          >
            <div className="free-review-row">
              <span id="free-review-reviewer-label">审查者</span>
              <div>
                {reviewers.length > 0 ? (
                  <Dropdown
                    className="free-review-reviewer"
                      label="审查者"
                    value={selectedId}
                    options={reviewerOptions}
                    filterable={reviewers.length > 8}
                    disabled={busy}
                    onChange={pickReviewer}
                    // 下拉最底下那一项：Dropdown 的尾项出口本来给「清空」用，这里借它摆「管理审查者…」。
                    onClear={manageReviewers}
                    clearLabel="管理审查者…"
                  />
                ) : (
                  <>
                    <span className="free-review-row__empty">还没有审查者</span>
                    <InspButton size="sm" onClick={manageReviewers}>管理审查者…</InspButton>
                  </>
                )}
                {selectedReviewer && (
                  <InspTool
                    label="这一次换个执行器"
                    tip={runOpen ? "收起：这一次照审查者原来的配置跑" : `只改这一次用谁跑，不动「${selectedReviewer.name}」的配置`}
                    aria-pressed={runOpen}
                    disabled={busy}
                    onClick={() => {
                      // 收起 = 不要这次的改动了，回到审查者原配置。
                      if (runOpen) setRunDraft(reviewerRunDraft(selectedReviewer));
                      setRunOpen((value) => !value);
                    }}
                  >
                    <SlidersHorizontal aria-hidden="true" />
                  </InspTool>
                )}
              </div>
            </div>
            {runOpen && selectedReviewer && (
              <div className="free-review-row is-sub">
                <span aria-hidden="true" />
                <ReviewerRunOnce
                  reviewer={selectedReviewer}
                  profiles={profiles}
                  types={types}
                  draft={runDraft}
                  changed={runChanged}
                  disabled={busy}
                  onChange={setRunDraft}
                />
              </div>
            )}
            <div className="free-review-row">
              <span>检查类型</span>
              <div>
                <Dropdown
                  className="free-review-check"
                  label="检查类型"
                  value={checkMode}
                  options={CHECK_MODES}
                  filterable={false}
                  disabled={busy}
                  onChange={(value) => setCheckMode(value as FreeReviewCheckMode)}
                />
              </div>
            </div>
            {!postMerge && (
              <div className="free-review-row">
                <span>失败后自动复审</span>
                <div>
                  <RoundsStepper label="自动复审" value={retryLimit} min={0} max={MAX_FREE_REVIEW_RETRIES} disabled={busy} onChange={setRetryLimit} />
                  <span>轮</span>
                  {retryLimit === 0 && <span className="free-review-row__zero">未通过就停下，等你处理</span>}
                </div>
              </div>
            )}
            <div className="free-review-row">
              <label htmlFor="free-review-note">附言</label>
              <div>
                <textarea
                  id="free-review-note"
                  className="free-review-note"
                  value={note}
                  maxLength={2000}
                  rows={2}
                  disabled={busy}
                  placeholder="补充希望审查者重点关注的内容"
                  aria-description={`${sendKeys.send} 提交，${sendKeys.newline} 换行`}
                  aria-describedby={settledHint ? "free-review-note-hint" : undefined}
                  onChange={(event) => setNote(event.target.value)}
                  onKeyDown={(event) => {
                    if (!isSendKeyEvent(event)) return;
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }}
                />
                {settledHint && <small id="free-review-note-hint" className="free-review-row__hint">{settledHint}</small>}
              </div>
            </div>
          </div>
        )}
        <footer>
          {armed && <InspButton variant="quiet" disabled={busy} onClick={() => void cancelReservation()}>取消预约</InspButton>}
          <span className="free-review-dialog__grow" />
          <InspButton disabled={busy} onClick={onClose}>取消</InspButton>
          <InspButton variant="pri" type="submit" aria-keyshortcuts={sendKeys.ariaShortcut} disabled={busy || !ready || !selectedId}>
            {primaryLabel}
          </InspButton>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
