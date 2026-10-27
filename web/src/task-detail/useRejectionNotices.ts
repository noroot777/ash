import { useCallback, useEffect, useState } from "react";
import type { ConversationItem } from "./conversationModel.ts";
import { api } from "../lib/api.ts";

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
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    // 切任务先清空:否则上一个任务的挡回会挂在新任务的时间线上。
    setItems([]);
    setRemedy(null);
    api.taskNotices(taskId)
      .then((r) => {
        if (!live) return;
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
      })
      .catch(() => { /* 读不到就不显示这一段,正文本身不受影响 */ });
    return () => { live = false; };
  }, [taskId, revision, tick]);

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
  return notice.outcome === "incomplete"
    ? `你点的「${notice.action}」生效了，但还没到位：${notice.reason}`
    : `你点的「${notice.action}」没有执行：${notice.reason}`;
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
