import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationItem } from "./conversationModel.ts";
import { api } from "../lib/api.ts";
import { type CatchUp, createCatchUp } from "../lib/catchUp.ts";
import { useServerEvents } from "../lib/events.ts";

export type RejectionRemedy = "reclaim-turn" | null;

// 被挡回的用户操作,作为**任务历史的一部分**读进来。
//
// 为什么不是只在对话流空的时候读:上一版就是那样,于是同一段历史有两种可见性 —— 任务一旦
// 跑出正文,这块整个卸载,第一次被拒的记录还在库里却再也显示不出来(第 2 轮审查 F4)。
// 「有没有正文」跟「这段历史该不该可见」没有关系,所以这里无条件读,由调用方按时间合进
// 同一条时间线。服务端也只存这一处(不再同时往会话正文写),两边不会重复。
export function useRejectionNotices(taskId: string, revision = 0): {
  items: ConversationItem[];
  remedy: RejectionRemedy;
  reload: () => void;
} {
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [remedy, setRemedy] = useState<RejectionRemedy>(null);
  const catchUp = useRef<CatchUp | null>(null);
  // 「该重读了」。**不清空、不翻 loading** —— 它是追平,不是换一份数据(见下面那段)。
  const reload = useCallback(() => catchUp.current?.run(), []);

  useEffect(() => {
    let live = true;
    // 切任务先清空:否则上一个任务的挡回会挂在新任务的时间线上。**只有这里清** ——
    // 「换了任务」是身份真的变了,而「重读一次」不是(见 reload)。
    setItems([]);
    setRemedy(null);
    // 读失败一律**保持原样并自己重试到读到**(第 1 轮审查 F6),策略与任务列表、验收卡
    // 共用同一份(`createCatchUp`)。上一版的失败分支是整个吞掉:items 已经被清成空、
    // remedy 已经被清成 null,于是「读失败」在界面上和「没有被挡回过、也没有救援资格」
    // 长得一模一样 —— 之前的操作记录和那个人工救援入口一起不见,服务端恢复了也不会自己
    // 回来(task.id 没变,这个 effect 不会再跑),页面上一个字都不说为什么。
    const pending = createCatchUp(() => api.taskNotices(taskId).then(
      (r) => {
        if (!live) return true;
        setItems(r.notices.map((notice) => ({
          kind: "event" as const,
          // 用库里那行的 id:合进时间线之后它要能被稳定地认出来(排序、去重、key)。
          id: `notice:${notice.id}`,
          at: notice.occurredAt,
          text: noticeText(notice),
          tone: "notice" as const,
          // 这是任务时间线的一条记录,不是会话里的一个回合 —— 不许当回合边界用。
          aside: true,
        })));
        setRemedy(r.remedy);
        return true;
      },
      () => false,
    ));
    catchUp.current = pending;
    pending.run();
    return () => {
      live = false;
      pending.cancel();
      if (catchUp.current === pending) catchUp.current = null;
    };
  }, [taskId, revision]);

  // ── 失效协议:这一份不是只在打开那一刻算一次的 ────────────────────────────────
  // 这个接口的 `remedy` 是**服务端此刻算出来的**(那个人工救援入口该不该显示),而它和
  // 下面那串记录都会在「任务本身一个字段都没变」的情况下变化:新的挡回、巡检写下一条
  // 诊断、锁被别处放开、占位占到超过可疑年龄。原先这个 effect 只认 task.id,外部唯一的
  // 刷新路绑在「放开成功」那一下 —— 也就是说**只有已经看见并点过那个开关的人**才有刷新
  // 路:一直开着详情页的人看不到后来出现的入口,也看不到旧入口已经失效(按下去只得到
  // 409)。所以服务端把这两样的变化发成一条 `task.notices`(写入侧见
  // server/src/user-action-rejection.ts,时间那一半见 turn-lock-reclaim.ts 的巡检)。
  const connected = useServerEvents((event) => {
    if (event.type !== "task.notices" || event.taskId !== taskId) return;
    reload();
  });
  // **每次连上都重新对一遍账**:事件流没有历史回放(服务端只订阅当前 bus、不带事件 id),
  // 断线那几十秒里的变化一条都补不回来。首次连上也要对一次 —— 挂载时那一发 GET 和事件流
  // 的建立是并发的,中间那段的事件同样没人接。同 useTaskMonitors。
  const linked = useRef(connected);
  useEffect(() => {
    const was = linked.current;
    linked.current = connected;
    if (connected && !was) reload();
  }, [connected, reload]);

  return { items, remedy, reload };
}

/**
 * 这一条该怎么说。**两种结果不是同一句话的两种语气**:`incomplete` 是「按下去了、生效了,
 * 只是没达到你要的那个效果」(放开了回合占位,任务却还停在排队中点不动),把它也写成
 * 「没有执行」是假话,而那句「接着该做什么」恰恰就装在它的 reason 里 —— 开关一从界面上
 * 消失,它就是用户唯一还看得见的下一步(第 1 轮审查 F3)。
 */
function noticeText(notice: { action: string; outcome: string; reason: string }): string {
  if (notice.outcome === "system") return `〔系统〕${notice.reason}`;
  if (notice.outcome === "incomplete") return `「${notice.action}」生效了，但还没到位：${notice.reason}`;
  // `unknown` = 服务端读那一格时认不出值来(见 server/src/user-action-rejection.ts)。
  // **不许回落成「没有执行」**:那句话和「生效了但没到位」说的是相反的两件事,猜错方向
  // 会让用户对一次其实已经发生的操作再点一次。照实说这条记录读不准。
  if (notice.outcome === "unknown") return `「${notice.action}」的结果读不准（记录可能不完整）：${notice.reason}`;
  return `「${notice.action}」没有执行：${notice.reason}`;
}

/**
 * 把通知按时间插进任务历史。**不整体重排**:正文里有些项本来就没有 `at`(或者 at 不可靠),
 * 一视同仁地 sort 会把它们的既有顺序搅乱。所以只做插入 —— 原有顺序一个字都不动。
 */
export function mergeNoticeItems(
  base: ConversationItem[],
  notices: ConversationItem[],
): ConversationItem[] {
  if (!notices.length) return base;
  // 通知从接口拿到时是新的在前,插入要按时间从早到晚走。
  const queue = [...notices].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  const out: ConversationItem[] = [];
  for (const item of base) {
    const at = item.at ?? null;
    while (queue.length && at && String(queue[0]!.at ?? "") <= at) out.push(queue.shift()!);
    out.push(item);
  }
  out.push(...queue); // 比正文里任何一条都晚的(以及正文为空时的全部)
  return out;
}
