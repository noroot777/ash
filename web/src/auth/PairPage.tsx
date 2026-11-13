// 自用模式下,一台还没被放进来的设备打开 ash 时看到的那一屏。
//
// 默认什么都不用填:打开就自动递一张申请,机主在 ash 那边点「允许」,这边自己跳进去。
// 两边各显示同一个四位数 —— 机主靠它认出「就是我手上这台」。
// 另外两条路:地址里带着机主出示的一次性码(扫二维码进来的)就直接兑;脚本用的访问密钥
// 也能粘(LoginPage 的 `accessKey` 那一档)。
import { useCallback, useEffect, useRef, useState } from "react";
import type { PairTicket } from "@ash/shared";
import { ApiError } from "../lib/apiClient.ts";
import { authApi } from "../lib/authApi.ts";
import { AuthShell } from "./AuthShell.tsx";
import { LoginPage } from "./LoginPage.tsx";

const POLL_MS = 2_000;
// 申请存在这个标签页里:刷新一下不该在机主那边多弹一张。
const TICKET_KEY = "ash:pair-ticket";

function storedTicket(): PairTicket | null {
  try {
    const ticket = JSON.parse(sessionStorage.getItem(TICKET_KEY) ?? "null") as PairTicket | null;
    return ticket && Date.parse(ticket.expiresAt) > Date.now() ? ticket : null;
  } catch {
    return null;
  }
}

function storeTicket(ticket: PairTicket | null): void {
  try {
    if (ticket) sessionStorage.setItem(TICKET_KEY, JSON.stringify(ticket));
    else sessionStorage.removeItem(TICKET_KEY);
  } catch {
    // 隐私模式下存不了:刷新会重新申请一次,不碍事。
  }
}

/** 地址里那个一次性码。读完就从地址栏拿掉:它只能用一次,留着只会被收藏和转发。 */
function takePairCode(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("pair");
  if (code === null) return null;
  url.searchParams.delete("pair");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return code.trim() || null;
}

export const dropPairCode = (): void => void takePairCode();

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; ticket: PairTicket }
  | { kind: "stopped"; message: string };

export function PairPage({ onDone }: { onDone: () => Promise<unknown> | void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [useKey, setUseKey] = useState(false);
  // 开发模式下 effect 会跑两遍;码只能兑一次、申请也不该递两张。
  const started = useRef(false);

  const apply = useCallback(async () => {
    setPhase({ kind: "starting" });
    try {
      const ticket = await authApi.openPair();
      storeTicket(ticket);
      setPhase({ kind: "waiting", ticket });
    } catch (error) {
      // 409 = 这台设备其实已经进得来了(另一个标签页刚配对完),直接去问一次状态。
      if (error instanceof ApiError && error.status === 409) return void onDone();
      setPhase({ kind: "stopped", message: error instanceof ApiError ? error.message : "连不上 ash 服务端" });
    }
  }, [onDone]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const code = takePairCode();
      if (code) {
        try {
          await authApi.redeemPair(code);
          storeTicket(null);
          return void onDone();
        } catch {
          // 码用过了或过期了:退回到申请,机主点一下一样进得来。
        }
      }
      const ticket = storedTicket();
      if (ticket) setPhase({ kind: "waiting", ticket });
      else await apply();
    })();
  }, [apply, onDone]);

  const ticket = phase.kind === "waiting" ? phase.ticket : null;
  useEffect(() => {
    if (!ticket) return;
    let alive = true;
    const check = async () => {
      try {
        const claim = await authApi.claimPair(ticket);
        if (!alive || claim.status === "pending") return;
        storeTicket(null);
        if (claim.status === "approved") return void onDone();
        setPhase({ kind: "stopped", message: claim.status === "denied" ? "这次申请被拒绝了。" : "申请过期了。" });
      } catch (error) {
        if (alive && error instanceof ApiError && error.status === 409) void onDone();
        // 其余的失败(断网、服务端重启中)下一轮再问。
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [ticket, onDone]);

  if (useKey) return <LoginPage accessKey pendingJoin={null} onBack={() => setUseKey(false)} onDone={onDone} />;

  return (
    <AuthShell>
      <div className="auth-card">
        <h1>ash</h1>
        {phase.kind === "stopped" ? (
          <>
            <p className="auth-error" role="alert">{phase.message}</p>
            <button type="button" className="ui-button ui-button--primary" onClick={() => void apply()}>重新申请</button>
          </>
        ) : (
          <>
            <p className="auth-note">在跑着 ash 的那台电脑上点「允许」，这里会自己进去。</p>
            <output className="auth-pair-code" aria-label="配对码" aria-live="polite">{ticket?.code ?? "····"}</output>
          </>
        )}
        <button type="button" className="auth-link" onClick={() => setUseKey(true)}>改用访问密钥</button>
      </div>
    </AuthShell>
  );
}
