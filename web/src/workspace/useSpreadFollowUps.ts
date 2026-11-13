import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskFollowUp } from "@ash/shared";
import { TASK_BATCH_LIMIT } from "@ash/shared";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

/**
 * 铺开那一列「我发的最后一条追问」：铺开时批量取头一批，之后哪个任务的会话正文变了
 * （删了几段、又说了一句），就只重取那一个。
 *
 * 写这份 state 的请求有两种、会乱序回来，所以每一发都要过**两道**边界才准落下：
 *
 * 1. **读取世代**（`gen`）：铺开、收起、换作用域、换批次（revision）、卸载，都换一代。
 *    上一代发出的请求不论成败，一律不准动这一代的 state —— 只校验正文版本挡不住它：收起期间
 *    来的事件不计版本，上一代那发迟到的重取就会把本代刚读对的那一格改回删掉的原话（第 3 轮审查）。
 * 2. **正文版本**（`writes`）：同一代里，某个任务每来一次正文变更就 +1。批量那一发回来时，
 *    版本变过的任务已经单独重取了，以那一发为准；那一发还没回来（或挂了）就先算没读到 ——
 *    既不能用批量里的旧句子，也不能说「问过了、没有」。
 */
export function useSpreadFollowUps(open: boolean, idsKey: string, ids: () => string[], revision: number) {
  const [followUps, setFollowUps] = useState<Map<string, TaskFollowUp>>(new Map());
  // 问过后端、且这一代读到了的任务 —— 「问过但我没追问过」和「还没读到」得分开说。
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const counter = useRef(0);
  const session = useRef<{ gen: number; asked: Set<string>; writes: Map<string, number>; applied: Map<string, number> } | null>(null);

  useEffect(() => {
    if (!open || !idsKey) return;
    // 追问那一列**只问头一批**：每条都要摸一次盘，一千多个任务全问一遍就是把铺开
    // 这个「扫一眼」的动作变成一次全盘扫描。剩下的行显示「还没读到」而不是「还没追问过」。
    const asked = ids().slice(0, TASK_BATCH_LIMIT);
    const gen = ++counter.current;
    const current = { gen, asked: new Set(asked), writes: new Map<string, number>(), applied: new Map<string, number>() };
    session.current = current;
    // 上一代留下的句子一并清掉：收起期间删过的话，不能在这一代读回来之前、或者读挂了之后
    // 继续摆在那一格里。
    setFollowUps(new Map());
    setLoaded(new Set());
    api.followUps(asked)
      .then((rows) => {
        if (session.current?.gen !== gen) return;
        const fresh = new Map(rows.map((row) => [row.taskId, row]));
        const version = (taskId: string) => current.writes.get(taskId) ?? 0;
        const changed = (taskId: string) => version(taskId) !== 0;
        const pending = (taskId: string) => changed(taskId) && current.applied.get(taskId) !== version(taskId);
        setFollowUps((map) => {
          const next = new Map<string, TaskFollowUp>();
          for (const taskId of asked) {
            if (pending(taskId)) continue;
            const row = (changed(taskId) ? map : fresh).get(taskId);
            if (row) next.set(taskId, row);
          }
          return next;
        });
        setLoaded(new Set(asked.filter((taskId) => !pending(taskId))));
      })
      // 读不到就让那一列留白。铺开是个扫一眼的动作，为它弹一条错误提示更吵。
      .catch(() => {});
    return () => {
      if (session.current === current) session.current = null;
    };
  }, [ids, idsKey, open, revision]);

  // 只管这一代问过的那批：别的行本来就显示「没读到」，收起时根本没有这一代。
  // 重取挂了就把那一格退回「没读到」—— 留着旧摘要就是在摆一句可能已经删掉的话。
  useServerEvents(useCallback((event) => {
    if (event.type !== "conversation.redacted" && event.type !== "conversation.turn") return;
    const current = session.current;
    const taskId = event.taskId;
    if (!current || !current.asked.has(taskId)) return;
    const version = (current.writes.get(taskId) ?? 0) + 1;
    current.writes.set(taskId, version);
    const live = () => session.current === current && current.writes.get(taskId) === version;
    api.followUps([taskId])
      .then((rows) => {
        if (!live()) return;
        current.applied.set(taskId, version);
        setFollowUps((map) => {
          const next = new Map(map);
          if (rows[0]) next.set(taskId, rows[0]);
          else next.delete(taskId);
          return next;
        });
        setLoaded((set) => new Set(set).add(taskId));
      })
      .catch(() => {
        // 不记 applied：这一版没读到，批量那一发回来时它仍算「没读到」。
        if (!live()) return;
        setFollowUps((map) => { const next = new Map(map); next.delete(taskId); return next; });
        setLoaded((set) => { const next = new Set(set); next.delete(taskId); return next; });
      });
  }, []));

  return { followUps, loaded };
}
