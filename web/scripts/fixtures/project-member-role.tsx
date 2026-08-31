// 「加人的时候就能定角色」的回归夹具（断言在 test-project-member-role.mjs）。
//
// 后端 `POST /api/projects/:id/members` 一直就收 role（user-routes.ts），缺的只是这一屏
// 上的入口：以前只能先按成员加进来、再翻到名单里改一次，中间那一段对方拿的是错的权限。
// 所以这里把那条端点照做一份，钉住三条判据：
//   ① 加人那一块有角色下拉，默认「成员」；
//   ② 选了「项目管理员」再加，POST body 里带的就是 admin，落到名单里也是管理员；
//   ③ 加完一轮角色回落到「成员」——下一次加人不会继承上一次那个更高的权限。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AuthState, ProjectMemberView, ProjectRole, ProjectView, UserView } from "@ash/shared";
// global.css 必须排在组件之前 —— `main.tsx` 就是这个顺序（见 users-role 夹具）。
import "../../src/styles/global.css";
import { AuthContext } from "../../src/auth/authContext.ts";
import { ProjectMembersSettings } from "../../src/settings/ProjectMembersSettings.tsx";

const SELF_ID = "u-admin";
const PROJECT_ID = "p-1";

const users: UserView[] = [
  { id: SELF_ID, name: "阿岚", role: "admin" },
  { id: "u-bo", name: "小博", role: "member" },
  { id: "u-cai", name: "小蔡", role: "member" },
].map((u) => ({
  ...u,
  dirName: u.id.replace(/^u-/, ""),
  status: "active" as const,
  gitName: u.name,
  gitEmail: `${u.id}@ash.local`,
  createdBy: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  lastActiveAt: null,
  hasKey: true,
  hasPendingInvite: false,
}));

let members: ProjectMemberView[] = [
  {
    projectId: PROJECT_ID,
    userId: SELF_ID,
    name: "阿岚",
    role: "admin",
    addedAt: "2026-08-01T00:00:00.000Z",
  },
];

// POST 收到过的 body 原样留一份：界面上看得见的只有结果，而这条测试要钉的是**请求里
// 带没带 role**——服务端拿不到就默认 member，那跟没做一样。
const posted: { userId: string; role?: string }[] = [];

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  if (pathname === "/api/users" && method === "GET") return reply(users);
  if (pathname === `/api/projects/${PROJECT_ID}/invite` && method === "GET") {
    return reply({ active: false, expiresAt: null });
  }
  if (pathname === `/api/projects/${PROJECT_ID}/members` && method === "GET") return reply(members);
  if (pathname === `/api/projects/${PROJECT_ID}/members` && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { userId?: string; role?: string };
    posted.push({ userId: body.userId ?? "", role: body.role });
    const user = users.find((u) => u.id === body.userId);
    if (!user) return reply({ error: "这个人不在实例里" }, 404);
    // 服务端的兜底也照做：不认识的角色一律落成 member。
    const role: ProjectRole = body.role === "admin" ? "admin" : "member";
    members = [
      ...members,
      { projectId: PROJECT_ID, userId: user.id, name: user.name, role, addedAt: "2026-08-02T00:00:00.000Z" },
    ];
    return reply(members, 201);
  }
  return realFetch(input as never, init);
};

const project: ProjectView = {
  id: PROJECT_ID,
  name: "示例项目",
  repoPath: "D:/ash-root/demo",
  workflowId: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  health: { exists: true, isRepo: true },
  myRole: "admin",
};

const authState: AuthState = {
  mode: "multi",
  needsSetup: false,
  user: users.find((u) => u.id === SELF_ID) ?? null,
  rootDir: "D:/ash-root",
  homeDir: "D:/ash-root/admin",
};

function Fixture() {
  const [notices, setNotices] = useState<string[]>([]);
  // `notify` 必须是稳定引用 —— 组件里 `load` 的 useCallback 依赖它，写成内联箭头会让
  // `useEffect(…, [load])` 每渲染一次重拉一次名单。
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  return (
    <AuthContext.Provider value={{ state: authState, refresh: async () => {} }}>
      <main className="settings-main" style={{ width: 960, height: "auto", margin: "24px auto", overflow: "visible" }}>
        <ProjectMembersSettings project={project} notify={notify} />
        <pre data-testid="notices">{JSON.stringify(notices)}</pre>
        <pre data-testid="posted">{JSON.stringify(posted)}</pre>
      </main>
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
