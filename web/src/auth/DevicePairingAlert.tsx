import { useCallback, useEffect, useState } from "react";
import type { PairRequestView } from "@ash/shared";
import { Check, Devices, Prohibit, SpinnerGap } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { authApi } from "../lib/authApi.ts";
import { PAIR_REQUESTS_CHANGED_EVENT, seenLabel } from "../lib/pairing.ts";
import { useIsMultiUser } from "./authContext.ts";

const POLL_MS = 4_000;

// 自用模式:一台新设备打开了这台 ash,等机主点头。和接力申请是同一种事(别的机器想进来,
// 得有人拍板),所以长相和落点都跟 HandoffApprovalAlert 一样,样式也用它那一套。
//
// 不用像那边一样筛「新鲜」:申请只活十分钟,过期了服务端自己就不再给。
export function DevicePairingAlert({ notify }: { notify: (message: string) => void }) {
  const multi = useIsMultiUser();
  const [requests, setRequests] = useState<PairRequestView[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setRequests((await authApi.pairRequests()).requests);
    } catch {
      // 后台轮询失败不弹 toast;下一轮自己补上。
    }
  }, []);

  useEffect(() => {
    // 多人模式没有设备配对,那边每个人凭自己的 key 登录。
    if (multi) return;
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void reload(); };
    window.addEventListener(PAIR_REQUESTS_CHANGED_EVENT, reload);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(PAIR_REQUESTS_CHANGED_EVENT, reload);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [multi, reload]);

  const request = requests[0];
  if (multi || !request) return null;

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    try {
      await authApi.decidePair(request.id, decision);
      notify(decision === "approve" ? `「${request.name}」可以用这台 ash 了` : "已拒绝");
    } catch (error) {
      notify(error instanceof Error ? error.message : "处理失败");
    } finally {
      window.dispatchEvent(new Event(PAIR_REQUESTS_CHANGED_EVENT));
      setBusy(false);
    }
  };

  return (
    <section className="handoff-approval-alert" role="alertdialog" aria-labelledby="device-pairing-alert-title">
      <span className="handoff-approval-alert-icon"><Devices size={22} weight="fill" aria-hidden="true" /></span>
      <div className="handoff-approval-alert-copy">
        <strong id="device-pairing-alert-title">「{request.name}」想连接这台 ash</strong>
        <p>
          它屏幕上的配对码应为 <b className="pair-code">{request.code}</b>。允许后，它能做你在这里能做的一切。
        </p>
        <small>
          来自 {request.address}{` · ${seenLabel(request.createdAt)}`}
          {requests.length > 1 ? ` · 另有 ${requests.length - 1} 个申请` : ""}
        </small>
      </div>
      <div className="handoff-approval-alert-actions">
        <Button variant="primary" disabled={busy} onClick={() => void decide("approve")}>
          {busy ? <SpinnerGap size={13} className="is-spinning" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          允许
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void decide("deny")}>
          <Prohibit size={13} aria-hidden="true" />拒绝
        </Button>
      </div>
    </section>
  );
}
