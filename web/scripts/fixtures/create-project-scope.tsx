// 「多人模式下新建项目的路径框锁前缀」的回归夹具（断言在 test-create-project-scope.mjs）。
//
// 服务端那道钳制（auth/path-scope.ts）只收 `rootDir/<我的目录名>` 之内的路径，界面必须
// 长成同一个形状，否则用户打完一条长路径才在提交时吃 403。这里把 `/host` 和
// `/projects/check` 两条只读端点照做一份 —— 前缀那一截是拿服务端的分隔符拼的，不打一次
// 网络就看不出拼错。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AuthState, ProjectHealth, UserRole } from "@ash/shared";
// global.css 必须排在组件之前 —— `main.tsx` 就是这个顺序。
import "../../src/styles/global.css";
import { AuthContext } from "../../src/auth/authContext.ts";
import { CreateProjectDialog } from "../../src/overlays/CreateProjectDialog.tsx";

const HOME = "/srv/ash-root/xiaocai";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const health: ProjectHealth = { exists: false, occupied: false, isRepo: false, dirty: false, branch: null, empty: true };

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  // 服务端是 Linux；`canPickDirectory` 为假 = 普通用户那一档（系统窗口是管理员的工具）。
  if (pathname === "/api/host") {
    return reply({ platform: "linux", sep: "/", home: "/root", canPickDirectory: false });
  }
  if (pathname === "/api/projects/check") return reply(health);
  return realFetch(input as never, init);
};

const authState = (role: UserRole): AuthState => ({
  mode: "multi",
  needsSetup: false,
  user: {
    id: "u-cai",
    name: "小蔡",
    role,
    dirName: "xiaocai",
    status: "active",
    gitName: "小蔡",
    gitEmail: "xiaocai@ash.local",
    createdBy: "u-admin",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastActiveAt: null,
    hasKey: true,
  },
  rootDir: role === "admin" ? "/srv/ash-root" : null,
  homeDir: HOME,
});

function Fixture() {
  // 角色从 URL 来（`?role=admin`）：弹层是模态的，遮罩盖住整页，页面上再摆一个切换
  // 按钮也点不到 —— 换个人就重开一次这一屏，跟真实登录一样。
  const role: UserRole = new URLSearchParams(location.search).get("role") === "admin" ? "admin" : "member";
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  return (
    <AuthContext.Provider value={{ state: authState(role), refresh: async () => {} }}>
      <main style={{ width: 900, margin: "24px auto" }}>
        <CreateProjectDialog
          projects={[]}
          onClose={() => {}}
          onCreated={() => {}}
          notify={notify}
        />
        <pre data-testid="notices">{JSON.stringify(notices)}</pre>
      </main>
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
