// 项目邀请链接的加入页(§六)。**没有「接受」这个中间态** —— 点了就是成员,
// 因为发链接的人已经在决定「谁能进」了,再加一道审批只是多一次点击。
import { useCallback, useEffect, useState } from "react";
import type { ProjectInviteInfo } from "@ash/shared";
import { ApiError } from "../lib/apiClient.ts";
import { authApi } from "../lib/authApi.ts";

export function ProjectJoinPage({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<ProjectInviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void authApi
      .projectInvite(token)
      .then(setInfo)
      .catch((e) => setError(e instanceof ApiError ? e.message : "这条链接打不开"));
  }, [token]);

  const join = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await authApi.joinProject(token);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加入失败");
      setBusy(false);
    }
  }, [token, onDone]);

  return (
    <div className="auth-shell">
      <div className="auth-card auth-card--wide">
        <h1>加入项目</h1>
        {error ? <p className="auth-error">{error}</p> : null}
        {info ? (
          <>
            <p className="auth-note">
              项目 <b>{info.projectName}</b>，加入后你是普通成员。
            </p>
            {info.invalid ? (
              <p className="auth-error">{info.invalid}。找项目管理员要一条新的。</p>
            ) : (
              <div className="auth-actions">
                <button type="button" className="ui-button ui-button--ghost" onClick={onDone}>
                  先不加入
                </button>
                <button
                  type="button"
                  className="ui-button ui-button--primary"
                  disabled={busy}
                  onClick={() => void join()}
                >
                  {busy ? "正在加入…" : "加入"}
                </button>
              </div>
            )}
          </>
        ) : error ? null : (
          <p className="auth-note">正在读取链接…</p>
        )}
      </div>
    </div>
  );
}
