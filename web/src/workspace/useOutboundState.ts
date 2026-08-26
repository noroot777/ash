import { useEffect, useMemo, useRef, useState } from "react";
import type { HandoffPeerOffline, HandoffRemoteState, HandoffTarget, TaskListItem } from "@ash/shared";
import { api } from "../lib/api.ts";

// 接力出去的任务，在本机那一行的 status 停在**交出去那一刻**（导出前会先停掉任务，所以
// 多半是 canceled）。对端后来跑完没有、有没有卡在提问上，本机一个字都不知道。
//
// 侧栏要把这些行跟本机任务同等对待 —— 同一份列表、同一颗状态点、同一套筛选 —— 前提就是
// 先把真状态问回来，否则等于把一批冻住的假状态铺在最该可信的那个列表里。所以这里定时
// 问一次持有机（只问状态，会话内容仍走点开时的 remote-snapshot）。
//
// 20 秒一轮：接力出去的任务本机插不上手，看的是「它那边到哪一步了」，不是秒级跟随；
// 一轮要跨机器往返，问太勤只会在对端上堆请求。**没有出站任务就一次都不问。**
const POLL_MS = 20_000;

export function handedOut(task: Pick<TaskListItem, "handoff">): boolean {
  return task.handoff?.direction === "out" && !task.handoff.pending;
}

// 出站行自己就记着持有机的地址和名字（接力时冻进 handoff 标记的），所以一台都问不到时
// 仍然报得出「联系不上谁」，不必等设置读回来。
function peersOf(tasks: TaskListItem[], reason: unknown): HandoffPeerOffline[] {
  const text = reason instanceof Error ? reason.message : String(reason);
  const peers = new Map<string, HandoffPeerOffline>();
  for (const task of tasks) {
    const url = task.handoff?.peerUrl;
    if (!url || peers.has(url)) continue;
    peers.set(url, { url, name: task.handoff?.peerName || url, reason: text });
  }
  return [...peers.values()];
}

export type OutboundState = {
  /** 合并了对端实时状态的任务列表；没接力出去的行原样返回（同一个对象引用）。 */
  tasks: TaskListItem[];
  /** 接力目标机，点开出站行时要靠它连去对端（settings 里那份）。 */
  targets: HandoffTarget[];
  /** 这一轮联系不上的持有机：它们上面的行只能显示接力当时的旧状态，得如实说出来。 */
  offline: HandoffPeerOffline[];
};

export function useOutboundState(tasks: TaskListItem[]): OutboundState {
  const [states, setStates] = useState<Map<string, HandoffRemoteState>>(new Map());
  const [offline, setOffline] = useState<HandoffPeerOffline[]>([]);
  const [targets, setTargets] = useState<HandoffTarget[]>([]);
  // effect 的身份只看「有哪些行交出去了」。跟着 tasks 本身走的话，任何一个任务的
  // updatedAt 一动（跑起来的任务每秒都在动）就会重开一轮跨机器轮询。
  const outbound = useMemo(() => tasks.filter(handedOut), [tasks]);
  const outboundKey = useMemo(() => outbound.map((task) => task.id).sort().join(","), [outbound]);
  // 轮询回调里要读最新的那批出站行，但它不能进 effect 的依赖 —— 那样每次 updatedAt
  // 变动都会重开一轮跨机器轮询。
  const outboundRef = useRef(outbound);
  outboundRef.current = outbound;

  useEffect(() => {
    if (!outboundKey) { setStates(new Map()); setOffline([]); return; }
    let alive = true;
    const pull = () => {
      api.outboundState().then((result) => {
        if (!alive) return;
        // 只覆盖问回来的那些。整轮失败（网络抖一下）就留着上一轮的状态，别把已知的
        // 真状态清成空白 —— 那会让行在「有状态」和「没状态」之间闪。
        setStates((current) => {
          const next = new Map(current);
          for (const row of result.rows) next.set(row.taskId, row);
          return next;
        });
        setOffline(result.offline);
      }).catch((reason) => {
        // 连本机这个接口都没应答（对端一台都问不着、或者本机 server 还是旧版本没这个
        // 路由）：那就是**每一台**持有机的状态都问不到。照样得说出来 —— 不说的话，
        // 屏幕上那几行显示的是接力当时冻住的状态，看着却跟实时状态一模一样。
        if (!alive) return;
        setOffline(peersOf(outboundRef.current, reason));
      });
    };
    pull();
    const timer = window.setInterval(pull, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [outboundKey]);

  useEffect(() => {
    if (!outboundKey) { setTargets([]); return; }
    let alive = true;
    api.settings().then((settings) => { if (alive) setTargets(settings.handoffTargets); }).catch(() => {});
    return () => { alive = false; };
  }, [outboundKey]);

  const merged = useMemo(() => {
    if (!states.size) return tasks;
    return tasks.map((task) => {
      const state = handedOut(task) ? states.get(task.id) : undefined;
      if (!state) return task;
      // 标题也一起接过来：对端起过自动标题、或者用户在那边改过名，本机存档还写着老的。
      return {
        ...task,
        status: state.status,
        stage: state.stage,
        question: state.question,
        title: state.title,
        updatedAt: state.updatedAt,
      };
    });
  }, [states, tasks]);

  return { tasks: merged, targets, offline };
}
