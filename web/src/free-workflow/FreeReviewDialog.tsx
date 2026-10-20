import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentExecutorProfile, FreeReviewCheckMode, FreeReviewExecutorOverride, ReviewerProfile } from "@ash/shared";
import { MAX_FREE_REVIEW_RETRIES } from "@ash/shared/free-workflow";
import { CheckCircle, MagnifyingGlass, Plus, SpinnerGap, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { registeredAgentTypes } from "../lib/agentAvailability.ts";
import { reviewerDeleteMessage, settledDisputeRounds } from "./freeReviewCopy.ts";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { reviewerProfilesStore } from "./reviewerProfilesStore.ts";
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
  // 清单只从资源层来（`reviewerProfilesStore.ts`）：这个组件绝不自己拼清单 —— 某个闭包里
  // 捕获的那份旧清单会把别处刚删掉的那位贴回去。写操作只管调资源层，新清单由订阅送达。
  const [reviewers, setReviewers] = useState<ReviewerProfile[]>(() => reviewerProfilesStore.current() ?? []);
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ReviewerProfile | null>(null);
  /*
   * 这个对话框里有两样东西，生命周期完全不同，必须分开管，别拿一个去挡另一个：
   *
   * ① **草稿**（选中谁、检查类型、轮数、附言、执行器覆盖、新建表单）属于「某个任务的
   *    某一次打开」。它只按 taskId 初始化一次：远端预约字段在对话框开着的时候照样会变
   *    （别的页面改了预约、自动复审推进了一轮、在这里删掉被预约引用的那位审查者——服务端
   *    会顺手撤掉预约），那都不等于「用户重新打开了对话框」，正在写的草稿不是已经保存的
   *    旧预约。反过来，**任务一旦被换掉**（浏览器后退、侧栏切任务；容器没有按 task.id
   *    重建组件），这份草稿就不再属于当前任务了，必须整套重来 —— 否则会把给 A 写的附言
   *    保存到 B 身上。所以这里记的是「为哪个任务初始化过」，不是一个布尔开关。
   *
   * ② **审查者清单**是一份**全局配置**，别的页面（设置页就有删除入口）随时能删掉其中一
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
   * 不做这道门禁的后果（实测）：在 A 删掉选中的审查者，等 DELETE 响应期间后退到 B，B 刚
   * 初始化好的选择会被 A 这次删除改掉，点「保存预约」就把错的那位写给了 B。
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
  const refocusAfterDelete = useRef(false);
  // 表单摊开的前提：**这个任务**的状态和审查者清单都到齐了。少一样都不许开放编辑 ——
  // 在还没有真实状态的空表单上写的东西，等状态到了会被那一次初始化整套盖掉。
  const ready = initializedFor === taskId && !loading;
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

  // ② 任务一换，上一轮在飞的写操作就不再属于这个对话框：忙碌态和删除确认框立刻让位。
  //    否则新任务的对话框会顶着一个关不掉的「忙」——右上角那颗关闭按钮也是 disabled={busy}。
  useEffect(() => {
    setBusy(false);
    setDeleteTarget(null);
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
      // 本机刚按下的那次删除自己会报「已删除审查者「X」」，别再叠一条。
      if (source === "remote") notify(`原先选中的审查者已被删除，已替你改选「${fallback.name}」`);
      return;
    }
    setSelectedId("");
    setRunDraft(reviewerRunDraft(null));
    setSaveMode("once");
    setNewName("");
    setCreating(true);
    if (source === "remote") notify("审查者已被删除，请先新建一位再派审");
  }), [notify]);

  // 删成功那一下，原来那颗删除按钮已经不在了；确认框只在「原来那个元素还连着」时才还
  // 焦点，于是焦点掉到 body 上，键盘就从对话框里掉了出去。给它补一个落点：对话框本身。
  useEffect(() => {
    if (deleteTarget || !refocusAfterDelete.current) return;
    refocusAfterDelete.current = false;
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
  }, [deleteTarget]);

  const create = async () => {
    if (!draft.name.trim() || busy) return;
    const token = identity();
    setBusy(true);
    try {
      const created = await reviewerProfilesStore.create(reviewerPayload(draft, profiles));
      // 配置是真建出来了，所以这句话无论如何都得说；但「顺手选中它」只对发起时那份草稿成立。
      if (!mine(token)) { notify(`已创建审查者「${created.name}」`); return; }
      selectReviewer(created);
      setCreating(false);
      notify(`已创建并选中审查者「${created.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "审查者创建失败");
    } finally {
      if (mine(token)) setBusy(false);
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
    // 确认框里的那一位，不是「现在的 deleteTarget」：await 之后它随时可能已经是别的东西。
    const target = deleteTarget;
    const token = identity();
    setBusy(true);
    try {
      await reviewerProfilesStore.remove(target.id);
      // 新清单和「选中的那位没了怎么办」都由资源层 + ③ 的订阅收口 —— 这里一个字都不自己
      // 拼。拿发起时捕获的那份清单算 rest 会把这中间别处删掉的那位贴回去，拿发起时的
      // selectedId 判断又会漏掉「当前选中的其实也刚被删」。
      notify(`已删除审查者「${target.name}」`);
      // 删完要收的尾只属于这一次打开：关掉确认框、把焦点收回对话框。
      if (!mine(token)) return;
      refocusAfterDelete.current = true;
      setDeleteTarget(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "审查者删除失败");
    } finally {
      if (mine(token)) setBusy(false);
    }
  };

  const submit = async () => {
    if (!selectedId || busy || !ready) return;
    // 草稿属于「这个任务的这一次打开」。任务在对话框开着的时候被换掉（浏览器后退、侧栏切
    // 任务——容器没有按 task.id 重建组件），这份草稿就不再属于当前任务了，绝不能拿它去
    // 提交：那会把写给 A 的附言保存到 B 身上。重新初始化期间这里只是挡一下，等它完成。
    if (initializedForRef.current !== taskId) {
      notify("任务已经切换，正在重新读取这项任务的审查配置");
      return;
    }
    if (retryLimitInvalid) {
      notify(`自动复审轮数必须是 0-${MAX_FREE_REVIEW_RETRIES} 的整数`);
      return;
    }
    if (runChanged && saveMode === "new" && !newName.trim()) {
      notify("请先给新审查者起个名字");
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
      // 三种去向的共同点：这一次审查一定按改后的配置跑。前两种把改动落进审查者配置
      // （落完就是它自己的配置，不必再带覆盖），「仅本次使用」才走 override。
      const payload = runChanged ? reviewerRunPayload(runDraft, profiles) : null;
      let reviewerId = intended;
      let override: FreeReviewExecutorOverride | null = null;
      if (payload && saveMode === "overwrite") {
        await reviewerProfilesStore.update(intended, payload);
      } else if (payload && saveMode === "new") {
        const created = await reviewerProfilesStore.create({ name: newName.trim(), ...payload });
        // 清单由资源层送达；只有「把选中项挪到新建的那位」属于这一次打开的草稿。
        if (mine(token)) setSelectedId(created.id);
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
      // 这条请求冲着发起时那个任务发（`taskId` 是那一次渲染里的值），所以它该跑完就跑完。
      const next = postMerge
        ? await api.dispatchPostMergeReview(taskId, input)
        : reservationMode
          ? await api.reserveFreeReview(taskId, input)
          : await api.dispatchFreeReview(taskId, input);
      const name = reviewerId === intended
        ? reviewers.find((item) => item.id === intended)?.name ?? "审查者"
        : newName.trim();
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
        {!ready ? (
          <div className={`free-review-loading${loadError ? " is-error" : ""}`}>
            {loadError
              ? <><WarningCircle size={15} />{loadError}<button type="button" onClick={() => { setLoadError(null); setLoading(true); setReloadToken((value) => value + 1); }}>重试</button></>
              : <><SpinnerGap size={15} className="is-spinning" />{hasState ? "正在读取审查者…" : "正在读取任务状态…"}</>}
          </div>
        ) : (
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
          <button className="is-primary" type="submit" aria-keyshortcuts={sendKeys.ariaShortcut} disabled={busy || !ready || !selectedId || retryLimitInvalid}>
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
