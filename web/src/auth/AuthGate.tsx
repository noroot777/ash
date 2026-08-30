// 多人模式的前置屏:向导 / 登录 / 领取链接。**它包在整个工作台外面** —— 没这一层的话,
// 未登录访问会先把工作台渲染出来、再由一堆 401 把它打成一片错误提示,而用户看到的是
// 「这个应用坏了」而不是「我该登录」。
//
// 自用模式下这一层**整体透明**:`mode === "single"` 直接渲染 children,不多一个 DOM 节点。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AuthState } from "@ash/shared";
import { authApi } from "../lib/authApi.ts";
import { ApiError } from "../lib/apiClient.ts";
import { AuthShell } from "./AuthShell.tsx";
import { ClaimPage } from "./ClaimPage.tsx";
import { LoginPage } from "./LoginPage.tsx";
import { ProjectJoinPage } from "./ProjectJoinPage.tsx";
import { SetupWizard } from "./SetupWizard.tsx";
import { AuthContext } from "./authContext.ts";

/** 领取链接与项目加入链接走真实路径,刷新后还在(邮件/群里发的就是这条 URL)。 */
function routeOf(pathname: string): { kind: "claim" | "join"; token: string } | null {
  const claim = /^\/claim\/([^/]+)\/?$/.exec(pathname);
  if (claim) return { kind: "claim", token: decodeURIComponent(claim[1]) };
  const join = /^\/join\/([^/]+)\/?$/.exec(pathname);
  if (join) return { kind: "join", token: decodeURIComponent(join[1]) };
  return null;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState(() => routeOf(window.location.pathname));

  const refresh = useCallback(async () => {
    try {
      setState(await authApi.state());
      setError(null);
    } catch (e) {
      // 拿不到状态 = 服务端不可达或比前端旧。**不放行** —— 放行会让工作台带着一堆
      // 401 渲染出来,那种画面看不出成因。
      setError(e instanceof ApiError ? e.message : "连不上 ash 服务端");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 领完 key / 加完项目之后要回到工作台:换 URL + 重新问一次状态。
  const leaveRoute = useCallback(() => {
    window.history.replaceState(null, "", "/");
    setRoute(null);
    void refresh();
  }, [refresh]);

  if (route?.kind === "claim") return <ClaimPage token={route.token} onDone={leaveRoute} />;

  if (!state) {
    return (
      <AuthShell>
        <div className="auth-card auth-card--service">
          {error ? (
            <>
              <h1>连不上服务端</h1>
              <p className="auth-note">{error}</p>
              <button type="button" className="ui-button ui-button--primary" onClick={() => void refresh()}>
                重试
              </button>
            </>
          ) : (
            <p className="auth-note">正在确认身份…</p>
          )}
        </div>
      </AuthShell>
    );
  }

  if (state.needsSetup) return <SetupWizard state={state} onDone={refresh} />;
  if (state.mode === "multi" && !state.user) {
    // 项目加入链接:没登录时先引导登录,登录完自动回到这条链接(计划 §六:
    // 项目邀请链接只发给已有账号的人)。
    return <LoginPage pendingJoin={route?.kind === "join" ? route.token : null} onDone={refresh} />;
  }
  if (route?.kind === "join") return <ProjectJoinPage token={route.token} onDone={leaveRoute} />;

  return <AuthContext.Provider value={{ state, refresh }}>{children}</AuthContext.Provider>;
}
