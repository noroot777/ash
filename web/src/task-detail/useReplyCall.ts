import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentExecutorProfile, AgentType, DiscussionRounds } from "@ash/shared";
import { sameExecutor } from "@ash/shared/executors";
import { api } from "../lib/api.ts";
import type { AgentModelSelection, MentionTarget } from "./mentionPicker.ts";
import {
  initialVerb, isSelfCall, readDiscussRounds, rememberCall, rememberDiscussRounds, rememberedTarget, toggleDiscussPerson,
  type BaseContext, type CallAbility, type CallVerb, type DispatchBase, type ReplyCall,
} from "./replyCall.ts";

/**
 * 回复框里叫了谁、来做什么（纯逻辑在 replyCall.ts）。叫人只活在这一个框里：换任务、发出去、点小叉
 * 都清掉；正文、附件不归它管，换做法、取消叫人一个字都不动。
 */
export function useReplyCall({ ownAgent, ability, profiles, state }: {
  /** 这条任务自己的执行器：叫它只能派出去。 */
  ownAgent: AgentType;
  /** 这里能不能派出去、能不能开讨论（普通的独立任务才能）。 */
  ability: CallAbility;
  profiles: AgentExecutorProfile[];
  /** 叫人的状态放在外面（新建框放进草稿，面板卸载了还在）；不给就活在这个组件里。 */
  state?: [ReplyCall | null, Dispatch<SetStateAction<ReplyCall | null>>];
}) {
  const { dispatchable } = ability;
  const local = useState<ReplyCall | null>(null);
  const [call, setCall] = state ?? local;
  // 记下的执行器后来被删了：退回「这个执行器类型的默认」，别把一个不存在的 id 发出去。
  const known = (target: MentionTarget): MentionTarget => (
    target.executorId && profiles.length && !profiles.some((profile) => profile.id === target.executorId)
      ? { ...target, executorId: null } : target
  );
  const selfOf = (agent: AgentType) => isSelfCall(agent, ownAgent);
  // `/派` 时还没叫过人：先开 `@` 菜单让选，这次选中的那一个直接停在「派出去」。这份预选只属于这一次
  // 选人：菜单开过又收起（Esc、删掉 @、改选文件 / 随手记）就作废，不留给之后的普通 `@`。
  const pending = useRef<{ verb: CallVerb; opened: boolean } | null>(null);
  const pend = (verb: CallVerb) => { pending.current = { verb, opened: false }; };
  /** 接 `@` 菜单开没开着。 */
  const picking = (open: boolean) => {
    const current = pending.current;
    if (!current) return;
    if (open) current.opened = true;
    else if (current.opened) pending.current = null;
  };

  const fresh = (target: MentionTarget, verb: CallVerb): ReplyCall => ({ target, verb, base: "here", others: [], rounds: readDiscussRounds() });
  const start = (agent: AgentType, prefer: CallVerb | null = null) => {
    const verb = pending.current?.verb ?? prefer;
    pending.current = null;
    setCall(fresh(known(rememberedTarget(agent)), initialVerb(selfOf(agent), verb, ability)));
  };
  /** 撤回一条排着的召唤：放回当初叫的那一套。 */
  const restore = (target: MentionTarget) => setCall(fresh(target, "ask"));
  // 自己按不动「问一句」「讨论」（框顶那一行写着原因）；离开讨论就只剩胶囊上那一个人。
  const setVerb = (verb: CallVerb) => setCall((current) => (
    !current || (selfOf(current.target.agent) && (verb === "discuss" || (verb === "ask" && dispatchable))) ? current
      : { ...current, verb, others: verb === "discuss" ? current.others : [] }
  ));
  /** 讨论时在「和谁」那一段里点一个人（加上 / 放掉，见 toggleDiscussPerson）。这条任务自己的执行器不算。 */
  const togglePerson = (agent: AgentType) => setCall((current) => (
    !current || selfOf(agent) ? current
      : { ...current, ...toggleDiscussPerson(current, agent, (next) => known(rememberedTarget(next))) }
  ));
  const setRounds = (rounds: DiscussionRounds) => {
    rememberDiscussRounds(rounds);
    setCall((current) => (current ? { ...current, rounds } : current));
  };
  const setBase = (base: DispatchBase) => setCall((current) => (current ? { ...current, base } : current));
  // 胶囊上换人 / 换模型：执行器没换就把已选的智能水平留着，换了执行器才清成「跟随」（旧档位在新 CLI 上
  // 多半根本不存在）。换成这条任务自己的执行器，就只剩「派出去」。
  const commitTarget = (next: AgentModelSelection) => setCall((current) => {
    if (!current) return current;
    const kept = sameExecutor(
      { agentType: next.agent, executorId: next.executorId },
      { agentType: current.target.agent, executorId: current.target.executorId },
    );
    const self = dispatchable && selfOf(next.agent);
    return {
      ...current,
      target: { ...next, reasoningEffort: kept ? current.target.reasoningEffort : null },
      verb: self ? "dispatch" : current.verb,
      others: self ? [] : current.others.filter((item) => item.agent !== next.agent),
    };
  });
  const commitEffort = (effort: string) => setCall((current) => (
    current ? { ...current, target: { ...current.target, reasoningEffort: effort || null } } : current
  ));
  const cancel = () => {
    pending.current = null;
    setCall(null);
  };
  /** 这个人不再能叫了（新建框里胶囊换成了他，他就是跑这条任务的那个）：从叫着的人里拿掉，一个不剩就不叫了。 */
  const drop = (agent: AgentType) => setCall((current) => {
    if (!current) return current;
    const rest = [current.target, ...current.others].filter((item) => item.agent !== agent);
    if (rest.length === current.others.length + 1) return current;
    return rest.length ? { ...current, target: rest[0]!, others: rest.slice(1) } : null;
  });
  /**
   * 发出去了：记住叫的是谁、对他用的那一套，下次叫他（或 `/派`）先摆这一套。只清发出去的那一版——
   * 每一处改动（换人、换做法、换开工位置）都换一个新对象，发送途中动过就是下一句的设置，整份留着。
   */
  const remember = (snapshot: ReplyCall) => {
    for (const other of snapshot.others) rememberCall(other);
    rememberCall(snapshot.target);
  };
  const sent = (snapshot: ReplyCall) => {
    remember(snapshot);
    setCall((current) => (current === snapshot ? null : current));
  };

  return {
    call,
    self: !!call && (dispatchable || ability.discussable) && selfOf(call.target.agent),
    start, pend, picking, restore, setVerb, setBase, togglePerson, setRounds, commitTarget, commitEffort, cancel, drop, sent,
    /** 只记住这一套、不动叫着的人（新建框：叫的人跟草稿一起由提交结算去清，见 DraftStore 的 settleSubmission）。 */
    remember,
  };
}

/**
 * 派出去时「从哪开工」要的那几样：是不是仓库、有哪些分支、新任务默认开不开 worktree。每次进到「派出去」
 * 现取一次（项目配置、分支随时会变），离开就丢掉。
 *
 * 读不到（任何一样失败）就是 failed，不是「没得选」：那时不知道「接着这里的代码」在哪，按默认发出去会
 * 悄悄从别的代码开工，所以拦着不让派，给一颗重试。
 */
export type DispatchBaseLoad =
  | { status: "loading"; value: null; error: null }
  | { status: "ready"; value: BaseContext; error: null }
  | { status: "failed"; value: null; error: string };

export function useDispatchBaseContext(projectId: string, active: boolean): DispatchBaseLoad & { retry: () => void } {
  type Loaded = { projectId: string; value: BaseContext; error: null } | { projectId: string; value: null; error: string };
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const load = useCallback(async (): Promise<Loaded> => {
    try {
      const [health, branches, projects] = await Promise.all([api.projectHealth(projectId), api.projectBranches(projectId), api.projects()]);
      const project = projects.find((item) => item.id === projectId);
      return { projectId, value: { isRepo: health.isRepo, ...branches, worktreeDefault: project?.useWorktreeDefault ?? true }, error: null };
    } catch (error) {
      return { projectId, value: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [projectId]);
  const key = active && loaded?.projectId === projectId ? loaded : null;
  useEffect(() => {
    if (!active) { setLoaded(null); return; }
    if (key) return;
    let alive = true;
    void load().then((next) => { if (alive) setLoaded(next); });
    return () => { alive = false; };
  }, [active, key, load]);
  const retry = useCallback(() => setLoaded(null), []);
  if (!key) return { status: "loading", value: null, error: null, retry };
  return key.value ? { status: "ready", value: key.value, error: null, retry } : { status: "failed", value: null, error: key.error!, retry };
}
