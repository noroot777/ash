import { useCallback, useEffect, useRef, useState } from "react";
import type { AcceptPushView } from "@navi/shared/accept-gate";
import { api } from "../lib/api.ts";
import { type CatchUpOptions, catchUpAbortKind } from "../lib/catchUp.ts";
import { useServerEvents } from "../lib/events.ts";
import { useCatchUp, useCatchUpLink } from "../lib/useCatchUp.ts";

// 确认层「推送」那一步要的事实：推到哪、推不推得了、上一次勾没勾（GET /tasks/:id/accept-push，只读本地）。
// 层打开才读，关掉就作废 —— 下一次打开时上一次确认可能刚把「勾没勾」写回去了，不能拿旧的当默认。
// 开着的时候也追平：别的页面记下了新的「勾没勾」（服务端发 task.acceptGate）、或断线重连，都重读一次 ——
// 层里手动动过的那一勾在 AcceptanceControls 里另存，重读只换默认。单飞、期限、重试、断线作废都在追平层
// （lib/catchUp.ts、lib/useCatchUp.ts），这里只剩「这一份能不能写进 state」。
// 读不出来不放行（同「提交」那一勾的项目默认，useAcceptCommitDefault.ts）：上次勾了推送、这次读失败就静悄悄不推，
// 用户看到的会是「验收通过」，远程却没动。重读在途时确认也等它（同 useAcceptGate 的 stale）。

export type AcceptPushRead = {
  view: AcceptPushView | null;
  error: string | null;
  /** 还在读或读失败：确认键等它。 */
  pending: boolean;
  /** 「重试」那一下：人正等着，抢占在途那一发。 */
  reload: () => void;
};

/** 节奏同验收前置命令那条（useAcceptGate 的 GATE_CATCH_UP）：退五次之后停下来，留「重试」给人按。 */
const PUSH_CATCH_UP: CatchUpOptions = {
  retry: (failures) => (failures > 5 ? null : Math.min(1000 * 2 ** (failures - 1), 10_000)),
  deadlineMessage: "读取超时（15 秒），可重试",
};

export function useAcceptPush(taskId: string, enabled: boolean): AcceptPushRead {
  const owner = enabled ? taskId : "";
  const [snap, setSnap] = useState<{ owner: string; view: AcceptPushView } | null>(null);
  const [failure, setFailure] = useState<{ owner: string; error: string } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const active = useRef("");
  const read = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    if (!owner || active.current !== owner) return true;
    setChecking(owner);
    try {
      const view = await api.acceptPush(taskId, signal);
      if (active.current !== owner) return true;
      setSnap({ owner, view });
      setFailure(null);
      setChecking(null);
      return true;
    } catch (reason) {
      if (active.current !== owner) return true;
      setChecking(null);
      // 换了代次的那一发（断线 / 关层 / 换任务）不作数，新代次自己追平；到点的那一种照实说，追平层还会接着重试。
      if (catchUpAbortKind(signal, reason) === "stale") return false;
      setFailure({ owner, error: reason instanceof Error ? reason.message : String(reason) });
      return false;
    }
  }, [owner, taskId]);
  const catchUp = useCatchUp(read, owner, PUSH_CATCH_UP);
  useEffect(() => {
    active.current = owner;
    // 关层就把上一份扔掉：再打开时 owner 还是同一个任务，留着它就会被当成这一次读到的。
    if (!owner) { setSnap(null); setFailure(null); setChecking(null); return; }
    void catchUp.run();
    return () => { active.current = ""; };
  }, [catchUp, owner]);
  const connected = useServerEvents((event) => {
    if (owner && event.type === "task.acceptGate" && event.taskId === taskId) void catchUp.run();
  }, enabled);
  useCatchUpLink(catchUp, connected);
  const reload = useCallback(() => { void catchUp.runNow(); }, [catchUp]);
  const view = owner && snap?.owner === owner ? snap.view : null;
  const error = owner && failure?.owner === owner ? failure.error : null;
  return { view, error, pending: enabled && (!view || checking === owner || !!error), reload };
}
