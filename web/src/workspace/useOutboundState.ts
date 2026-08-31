import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HandoffPeerOffline, HandoffRemoteState, HandoffTarget, TaskListItem } from "@ash/shared";
import { api } from "../lib/api.ts";
import { applyRemoteStates, handedOut, peersOf, remoteStateMap } from "./outboundStateModel.ts";

// 接力出去的任务，在本机那一行的 status 停在**交出去那一刻**（导出前会先停掉任务，所以
// 多半是 canceled）。对端后来跑完没有、有没有卡在提问上，本机一个字都不知道。
//
// 要看真状态就得跨机器问一次持有机。**这一问是用户按出来的，不再自动轮询**
// （用户 2026-08-31 拍板）。
//
// 原来是 20 秒一轮，只要页面开着就一直发。三个问题，一个比一个实：
//   ① 它是**跨机器**请求。一条 8 月接力出去、早就验收完的任务，让本机每 20 秒去敲一次
//      别人的服务器 —— 对面看到的就是一台机器在没完没了地连它。
//   ② 收口了的任务永远不会再变，问一万次也是同一个答案。
//   ③ 那条请求带机器签名，而对端原来会把它记成一次「接力申请」（已修，见
//      server/src/handoff-peers.ts touchPeer）——两件事叠在一起，就是「我没申请过接力，
//      却天天收到自己发来的申请」。
//
// 现在的语义很直白：出站行默认显示**接力当时**的状态，旁边一句话说清这一点，用户想知道
// 现在怎么样了就点一次「问一次」。合并判据（每轮整份重建、问不到就没有实时状态）在
// outboundStateModel.ts，那里有测试钉着。

export { handedOut };

export type OutboundState = {
  /** 合并了对端实时状态的任务列表；没问过、或没问到的行原样返回（同一个对象引用）。 */
  tasks: TaskListItem[];
  /** 接力目标机，点开出站行时要靠它连去对端（settings 里那份）。 */
  targets: HandoffTarget[];
  /**
   * 现在就把接力设置重取一遍，并返回取到的那份。
   *
   * 上面那份 `targets` 是**缓存**，而地址是用户在设置页随手就改的东西（改完还会把记住的
   * 指纹一起清掉）。真要拿它去连对端之前得先刷一次：后端解析持有机用的是**当前**设置，
   * 前端拿着一份旧地址发过去，只会换回一个「持有机与请求目标不一致」的 409 —— 屏幕上
   * 就成了「状态看着恢复了，点开却打不开」。
   */
  refreshTargets: () => Promise<HandoffTarget[]>;
  /** 问一次持有机。这是唯一会发出跨机器请求的入口，只由用户的点击触发。 */
  refreshRemote: () => Promise<void>;
  /** 正在问。按钮据此转圈并防重入。 */
  refreshing: boolean;
  /** 问到过一次没有。false = 出站行显示的是接力当时的状态，界面要如实说出来。 */
  asked: boolean;
  /** 这一轮联系不上的持有机：它们上面的行只能显示接力当时的旧状态，得如实说出来。 */
  offline: HandoffPeerOffline[];
};

export function useOutboundState(tasks: TaskListItem[]): OutboundState {
  const [states, setStates] = useState<Map<string, HandoffRemoteState>>(new Map());
  const [offline, setOffline] = useState<HandoffPeerOffline[]>([]);
  const [targets, setTargets] = useState<HandoffTarget[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [asked, setAsked] = useState(false);
  // effect 的身份只看「有哪些行交出去了」。跟着 tasks 本身走的话，任何一个任务的
  // updatedAt 一动（跑起来的任务每秒都在动）就会重跑一遍。
  const outbound = useMemo(() => tasks.filter(handedOut), [tasks]);
  const outboundKey = useMemo(() => outbound.map((task) => task.id).sort().join(","), [outbound]);
  // 手动那一问要读最新的那批出站行，但它不该进任何依赖数组。
  const outboundRef = useRef(outbound);
  outboundRef.current = outbound;

  // 出站集合变了（切项目、删了行）就把上一轮的答案丢掉：那是**另一批行**的状态，
  // 留着就是拿旧答案盖新问题。
  useEffect(() => {
    setStates(new Map());
    setOffline([]);
    setAsked(false);
  }, [outboundKey]);

  const refreshRemote = useCallback(async () => {
    if (!outboundRef.current.length) return;
    setRefreshing(true);
    try {
      const result = await api.outboundState();
      setStates(remoteStateMap(result.rows));
      setOffline(result.offline);
    } catch (reason) {
      // 连本机这个接口都没应答（对端一台都问不着、或者本机 server 还是旧版本没这个
      // 路由）：那就是**每一台**持有机的状态都问不到。实时状态一并清空，再把这句话
      // 说出来 —— 留着上一次的状态又写着「联系不上」，是自己打自己。
      setStates(new Map());
      setOffline(peersOf(outboundRef.current, reason));
    } finally {
      setAsked(true);
      setRefreshing(false);
    }
  }, []);

  // 目标机清单读的是**本机**接口（`/handoff/targets`），不跨机器，所以它照常自动拉：
  // 点开出站行要靠它连对端，等用户先点一次刷新才有地址是说不通的。
  //
  // 读它而不是设置里那份公共清单：多人模式下目标机**按人存**(§十一)，后端认持有机用的
  // 就是这一份。读公共那份的话，多人模式下前端会拿着一张空表去认持有机 —— 状态问得回来，
  // 点开却说「请在持有它的机器上继续」。自用模式下这条接口回的就是设置里那份。
  const refreshTargets = useCallback(async (): Promise<HandoffTarget[]> => {
    const latest = await api.handoffTargets();
    setTargets(latest);
    return latest;
  }, []);

  useEffect(() => {
    if (!outboundKey) { setTargets([]); return; }
    void refreshTargets().catch(() => {});
  }, [outboundKey, refreshTargets]);

  const merged = useMemo(() => applyRemoteStates(tasks, states), [states, tasks]);

  return { tasks: merged, targets, refreshTargets, refreshRemote, refreshing, asked, offline };
}
