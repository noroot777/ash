// 「可以派出去的活」在回复框里的那一半：它借的是「等你裁定」那一套（ReplyOverride）——框顶那一行是它，
// 选中一件时这一个框就变成「补一句」，右下角那颗写着「派出去」，回车 = 带着这句话派出去。没选中时框照常发
// 普通消息。同一时刻框顶只有一行：`@` 了人、有驳回在等裁定时由 ReplyBox 让开它（让开不是丢掉，状态都还在）。
//
// 派出去交给 navi 照那一行此刻的样子建（server/src/dispatch-suggestion-launch.ts），这条任务的智能体不被叫醒，
// 所以它在跑时也照派。派掉、叉掉的那几件先在本地藏起来，不等服务端那一条广播回来。
// 一行只有三种去处：你派了、你叉了、智能体收回了（为什么收回写在会话里收回的那一刻，withdrawalNotes.ts）——没有自己消失的。
import { useEffect, useState } from "react";
import type { AgentType, Task } from "@navi/shared";
import { dispatchDefaultTarget, type DispatchRunTarget } from "@navi/shared/dispatch-target";
import type { DispatchOrder, DispatchSuggestionBase } from "@navi/shared/dispatch-suggestion";
import { concreteReviewChoice } from "@navi/shared/review-on-create";
import { api } from "../../lib/api.ts";
import { useLeftDrawer } from "../../components/LeftDrawer.tsx";
import { registeredAgentTypes } from "../../lib/agentAvailability.ts";
import { ReplyDockSend } from "../ReplyDock.tsx";
import type { ReplyOverride } from "../replyOverride.ts";
import { dispatchBaseOptions } from "../replyCall.ts";
import { useDispatchBaseContext } from "../useReplyCall.ts";
import { useExecutorProfiles } from "../useExecutorProfiles.ts";
import { reviewHold, useReviewerList } from "../../free-workflow/useReviewerList.ts";
import { SuggestionDock, type SuggestionRow } from "./SuggestionDock.tsx";
import { SuggestionDrawerBody, SuggestionDrawerEdit, SuggestionDrawerKind, SuggestionDrawerTitle } from "./SuggestionReader.tsx";
import {
  armedOf, editOf, editSuggestion, forgetSuggestions, publishViews, setArmed, useSuggestionStore,
} from "./suggestionStore.ts";

const DRAWER_KEY = "suggestion:";

/**
 * 两种开工起点（同回复框里「派出去」，replyCall.ts），主分支那一种排在前面。这条任务的分支已经没了（验收后清掉）
 * 时那份 helper 一种都不给，派出去就落到项目此刻检出的那一支；建议本来说的是「从主分支开工」，主分支还在就照它。
 */
function suggestionBaseOptions(task: Task, context: Parameters<typeof dispatchBaseOptions>[1]) {
  const trunkFirst = (id: string) => (id === "trunk" ? 0 : 1);
  const options = [...dispatchBaseOptions(task, context)].sort((left, right) => trunkFirst(left.id) - trunkFirst(right.id));
  if (options.length || !context?.isRepo || !context.worktreeDefault) return options;
  const trunk = task.mergeTargetBranch?.trim() || context.current;
  return trunk && trunk !== context.current && context.branches.includes(trunk)
    ? [{ id: "trunk" as const, label: `从 ${trunk} 开工`, worktreeBase: trunk }]
    : options;
}

export function useSuggestionDock({ task, enabled, value, setValue, attachments, uploading, snapshotSent, dispatchTarget, focus }: {
  task: Task;
  /** 这个框派得出去（普通任务、没归档）。 */
  enabled: boolean;
  value: string;
  setValue: (next: string) => void;
  attachments: string[];
  uploading: boolean;
  /** 记下此刻框里的字和图，交回一个「派成了就清掉它们」的函数（框里途中又写了的照留）。 */
  snapshotSent: () => () => void;
  /** 「派出去的活交给谁」此刻的值（null = 同这里）。 */
  dispatchTarget: DispatchRunTarget | null;
  focus: () => void;
}): ReplyOverride | undefined {
  useSuggestionStore();
  const drawer = useLeftDrawer();
  const { profiles } = useExecutorProfiles();
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [chosenOrder, setOrder] = useState<DispatchOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setOpen(false); setError(null); setOrder(null); }, [task.id]);

  const list = enabled ? (task.dispatchSuggestions ?? []).filter((item) => !gone.has(item.id)) : [];
  // 没动过就照挂的时候说定的（几件说定的不一样时同时）：上线前摆好「一个接一个」的老派活单照旧一个接一个。
  const order = chosenOrder ?? (list.length && list.every((item) => item.order === list[0]!.order) ? list[0]!.order : "parallel");
  const reviewers = useReviewerList(list.length > 0);
  const baseContext = useDispatchBaseContext(task.projectId, list.length > 0);
  const options = suggestionBaseOptions(task, baseContext.value);
  const bases = options.map((option) => ({ id: option.id as DispatchSuggestionBase, label: option.id === "here" ? "接着这条的代码" : option.label }));
  const fallback: DispatchRunTarget = dispatchDefaultTarget({ ...task, dispatchTarget })
    ?? { agentType: (task.agentType ?? "claude") as AgentType, executorId: null, model: null, reasoningEffort: null };
  const rows = list.map((item) => {
    const edit = editOf(item.id);
    const title = edit.title ?? item.title;
    const body = edit.body ?? item.body;
    const wanted = edit.base ?? item.base;
    const base = bases.some((option) => option.id === wanted) ? wanted : bases[0]?.id ?? wanted;
    // 卡上没换过就照智能体挂的时候说定的那一位（没说是默认审查者）。
    const review = edit.review ?? item.review ?? "default";
    return {
      id: item.id, title, body, note: item.note, target: edit.target ?? item.target ?? fallback, review,
      base, filled: !!title.trim() && !!body.trim(), reviewHeld: reviewHold(review, reviewers),
      // 挂的时候就说定了开工起点（上线前的老派活单）、卡上又没换过：不交，服务端照存着的那一个开工。
      keepBase: edit.base === undefined && item.worktreeBase !== undefined,
    };
  });
  const storedArmed = armedOf(task.id);
  const several = rows.length > 1;
  // 好几件、那一段收着时没有选中的（选中的那一行看不见）。
  const armedRow = several && !open ? null : rows.find((row) => row.id === storedArmed) ?? null;
  const readingId = drawer?.activeKey?.startsWith(DRAWER_KEY) ? drawer.activeKey.slice(DRAWER_KEY.length) : null;
  const held = !rows.length || baseContext.status === "ready" ? null
    : baseContext.status === "loading" ? "正在确认新任务从哪开工" : `没读到这个项目的分支，确认不了新任务从哪开工（${baseContext.error}）`;

  const nameOf = (target: DispatchRunTarget) => {
    const profile = profiles.find((item) => (target.executorId ? item.id === target.executorId : item.type === target.agentType && item.isDefault));
    return [profile?.name ?? target.agentType, target.model].filter(Boolean).join(" · ");
  };
  // 抽屉照着这一份画（它是开的那一刻交出去的，跟着这一行变靠订阅）。
  const views = rows.map((row) => ({
    id: row.id, taskId: task.id, title: row.title, body: row.body, who: nameOf(row.target),
    baseLabel: bases.find((option) => option.id === row.base)?.label ?? null,
    extra: armedRow?.id === row.id ? value : "",
  }));
  useEffect(() => publishViews(views));
  // 选中的那一件没了（派掉、叉掉、智能体收回），框回到平常；读着的那一件没了，抽屉跟着关。
  useEffect(() => {
    if (storedArmed && !armedRow) setArmed(task.id, null);
    if (readingId && !rows.some((row) => row.id === readingId)) drawer?.close();
  });

  const disarm = () => setArmed(task.id, null);
  const refocus = () => requestAnimationFrame(focus);
  const hide = (ids: string[], hidden: boolean) => setGone((current) => {
    const next = new Set(current);
    for (const id of ids) { if (hidden) next.add(id); else next.delete(id); }
    return next;
  });

  const launch = async (ids: string[], extra?: string): Promise<boolean> => {
    if (busy || held) return false;
    const picked = rows.filter((row) => ids.includes(row.id));
    if (!picked.length || picked.some((row) => !row.filled || row.reviewHeld)) return false;
    const reviews = picked.map((row) => concreteReviewChoice(row.review, reviewers.reviewers));
    if (reviews.some((review) => !review)) return false;
    setBusy(true);
    setError(null);
    try {
      await api.launchSuggestions(task.id, {
        order: several ? order : "parallel",
        items: picked.map((row, index) => ({
          id: row.id, title: row.title.trim(), body: row.body, extra, target: row.target, review: reviews[index]!,
          ...(row.keepBase ? {} : { worktreeBase: options.find((option) => option.id === row.base)?.worktreeBase ?? options[0]?.worktreeBase ?? null }),
        })),
        ...(extra !== undefined && attachments.length ? { attachments } : {}),
      });
      hide(ids, true);
      forgetSuggestions(ids);
      if (armedRow && ids.includes(armedRow.id)) disarm();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const drop = async (id: string) => {
    hide([id], true);
    if (armedRow?.id === id) disarm();
    try {
      await api.dropSuggestion(task.id, id);
      forgetSuggestions([id]);
    } catch (reason) {
      hide([id], false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const read = (id: string) => {
    if (!drawer) return;
    const key = `${DRAWER_KEY}${id}`;
    if (drawer.activeKey === key) return drawer.close();
    const title = rows.find((row) => row.id === id)?.title || "没写标题";
    drawer.open({
      key, kind: <SuggestionDrawerKind id={id} />, title: <SuggestionDrawerTitle id={id} />, actions: <SuggestionDrawerEdit id={id} />,
      ariaLabel: `完整说明：${title}`, closeLabel: "关上完整说明", body: <SuggestionDrawerBody id={id} />,
    });
  };
  const arm = (id: string) => {
    const next = armedRow?.id === id ? null : id;
    setArmed(task.id, next);
    if (readingId && readingId !== next) drawer?.close();
    refocus();
  };
  // 回车 / 右下角那颗：带着框里那句话（和贴的图）派出去；派成了框清空、回到平常。
  const submit = () => {
    if (!armedRow || uploading) return;
    const clear = snapshotSent();
    void launch([armedRow.id], value.trim()).then((sent) => { if (sent) clear(); });
  };

  if (!rows.length) return undefined;
  const label = armedRow ? `「${armedRow.title || "没写标题"}」` : "";
  const reason = !armedRow ? null : !armedRow.filled ? "标题或说明是空的，派不出去" : uploading ? "附件传完才能派" : held ?? armedRow.reviewHeld;
  return {
    head: (
      <SuggestionDock
        rows={rows as SuggestionRow[]}
        armedId={armedRow?.id ?? null}
        open={open}
        order={order}
        bases={bases}
        readingId={readingId}
        busy={busy}
        held={held}
        error={error ?? (baseContext.status === "failed" ? held : reviewers.failed ? rows.map((row) => row.reviewHeld).find(Boolean) ?? null : null)}
        types={registeredAgentTypes(profiles)}
        profiles={profiles}
        reviewers={reviewers}
        onArm={arm}
        onGo={(id) => void launch([id])}
        onDrop={(id) => void drop(id)}
        onRetarget={(id, target) => { editSuggestion(id, { target }); if (armedRow) refocus(); }}
        onReview={(id, review) => { editSuggestion(id, { review }); if (armedRow) refocus(); }}
        onBase={(id, base) => { editSuggestion(id, { base }); refocus(); }}
        onRead={read}
        onToggle={() => {
          setOpen((current) => !current);
          if (open) { disarm(); if (readingId) drawer?.close(); }
        }}
        onOrder={setOrder}
        onAll={() => void launch(rows.map((row) => row.id))}
        onEscape={() => { if (!armedRow) return false; disarm(); refocus(); return true; }}
      />
    ),
    take: armedRow ? {
      input: { value, placeholder: `给${label}补一句（可不写）…`, label: `给${label}补一句`, onChange: setValue },
    } : null,
    send: <ReplyDockSend label="派出去" busy={busy} disabled={!!reason} reason={reason} onSend={submit} />,
    submit,
    cancel: disarm,
    attachable: true,
    bare: !!armedRow,
  };
}
