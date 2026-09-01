// 「刷新时不许先闪一屏登录外壳」的回归夹具(断言在 test-auth-boot.mjs)。
//
// `GET /api/auth/state` 在这里被人为拖慢,模拟远程访问那一个真实存在的 RTT —— 本机上它
// 快到量不出来,而这条路径上出过的毛病(首屏先把整块品牌外壳渲染出来、拿到状态再跳走)
// 只在慢的时候看得见。延迟由 `?delay=` 传进来,测试拿它跨过 / 不跨过 AuthGate 的等待阈值。
//
// 夹具页面**故意不带** index.html 里那段预热脚本:这里要测的是「预热没生效时 AuthGate
// 自己撑不撑得住」,预热本身的并行性由测试直接对着真 index.html 量。
import { createRoot } from "react-dom/client";
import type { AuthState } from "@ash/shared";
// global.css 必须排在组件之前 —— `main.tsx` 就是这个顺序。
import "../../src/styles/global.css";
import { AuthGate } from "../../src/auth/AuthGate.tsx";

const delay = Number(new URLSearchParams(location.search).get("delay") ?? 0);

// 自用模式:AuthGate 对它应当**整体透明**,直接渲染 children。
const state: AuthState = { mode: "single", needsSetup: false, user: null, rootDir: null, homeDir: null };

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (new URL(href, location.origin).pathname === "/api/auth/state") {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input as never, init);
};

createRoot(document.getElementById("root")!).render(
  <AuthGate>
    <div className="probe-workbench">工作台</div>
  </AuthGate>,
);
