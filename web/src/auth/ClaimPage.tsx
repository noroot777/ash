// 专属邀请链接的领取页(§五)。三步:看说明 → 领取 → 「我已保存」作废链接。
//
// 领取那一步**不作废链接**:手滑点开就把它烧掉,用户得回头再找管理员要一条 —— 这是
// 计划里明确要避免的。真正作废发生在用户点了「我已保存」之后。
import { useCallback, useEffect, useState } from "react";
import type { InviteInfo } from "@ash/shared";
import { ApiError } from "../lib/apiClient.ts";
import { authApi } from "../lib/authApi.ts";
import { AuthShell } from "./AuthShell.tsx";
import { KeyReveal } from "./KeyReveal.tsx";

export function ClaimPage({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuedKey, setIssuedKey] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void authApi
      .invite(token)
      .then(setInfo)
      .catch((e) => setError(e instanceof ApiError ? e.message : "这条链接打不开"));
  }, [token]);

  const claim = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await authApi.claim(token);
      setIssuedKey(result.key);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "领取失败");
    } finally {
      setBusy(false);
    }
  }, [token]);

  const finish = useCallback(() => {
    // 作废链接是「尽力而为」:失败了也照样进实例 —— 用户手上已经有 key 了,把他
    // 挡在这一屏上没有任何好处。链接自己 7 天后也会过期。
    void authApi.confirmClaim(token).catch(() => {});
    onDone();
  }, [token, onDone]);

  if (issuedKey) {
    return (
      <AuthShell>
        <div className="auth-card auth-card--wide">
          <KeyReveal
            value={issuedKey}
            title={`${info?.name ?? "你"}，这是你的 key`}
            note="这串 key 只显示这一次，服务端只存哈希。丢了就得找管理员重置。点下面这个按钮之后，这条领取链接会作废。"
            confirmLabel="我已保存，进入实例"
            onConfirm={finish}
          />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="auth-card auth-card--wide">
        <h1>领取你的 ash 账号</h1>
        {error ? <p className="auth-error">{error}</p> : null}
        {info ? (
          <>
            <p className="auth-note">
              <b>{info.name}</b>
              {info.role === "admin" ? "（实例管理员）" : ""} · 机器 <code>{info.host}</code>
            </p>
            {info.invalid ? (
              <p className="auth-error">{info.invalid}。找管理员要一条新的。</p>
            ) : (
              <>
                <p className="auth-note">
                  点下面这个按钮会当场生成一把只属于你的 key。<b>没点之前这条链接不会作废</b>，
                  手滑点开这一页是安全的。
                </p>
                <button
                  type="button"
                  className="ui-button ui-button--primary"
                  disabled={busy}
                  onClick={() => void claim()}
                >
                  {busy ? "正在生成…" : "生成我的 key"}
                </button>
              </>
            )}
          </>
        ) : error ? null : (
          <p className="auth-note">正在读取链接…</p>
        )}
      </div>
    </AuthShell>
  );
}
