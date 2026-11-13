import { useEffect, useState } from "react";
import type { TaskFollowUp, TaskListItem } from "@ash/shared";
import { api } from "../lib/api.ts";

// 悬停「追问」那一格时才取的全部追问（铺开那一下只批量取了每个任务最后一条）。
// 同一个任务来回悬停不该每次都摸一遍盘，所以按「任务 + 它的 updatedAt」记一份：
// 任务一有动静（新追问会顶动 updatedAt）就换一把钥匙，旧的那份自然作废。
const cache = new Map<string, TaskFollowUp[]>();
const keyOf = (task: TaskListItem) => `${task.id}\0${task.updatedAt}`;

/** undefined = 还没取到（或取挂了）——调用方退回铺开时批量取到的那最后一条。 */
export function useTaskFollowUpList(task: TaskListItem, enabled: boolean): TaskFollowUp[] | undefined {
  const key = keyOf(task);
  const [list, setList] = useState<{ key: string; rows: TaskFollowUp[] } | null>(() => {
    const rows = cache.get(key);
    return rows ? { key, rows } : null;
  });

  useEffect(() => {
    if (!enabled) return;
    const hit = cache.get(key);
    if (hit) { setList({ key, rows: hit }); return; }
    let alive = true;
    api.taskFollowUps(task.id)
      .then((rows) => {
        cache.set(key, rows);
        if (alive) setList({ key, rows });
      })
      // 读不到就停在那最后一条上：悬浮卡是扫一眼的东西，为它弹错误更吵。
      .catch(() => {});
    return () => { alive = false; };
  }, [enabled, key, task.id]);

  // 钥匙对不上的那份是别的任务（或这个任务更早的样子）的，一帧都不拿出来。
  return list?.key === key ? list.rows : undefined;
}
