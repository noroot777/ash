import { useCallback, useEffect, useState } from "react";
import type { AcceptPushView } from "@navi/shared/accept-gate";
import { api } from "../lib/api.ts";

// 确认层「推送」那一步要的事实：推到哪、推不推得了、上一次勾没勾（GET /tasks/:id/accept-push，只读本地）。
// 层打开才读，关掉就作废 —— 下一次打开时上一次确认可能刚把「勾没勾」写回去了，不能拿旧的当默认。
// 读不出来不放行（同「提交」那一勾的项目默认，useAcceptCommitDefault.ts）：上次勾了推送、这次读失败就静悄悄不推，
// 用户看到的会是「验收通过」，远程却没动。

export type AcceptPushRead = {
  view: AcceptPushView | null;
  error: string | null;
  /** 还在读或读失败：确认键等它。 */
  pending: boolean;
  reload: () => void;
};

const READ_TIMEOUT_MS = 8_000;

export function useAcceptPush(taskId: string, enabled: boolean): AcceptPushRead {
  const [state, setState] = useState<{ key: string; view: AcceptPushView | null; error: string | null }>({ key: "", view: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const key = `${taskId}:${attempt}`;
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) { setState({ key: "", view: null, error: null }); return; }
    let alive = true;
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    api.acceptPush(taskId, signal).then(
      (view) => { if (alive) setState({ key, view, error: null }); },
      (error: unknown) => {
        if (alive) setState({ key, view: null, error: signal.aborted ? "读取超时" : error instanceof Error ? error.message : String(error) });
      },
    );
    return () => { alive = false; };
  }, [key, enabled, taskId]);
  const fresh = enabled && state.key === key;
  return { view: fresh ? state.view : null, error: fresh ? state.error : null, pending: enabled && (!fresh || !state.view), reload };
}
