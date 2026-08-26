import { useEffect, useMemo, useRef, useState } from "react";
import type { HandoffPeerOffline, HandoffRemoteState, HandoffTarget, TaskListItem } from "@ash/shared";
import { api } from "../lib/api.ts";
import { applyRemoteStates, handedOut, peersOf, remoteStateMap } from "./outboundStateModel.ts";

// 接力出去的任务，在本机那一行的 status 停在**交出去那一刻**（导出前会先停掉任务，所以
// 多半是 canceled）。对端后来跑完没有、有没有卡在提问上，本机一个字都不知道。
//
// 侧栏要把这些行跟本机任务同等对待 —— 同一份列表、同一颗状态点、同一套筛选 —— 前提就是
// 先把真状态问回来，否则等于把一批冻住的假状态铺在最该可信的那个列表里。所以这里定时
// 问一次持有机（只问状态，会话内容仍走点开时的 remote-snapshot）。
//
// 20 秒一轮：接力出去的任务本机插不上手，看的是「它那边到哪一步了」，不是秒级跟随；
// 一轮要跨机器往返，问太勤只会在对端上堆请求。**没有出站任务就一次都不问。**
//
// 合并判据（每轮整份重建、问不到就没有实时状态）在 outboundStateModel.ts，那里有测试钉着。
const POLL_MS = 20_000;

export { handedOut };

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
        setStates(remoteStateMap(result.rows));
        setOffline(result.offline);
      }).catch((reason) => {
        // 连本机这个接口都没应答（对端一台都问不着、或者本机 server 还是旧版本没这个
        // 路由）：那就是**每一台**持有机的状态都问不到。实时状态一并清空，再把这句话
        // 说出来 —— 留着上一轮的状态又写着「联系不上」，是自己打自己。
        if (!alive) return;
        setStates(new Map());
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

  const merged = useMemo(() => applyRemoteStates(tasks, states), [states, tasks]);

  return { tasks: merged, targets, offline };
}
