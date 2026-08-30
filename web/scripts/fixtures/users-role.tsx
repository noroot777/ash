// 「用户管理里改得了角色」的回归夹具（断言在 test-users-role.mjs）。
//
// 后端 `PATCH /api/users/:id` 一直就收 role，缺的只是这一屏上的入口，所以这里把
// 那条端点连同它的「最后一个能登录进来的管理员不许降」409 一起照做一份 —— 界面上
// 那三条判据（升要确认、降别人当场生效、降自己要确认且降完这一屏自己关上）都得在
// 真的打过一次网络之后才算数。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AuthState, UserRole, UserView } from "@ash/shared";
// global.css 必须排在组件之前 —— `main.tsx` 就是这个顺序，而 `.ui-input`(width:100%)
// 与各屏自己那份样式是同级选择器，排错了层叠方向就反过来，夹具里看到的布局是假的。
import "../../src/styles/global.css";
import { AuthContext } from "../../src/auth/authContext.ts";
import { UsersSettings } from "../../src/settings/UsersSettings.tsx";

const SELF_ID = "u-admin";

function user(over: Partial<UserView> & Pick<UserView, "id" | "name" | "role">): UserView {
  return {
    dirName: over.id.replace(/^u-/, ""),
    status: "active",
    gitName: over.name,
    gitEmail: `${over.id}@ash.local`,
    createdBy: SELF_ID,
    createdAt: "2026-08-01T00:00:00.000Z",
    lastActiveAt: null,
    hasKey: true,
    hasPendingInvite: false,
    ...over,
  };
}

let users: UserView[] = [
  user({ id: SELF_ID, name: "阿岚", role: "admin", createdBy: null }),
  user({ id: "u-bo", name: "小博", role: "admin" }),
  user({ id: "u-cai", name: "小蔡", role: "member" }),
  // key 一次没领过的管理员：名单上是管理员，但顶不上「最后一个」那个位置。
  user({ id: "u-ding", name: "小丁", role: "admin", hasKey: false, status: "invited", hasPendingInvite: true }),
];

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// 「还剩几个登录得进来的管理员」——后端 store.ts `canSignIn` 的同一份判据。
const loginableAdmins = (except: string) =>
  users.filter((u) => u.role === "admin" && u.hasKey && u.status !== "suspended" && u.id !== except).length;

// `GET /users` 是**全员可见**的,但按调用者的角色分两版(user-routes.ts:52-65):管理员拿
// 全量,普通成员只拿 id/name/role 且不含停用的人。这一版必须照做 —— 自降级的中间态全靠
// 它才出得来:PATCH 一成功后端就改口,而前端要等 refresh() 才知道自己已经不是管理员了。
const listFor = (role: UserRole) =>
  role === "admin"
    ? users
    : users.filter((u) => u.status !== "suspended").map((u) => ({ id: u.id, name: u.name, role: u.role }));

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  // 「我是谁」一律读 users 这份源,不读 React 那份 —— 后端也是这样,它不会等前端刷完。
  if (pathname === "/api/users" && method === "GET") {
    return reply(listFor(users.find((u) => u.id === SELF_ID)?.role ?? "member"));
  }
  const target = /^\/api\/users\/([^/]+)$/.exec(pathname)?.[1];
  if (target && method === "PATCH") {
    const id = decodeURIComponent(target);
    const patch = JSON.parse(String(init?.body ?? "{}")) as { role?: UserRole };
    const row = users.find((u) => u.id === id);
    if (!row) return reply({ error: "用户不存在" }, 404);
    if (patch.role === "member" && row.role === "admin" && loginableAdmins(id) === 0) {
      return reply({ error: "这是最后一个能登录进来的管理员，不能降级" }, 409);
    }
    users = users.map((u) => (u.id === id ? { ...u, ...patch } : u));
    return reply(users.find((u) => u.id === id));
  }
  return realFetch(input as never, init);
};

const authState = (role: UserRole): AuthState => ({
  mode: "multi",
  needsSetup: false,
  user: users.find((u) => u.id === SELF_ID) ? { ...users.find((u) => u.id === SELF_ID)!, role } : null,
  rootDir: "D:/ash-root",
  homeDir: "D:/ash-root/admin",
});

function Fixture() {
  const [myRole, setMyRole] = useState<UserRole>("admin");
  const [notices, setNotices] = useState<string[]>([]);
  // `notify` 必须是稳定引用 —— `WorkspaceShell` 那个真身就是 `useCallback(…, [])`。
  // 写成内联箭头的话 `UsersSettings` 里 `load` 的 useCallback 每次渲染都换新，那个
  // `useEffect(…, [load])` 就跟着每渲染一次重拉一次名单，夹具里看到的时序是假的。
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  // `UsersSettings` 改完角色会 `refresh()`；自己那一下降级要靠它把这一屏关上。真实现里
  // 这是一次网络往返，所以这里能被拨慢（`?slowRefresh=`，用来看住那一拍中间态）或者
  // 拨成失败（`?failRefresh=1`，那一拍会**永远**停在中间态）。
  const refresh = useCallback(async () => {
    const params = new URLSearchParams(location.search);
    const delay = Number(params.get("slowRefresh") ?? 0);
    if (delay > 0) await new Promise((done) => setTimeout(done, delay));
    if (params.get("failRefresh")) throw new Error("auth state 读不出来");
    setMyRole(users.find((u) => u.id === SELF_ID)?.role ?? "member");
  }, []);
  return (
    <AuthContext.Provider value={{ state: authState(myRole), refresh }}>
      <main style={{ width: 960, margin: "24px auto" }}>
        <UsersSettings notify={notify} onAccount={() => {}} />
        <pre data-testid="notices">{JSON.stringify(notices)}</pre>
      </main>
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
