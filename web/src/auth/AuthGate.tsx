// 前置屏:向导 / 登录 / 领取链接。**它包在整个工作台外面** —— 没这一层的话,
// 未登录访问会先把工作台渲染出来、再由一堆 401 把它打成一片错误提示,而用户看到的是
// 「这个应用坏了」而不是「我该登录」。
//
// 自用模式下在 ash 所在的那台机器上打开,这一层**整体透明**:直接渲染 children,不多一个
// DOM 节点。从别的设备打开时先过配对那一屏(`needsAccessKey`)。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AuthState } from "@ash/shared";
import { authApi } from "../lib/authApi.ts";
import { ApiError } from "../lib/apiClient.ts";
import { FirstRunWizard } from "../onboarding/FirstRunWizard.tsx";
import { AuthShell } from "./AuthShell.tsx";
import { ClaimPage } from "./ClaimPage.tsx";
import { LoginPage } from "./LoginPage.tsx";
import { PairPage, dropPairCode } from "./PairPage.tsx";
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
  // 「确认身份」慢到该给个交代了没有。**首屏空窗期一律不渲染登录外壳** —— 那是整块
  // 深色品牌面板,而它多数时候只存在一个 RTT,闪出来再跳走比什么都不显示更吵(远程
  // 访问时用户看到的就是「刷新一下先闪一屏登录页」)。真等久了才淡入一行低调的字。
  const [waitedLong, setWaitedLong] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaitedLong(true), 400);
    return () => clearTimeout(timer);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setState(await authApi.state());
      setError(null);
      return true;
    } catch (e) {
      // 拿不到状态 = 服务端不可达或比前端旧。**不放行** —— 放行会让工作台带着一堆
      // 401 渲染出来,那种画面看不出成因。
      setError(e instanceof ApiError ? e.message : "连不上 ash 服务端");
      // 已经有旧状态时下面那块错误屏不出来(它只认 `!state`),所以失败必须**回给
      // 调用方**:等着这一次刷新换屏的人只有它自己知道该怎么收场。
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 已经进得来的设备又扫了一次码:那个码用不上,别让它留在地址栏里被收藏、被转发。
  const admitted = state !== null && !state.needsAccessKey;
  useEffect(() => {
    if (admitted) dropPairCode();
  }, [admitted]);

  // 领完 key / 加完项目之后要回到工作台:换 URL + 重新问一次状态。
  const leaveRoute = useCallback(() => {
    window.history.replaceState(null, "", "/");
    setRoute(null);
    void refresh();
  }, [refresh]);

  if (route?.kind === "claim") return <ClaimPage token={route.token} onDone={leaveRoute} />;

  if (!state) {
    // 连不上是**持久态**,得把话说全,所以照旧给整屏外壳。等待则相反(见上)。
    if (error) {
      return (
        <AuthShell>
          <div className="auth-card auth-card--service">
            <h1>连不上服务端</h1>
            <p className="auth-note">{error}</p>
            <button type="button" className="ui-button ui-button--primary" onClick={() => void refresh()}>
              重试
            </button>
          </div>
        </AuthShell>
      );
    }
    // `role="status"` 不是装饰:这一屏只剩一行字,没有它读屏用户在这段等待里什么都听不到。
    return waitedLong ? <div className="auth-booting" role="status">正在确认身份…</div> : null;
  }

  // 排在向导之前:没认出机主的时候,连「要不要首启」都不该由这个访客来答。
  // 本机自用模式没有配对这回事:走到这里的只能是同机反代转进来的请求,说清楚就够了。
  if (state.needsAccessKey && state.localOnly) {
    return (
      <AuthShell>
        <div className="auth-card auth-card--service">
          <h1>只接受本机访问</h1>
          <p className="auth-note">请在 ash 所在的这台机器上直接打开。</p>
        </div>
      </AuthShell>
    );
  }
  if (state.needsAccessKey) return <PairPage onDone={refresh} />;
  if (state.needsSetup) return <SetupWizard state={state} onDone={refresh} />;
  if (state.mode === "multi" && !state.user) {
    // 项目加入链接:没登录时先引导登录,登录完自动回到这条链接(计划 §六:
    // 项目邀请链接只发给已有账号的人)。
    return <LoginPage pendingJoin={route?.kind === "join" ? route.token : null} onDone={refresh} />;
  }
  if (route?.kind === "join") return <ProjectJoinPage token={route.token} onDone={leaveRoute} />;

  // 首启向导的后半段(供应商 / 执行器 / 项目)。它在 Provider **里面** —— 那三步都要
  // 读「我是谁」(多人模式下新建项目的路径前缀锁死在自己的目录里),而读 context 的前提
  // 是身份已经确认。前半段(SetupWizard)相反:那时还没确认,所以它在外面。
  if (state.needsOnboarding) {
    return (
      <AuthContext.Provider value={{ state, refresh }}>
        <FirstRunWizard onDone={refresh} />
      </AuthContext.Provider>
    );
  }

  return <AuthContext.Provider value={{ state, refresh }}>{children}</AuthContext.Provider>;
}
