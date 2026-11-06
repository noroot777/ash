// 「刷新时不许先闪一屏登录外壳」的回归夹具(断言在 test-auth-boot.mjs)。
//
// `GET /api/auth/state` 在这里被人为拖慢,模拟远程访问那一个真实存在的 RTT —— 本机上它
// 快到量不出来,而这条路径上出过的毛病(首屏先把整块品牌外壳渲染出来、拿到状态再跳走)
// 只在慢的时候看得见。`?delay=0` 是快路径;`?delay=hold` 把应答**扣住**,直到测试调
// `window.__releaseAuthState()` 才放 —— 慢路径要断言「等待态在、工作台还没来」,那段窗口
// 不能交给定时器去赌(从前是阈值 +600ms,满载时测试这边几次往返就能把 600ms 用完)。
//
// `?mode=probe-once` 是另一条:不渲染界面,只验预热快照的**一次性**语义(见文件末尾)。
//
// 夹具页面**故意不带** index.html 里那段预热脚本:这里要测的是「预热没生效时 AuthGate
// 自己撑不撑得住」,预热本身的并行性由测试直接对着真 index.html 量。
import { createRoot } from "react-dom/client";
import type { AuthState } from "@ash/shared";
// global.css 必须排在组件之前 —— `main.tsx` 就是这个顺序。
import "../../src/styles/global.css";
import { AuthGate } from "../../src/auth/AuthGate.tsx";
import { authApi } from "../../src/lib/authApi.ts";

const params = new URLSearchParams(location.search);
const hold = params.get("delay") === "hold";
const delay = hold ? 0 : Number(params.get("delay") ?? 0);

// 自用模式:AuthGate 对它应当**整体透明**,直接渲染 children。
const state: AuthState = { mode: "single", needsSetup: false, user: null, rootDir: null, homeDir: null, needsOnboarding: false };

let realRequests = 0;
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (new URL(href, location.origin).pathname === "/api/auth/state") {
    realRequests += 1;
    if (hold) {
      await new Promise((resolve) => { (window as unknown as { __releaseAuthState: () => void }).__releaseAuthState = () => resolve(undefined); });
    } else {
      // 模拟网络往返。快路径传 0:跟 AuthGate 的阈值定时器比的是页面定时器的到期先后,不看负载。
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input as never, init);
};

if (params.get("mode") === "probe-once") {
  // 快照带个记号,好分辨每一次 `authApi.state()` 到底吃的是预热结果还是真请求。
  window.__ashAuthProbe = Promise.resolve({ ...state, homeDir: "/from-probe" });
  void (async () => {
    const first = await authApi.state();
    const afterFirst = realRequests;
    const second = await authApi.state();
    const result = document.createElement("pre");
    result.id = "probe-once";
    result.textContent = JSON.stringify({
      firstFromProbe: first.homeDir === "/from-probe",
      realRequests: afterFirst,
      secondFromProbe: second.homeDir === "/from-probe",
      realRequestsAfterSecond: realRequests,
    });
    document.body.append(result);
  })();
} else {
  createRoot(document.getElementById("root")!).render(
    <AuthGate>
      <div className="probe-workbench">工作台</div>
    </AuthGate>,
  );
}
