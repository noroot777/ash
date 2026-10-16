// 任务上挂着的哨兵：界面这一侧的数据源。
//
// 为什么它必须有界面：哨兵的进程是**故意脱离 ash** 的（agent 回合结束、会话结束、
// server 重启都带不走它），代价就是「有个进程在后台跑着」这件事再没有别的地方看得见。
// 只在 agent 的对话里说一句「已起哨兵」不算数——刷新页面后就什么都不剩了。
import { useCallback, useEffect, useRef, useState } from "react";
import type { MonitorRecovery, MonitorWakeTarget, TaskMonitor } from "@ash/shared/monitor";
import { ApiError, api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

export const MONITOR_ENDED_LABEL: Record<string, string> = {
  exited: "命令自己跑完了",
  expired: "盯满时长",
  stopped: "已停止",
  lost: "进程已不在",
};

/**
 * 「这个任务用过哨兵没有」——图标条浮现与否的判据，**两种来源一起算**。
 *
 * 只数 ash 自己那种的话，claude 执行器的任务会永远不浮现：它们几乎全程用 claude 自带的
 * Monitor（CLI 提示词把长等待主动往那边引），ash 这一侧一条记录都没有。而那恰恰是最需要
 * 这一格的场景——agent 在对话里说「等 Monitor 通知」，用户得有地方对账。
 */
export const monitorUsedCount = (monitors: readonly TaskMonitor[]) => monitors.length;

export interface StartMonitorInput {
  command: string;
  description?: string;
  timeoutMs?: number;
  /**
   * **醒来叫谁**。平时不填:服务端按已核验的调用来源自己判(见 server 的 monitor-session.ts)。
   * 只有它回「说不清叫谁」(`needsWakeTarget`)时才要带 —— 那是「这个任务上有一次审查正在
   * 进行，而手动挂的哨兵不属于任何一条会话」那一幕,只能由人说清。
   */
  wake?: MonitorWakeTarget;
}

export type TaskMonitorsState = ReturnType<typeof useTaskMonitors>;

export function useTaskMonitors(taskId: string) {
  const [monitors, setMonitors] = useState<TaskMonitor[]>([]);
  /**
   * 「这份列表读完了没有」。
   *
   * 面板为空有**三种**完全不同的含义，一种都不能混进另一种（第 6 轮要求分开前两种，第 7 轮
   * 实测第三种被当成了第二种）：
   *
   * ① 还没读完（`recovery.pending`）——扫描撞上单次上限、会话文件读不开、有记录没落库……
   * ② 确实没用过哨兵（`recovery` 非空且 `pending:false`）；
   * ③ **不知道**（`recovery === null`）——这份状态自己都没读到。把它当成 ② 就又把「未确认」
   *    说成了「没有」，而这正是整个功能起点那一幕。
   */
  const [recovery, setRecovery] = useState<MonitorRecovery | null>(null);
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 报错连同**它是谁的、从哪来的**一起存。
   *
   * 归属（`taskId`）不能借用列表那把闸：列表的 `ready` 回答的是「这个任务有没有哨兵」，
   * 而创建/停止的失败是用户**刚刚按下去**的动作的回执，跟列表读没读完没有半点关系。
   * 借用的后果是慢网下点「起一个哨兵」失败后一片安静——按钮已解锁、草稿还在，用户只会
   * 以为自己没点到（第 2 轮审查实测）。
   *
   * 来源（`kind`）决定谁能清掉它：列表重读成功只收走自己那条「读列表失败」，不许顺手把
   * 用户动作的回执也抹了——那种抹法会让报错只闪一下，慢网下往往闪都来不及。
   */
  const [failure, setFailure] = useState<{
    taskId: string;
    kind: "list" | "action";
    message: string;
    /** 服务端说「说不清这个哨兵醒来该叫谁」:表单据它长出那个二选一(见 `needsWakeTarget`)。 */
    needsWake?: boolean;
  } | null>(null);
  // 挂 useCallback 并进下面几个回调的依赖表：它闭包里带着 `taskId`，漏进依赖表的话
  // 那几个记忆化回调会攥着上一个任务的那份，报错就贴到别人身上去了。
  const failed = useCallback((kind: "list" | "action", reason: unknown) => setFailure({
    taskId,
    kind,
    message: reason instanceof Error ? reason.message : String(reason),
    // 这一条拒绝**有出路**:它不是「挂不了」,是「还没说清叫谁」。把这个事实带出去,表单
    // 才能长出那个二选一 —— 只回一句错误文案的话,手动挂哨兵在这种任务上就成了死胡同。
    needsWake: reason instanceof ApiError
      && typeof reason.body === "object" && reason.body !== null
      && "needsWakeTarget" in reason.body && reason.body.needsWakeTarget === true,
  }), [taskId]);
  /**
   * 这份列表**是哪个任务的**。`setMonitors([])` 是 effect 做的，而 effect 跑在渲染之后：
   * 切任务那一帧，渲染读到的还是上一个任务的列表。平时顶多闪一下旧卡片，但这一帧恰好
   * 是 InspectorHost 按新 contextKey 重挂的那一帧——它据此算出的 `defaultOpen` 会被
   * `defaultState` 写进 openTabs、被 `knownTabIds` 记成「这一格出现过」，两样都没有撤销
   * 路径，本任务真实的应答回来也纠正不了（第 1 轮审查实测：上一个任务挂着哨兵就会给
   * 从没用过的任务凭空多一格并存进 localStorage；反过来，离开期间才挂上哨兵的任务切
   * 回来时那一格再也不冒出来）。所以归属必须在**渲染返回那一层**判，跟 useConversation
   * 的 `loadedTaskId` 同一套：不属于当前任务的数据一概当「还没读到」。
   */
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  /**
   * 「现在是哪个任务、这是它的第几次读取」。
   *
   * 宿主组件跨任务复用（切任务不重挂载），而 `setMonitors([])` 只能清掉当下那一份值、
   * 撤不回已经发出去的请求：网慢的时候从 A 切到 B，A 的迟到响应会原样盖在 B 的面板上
   * ——而那张列表每一行都带着「停掉」按钮，点下去真停的是 A 的活（第 1 轮审查实测：
   * 标题、侧栏、地址栏全是 B，停掉的是 A 的哨兵）。
   *
   * 三样各管一件事，缺一不可：
   * - `taskId` 管**出门前**。`stop`/`start` 收尾时调的 `reload` 是它们被创建那一刻的
   *   那份闭包，里面带的是旧 taskId；切走之后它才跑到这一句，就会去读上一个任务的列表
   *   然后堂堂正正地写进当前面板（事后再比代号也认不出来——代号是它自己出门时取的）。
   * - `gen` 管**跨任务的迟到响应**：换任务时 +1，让在途的那些回来时作废。
   * - `seq` 管**同一任务内乱序回来的旧响应**：每次发起 +1。
   */
  const stamp = useRef({ gen: 0, seq: 0, taskId: "" });

  const reload = useCallback(async () => {
    if (stamp.current.taskId !== taskId) return;
    const gen = stamp.current.gen;
    const seq = ++stamp.current.seq;
    const mine = () => stamp.current.gen === gen && stamp.current.seq === seq;
    try {
      // 两条一起问。恢复状态单独一条端点（理由见 monitor-routes.ts），服务端那一侧会等同
      // 一次回填跑完，所以两份响应反映同一轮扫描。
      //
      // **只有 404 才算「这个服务端没有这个概念」**（新前端配旧 server）。其它失败是「不
      // 知道」，必须如实留成 null——上一版一律 catch 成 null 并当作 `pending:false`，等于
      // 把暂态读失败说成「确实没有待恢复的」（第 7 轮审查）。
      const [next, pending] = await Promise.all([
        api.taskMonitors(taskId),
        api.monitorRecovery(taskId).then(
          (value): MonitorRecovery | null => value,
          (reason): MonitorRecovery | null => (
            reason instanceof ApiError && reason.status === 404
              ? { pending: false, reasons: [], attempts: 0, exhausted: false }
              : null
          ),
        ),
      ]);
      if (!mine()) return;
      setMonitors(next);
      setRecovery(pending);
      // 只收走自己那条。用户动作的回执不归它管——抹掉就等于那句话只闪了一下。
      setFailure((current) => (current?.kind === "list" ? null : current));
      setLoadedTaskId(taskId);
    } catch (reason) {
      if (!mine()) return;
      failed("list", reason);
      // 读失败也算「这一轮读完了」：`ready` 说的是「这一轮有没有结束」而不是「有没有成功」
      // （跟 useConversation 同义）。少了这句，读失败的任务会永远停在「还没读到」。
      setLoadedTaskId(taskId);
    }
  }, [failed, taskId]);

  useEffect(() => {
    // 换任务：在途的那些请求当场作废，它们回来时已经不是「这个任务的列表」了。
    stamp.current = { gen: stamp.current.gen + 1, seq: 0, taskId };
    setMonitors([]);
    setRecovery(null);
    setFailure(null);
    setStoppingIds(new Set());
    void reload();
  }, [reload, taskId]);

  // 权威信号只有服务端这一条：起了、推了一批、结束了，都发 task.monitors。
  const connected = useServerEvents((event) => {
    if (event.type !== "task.monitors" || event.taskId !== taskId) return;
    void reload();
  });

  /**
   * **每次连上都重新对账一遍**（第 11 轮审查 F2）。
   *
   * 「又连上了」不等于「这份快照还完整」：事件流没有历史回放（server/src/routes.ts 只订阅
   * 当前 bus、不带事件 id、没有 Last-Event-ID），断线期间起的哨兵、结束的哨兵、变化的恢复
   * 状态一条都补不回来，于是页面停在旧列表上，手动刷新才对得上（审查用真实 EventSource
   * 断线重连 + 真页面实测：open 次数增加、请求数一条没多、卡片数不变）。
   *
   * 首次连上也要对一次：挂载时那一发列表请求和事件流的建立是并发的，中间那段的事件同样
   * 没人接。重读走的是同一套 gen/seq 保护，旧响应盖不了新的。
   */
  const linked = useRef(connected);
  useEffect(() => {
    const was = linked.current;
    linked.current = connected;
    if (connected && !was) void reload();
  }, [connected, reload]);

  const stop = useCallback(async (monitorId: string) => {
    const gen = stamp.current.gen;
    setStoppingIds((current) => new Set(current).add(monitorId));
    setFailure(null);
    try {
      await api.stopMonitor(monitorId);
      await reload();
    } catch (reason) {
      // 切走之后才回来的失败不要往新任务的面板上贴：那句报错说的是上一个任务的事。
      if (stamp.current.gen === gen) failed("action", reason);
    } finally {
      setStoppingIds((current) => {
        const next = new Set(current);
        next.delete(monitorId);
        return next;
      });
    }
  }, [failed, reload]);

  /**
   * 手动起一个。成功返回 true，失败把原因留在 `error` 上——表单据此决定要不要收起来。
   *
   * **切走之后它一律返回 false**，哪怕服务端那一边真的起成功了。调用方拿 true 去做的
   * 唯一一件事是「把表单收起来」，而此刻屏幕上那张表单已经是**另一个任务**的了，里面
   * 往往还有没提交的草稿。它起没起成功由那个任务自己的列表去说，不该由一句跨任务的
   * 返回值去动当前的表单。
   *
   * 「正在创建中」这件事**故意不住在这里**：同一个任务上可以有一张在途的表单和一张刚
   * 重开的表单，而忙碌状态要回答的是「**这张**表单的提交按钮要不要锁」——按任务存就只有
   * 一个值，取消重开之后新表单照样被旧请求按住（第 3 轮审查实测：
   * reopenedBlockedByOldStart=true）。所以它归调用方按表单实例自己存。
   */
  const start = useCallback(async (input: StartMonitorInput): Promise<boolean> => {
    const gen = stamp.current.gen;
    const mine = () => stamp.current.gen === gen;
    setFailure(null);
    try {
      await api.startMonitor(taskId, input);
      await reload();
      return mine();
    } catch (reason) {
      if (mine()) failed("action", reason);
      return false;
    }
  }, [failed, reload, taskId]);

  // 列表和报错各判各的归属：列表问「读到的是不是当前任务的」（没读到就按空给，别拿上一个
  // 任务的列表去回答「这个任务有没有哨兵」——图标条的显隐就是照着这个问题走的）；报错只问
  // 「这句话是不是说当前任务的」，不等列表。
  const ready = loadedTaskId === taskId;
  return {
    monitors: ready ? monitors : [],
    /**
     * 恢复状态：`pending:true` = 还没读完；`pending:false` = 确实没有待恢复的；
     * **`null` = 不知道**（这一份自己都没读到）。归属判据同列表。
     */
    recovery: ready ? recovery : null,
    stoppingIds,
    error: failure?.taskId === taskId ? failure.message : null,
    /** 真 = 上一次提交被「说不清叫谁」拒了:表单要让人指定一个唤醒目标再来。 */
    needsWakeTarget: failure?.taskId === taskId && failure.kind === "action" && !!failure.needsWake,
    ready,
    start,
    stop,
    reload,
  };
}
