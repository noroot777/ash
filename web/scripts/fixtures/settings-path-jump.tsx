// 报错文案里的「设置 → 项目设置 → 预览 → 自定义脚本」是**一条能点着走过去的路**
// （断言在 test-settings-path-jump.mjs）。
//
// 现场：预览起不来，后端回来一整份说明，末尾指了条路。读到这儿用户是卡住的，而那条路
// 要他自己退出任务、翻侧栏、进设置、找到项目那一节、再往下滚过好几张卡才走得完 ——
// 路都写清楚了，没有理由不让它自己走过去。
//
// 这里把真提示（useToast + WorkspaceToast）和真设置页（SettingsPage）按 WorkspaceShell
// 的接法挂在一起，中间只换掉 fetch：断言的是「点了之后到没到那张卡」。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AuthState, ProjectView } from "@ash/shared";
import type { ProjectPreviewConfig } from "@ash/shared/preview";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import { AuthContext } from "../../src/auth/authContext.ts";
import { SettingsPage } from "../../src/settings/SettingsPage.tsx";
import type { SettingsSection } from "../../src/settings/sections.ts";
import { useToast, WorkspaceToast } from "../../src/workspace/WorkspaceToast.tsx";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const previewConfig = (): ProjectPreviewConfig => ({ mode: "script", proxy: "auto", services: [], primaryServiceId: null });

const project: ProjectView = {
  id: "p-one",
  name: "第一个项目",
  repoPath: "/workspace/p-one",
  workflowId: null,
  previewCommand: null,
  previewConfig: previewConfig(),
  createdAt: "2026-09-01T00:00:00.000Z",
  health: { exists: true, isRepo: true, dirty: false, branch: "main" },
  myRole: "admin",
};

/** 后端认出多个候选时说的那段话（server/src/preview-command.ts 的 ambiguousMessage 形状）。 */
export const AMBIGUOUS = "这个工作区里认出了 2 个能起服务的东西，ash 不替你挑：\n"
  + "  · a4sms-back/a4sms-imds（Maven 模块 · Spring Boot）\n"
  + "  · a4sms-front（Node · pnpm dev）\n"
  + "到「设置 → 项目设置 → 预览 → 选择服务」点击检测并勾选所需服务，也可以在「自定义脚本」里填写启动方式。";
/** 认不出去处的那种：设置里根本没有这一节，只能当普通文字留着。 */
export const UNKNOWN_PATH = "到「设置 → 星际航行 → 曲速」里改一下。";
Object.assign(window, { __ambiguous: AMBIGUOUS, __unknownPath: UNKNOWN_PATH });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  if (pathname === "/api/host") return reply({ platform: "linux", sep: "/", home: "/root", canPickDirectory: false });
  if (pathname === "/api/projects/check") return reply({ exists: true, isRepo: true, dirty: false, branch: "main" });
  if (pathname === "/api/workflows") return reply([]);
  if (pathname.endsWith("/git")) return reply({
    identity: { isRepo: true, userName: { value: null, scope: null }, userEmail: { value: null, scope: null }, sshKeyPath: null, sshCommand: { value: null, scope: null }, remotes: [] },
    credential: null,
  });
  if (pathname.startsWith("/api/")) return reply({});
  return realFetch(input as never, init);
};

const authState: AuthState = { mode: "single", needsSetup: false, user: null, rootDir: null, homeDir: "/root" };

function Fixture() {
  const { toasts, notify, dismiss } = useToast();
  // WorkspaceShell 那两个状态：进哪一节、这一次冲着哪张卡去。
  const [section, setSection] = useState<SettingsSection | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const dropAnchor = useCallback(() => setAnchor(null), []);
  return (
    <AuthContext.Provider value={{ state: authState, refresh: async () => {} }}>
      <main style={{ width: "min(900px, calc(100% - 32px))", margin: "24px auto" }}>
        <button type="button" data-testid="raise-ambiguous" onClick={() => notify(AMBIGUOUS, { sticky: true })}>报一句预览起不来</button>
        <button type="button" data-testid="raise-unknown" onClick={() => notify(UNKNOWN_PATH, { sticky: true })}>报一句指向不存在设置的话</button>
        {section && <SettingsPage
          section={section}
          anchor={anchor}
          onAnchorSettled={dropAnchor}
          project={project}
          tasks={[]}
          groups={[]}
          onSection={setSection}
          onBack={() => setSection(null)}
          onProjectUpdated={() => {}}
          onProjectDeleted={() => {}}
          onTaskUpdated={() => {}}
          onGroupsChanged={() => {}}
          notify={notify}
        />}
        <WorkspaceToast
          toasts={toasts}
          onDismiss={dismiss}
          onOpenSettings={(next, nextAnchor) => { setSection(next); setAnchor(nextAnchor); }}
        />
      </main>
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
