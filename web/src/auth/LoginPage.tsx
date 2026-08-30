// key 即身份的登录页(§三)。没有注册,没有找回 —— 丢了 key 找管理员重置,
// 唯一管理员丢了 key 走宿主机逃生门。这两条都写在页面上,不让人猜。
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/apiClient.ts";
import { authApi } from "../lib/authApi.ts";
import { AuthShell } from "./AuthShell.tsx";

export function LoginPage({
  pendingJoin,
  onDone,
}: {
  pendingJoin: string | null;
  onDone: () => Promise<void> | void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ command: string; note: string } | null>(null);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (!showHint || hint) return;
    void authApi.recoveryHint().then(setHint).catch(() => {});
  }, [showHint, hint]);

  const submit = useCallback(async () => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await authApi.login(trimmed);
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }, [key, onDone]);

  return (
    <AuthShell>
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>ash</h1>
        <p className="auth-note">
          {pendingJoin
            ? "先用你的 key 登录，登录后会自动加入这个项目。"
            : "粘贴你的 key 进入。key 就是身份，没有用户名和密码。"}
        </p>
        <input
          className="ui-input auth-key-input"
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="ash_…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {error ? <p className="auth-error">{error}</p> : null}
        <button type="submit" className="ui-button ui-button--primary" disabled={busy || !key.trim()}>
          {busy ? "正在确认…" : "进入"}
        </button>

        <button type="button" className="auth-link" onClick={() => setShowHint((v) => !v)}>
          没有 key / 丢了 key？
        </button>
        {showHint ? (
          <div className="auth-recovery">
            <p>
              <b>丢了 key</b>：找这台 ash 的管理员，让他在「设置 → 用户」里给你重置 —— 会生成一条新的领取链接，
              旧 key 当场失效。
            </p>
            <p>
              <b>还没有账号</b>：ash 没有注册入口。管理员建好账号后会给你一条专属领取链接。
            </p>
            <p>
              <b>你就是唯一的管理员、而 key 也丢了</b>：在跑着 ash 的那台机器上执行
            </p>
            <pre className="auth-code">{hint?.command ?? "node scripts/ash-admin.mjs invite-admin"}</pre>
            <p className="auth-note">{hint?.note ?? "它会打印一条新的管理员邀请链接。"}</p>
          </div>
        ) : null}
      </form>
    </AuthShell>
  );
}
