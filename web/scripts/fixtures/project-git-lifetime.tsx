// 项目 Git 浮层里的操作**不跟浮层同生共死**（断言在 test-project-git-lifetime.mjs）。
//
// 老实现里操作状态住在浮层自己的 hook 里，而浮层是「点别处就收起」的下拉。fetch / pull /
// push 又都要跑上几秒。于是手一滑点到别的地方：浮层卸载 → busy、成功消息、错误一起没了。
// 请求其实还在飞、服务端照旧在跑，可用户看到的是「整个过程被打断」，重新点开浮层更是一点
// 痕迹都没有。
//
// 这里把那条时序整个摆出来：一次挂着不回的 fetch，外加一颗「让它返回」的按钮。结构照着
// 现场搭——播报口（`useProjectGitAnnouncer`）挂在**不随项目切换卸载**的那一层，胶囊本身
// 跟着当前项目换，所以「操作跑一半切到别的项目」也在这份 fixture 的覆盖范围里。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectHealth, ProjectView } from "@ash/shared";
import "../../src/styles/global.css";
import { ProjectGitContext } from "../../src/workspace/ProjectGitContext.tsx";
import { useProjectGitAnnouncer } from "../../src/workspace/useProjectGitAnnouncer.ts";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stateOf = (head: string) => ({
  isRepo: true,
  root: "/tmp/repo",
  branch: { head, detached: false, oid: "abc1234", upstream: `origin/${head}`, ahead: 2, behind: 0 },
  dirty: { staged: 0, unstaged: 0, untracked: 0, merge: 0 },
  operation: null,
  remotes: ["origin"],
  branches: [
    { name: head, current: true, upstream: `origin/${head}`, ahead: 2, behind: 0, gone: false, worktree: null },
    { name: "feature", current: false, upstream: null, ahead: null, behind: null, gone: false, worktree: null },
  ],
});

/** 谁被请求了几次 —— 断言直接读这份账（window.__calls）。 */
const calls = { gets: 0, fetches: 0 };
(window as unknown as { __calls: typeof calls }).__calls = calls;

let releaseFetch: (() => void) | null = null;
let fetchFails = false;
(window as unknown as { __release: () => void }).__release = () => releaseFetch?.();
(window as unknown as { __failNext: () => void }).__failNext = () => { fetchFails = true; };

window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  const match = /^\/api\/projects\/(p[12])\/git(\/fetch)?$/.exec(pathname);
  if (!match) return reply({ error: `unexpected ${pathname}` }, 404);
  const head = match[1] === "p1" ? "main" : "release";
  if (!match[2]) {
    calls.gets += 1;
    return reply(stateOf(head));
  }
  calls.fetches += 1;
  // 挂着不回，直到测试自己放行 —— 现场里 fetch --prune 打一趟远端就是这个量级。
  await new Promise<void>((resolve) => { releaseFetch = resolve; });
  if (fetchFails) return reply({ error: "远端连不上：Connection timed out" }, 500);
  return reply({ ok: true, message: `已更新 ${head} 的远端信息`, state: stateOf(head) });
};

const healthOf = (branch: string): ProjectHealth => ({ exists: true, isRepo: true, branch, dirty: false });
const projectOf = (id: string, name: string, branch: string): ProjectView => ({
  id,
  name,
  repoPath: `/tmp/${id}`,
  health: healthOf(branch),
  myRole: "admin",
} as ProjectView);

const PROJECTS = [projectOf("p1", "harness", "main"), projectOf("p2", "other", "release")];

function Ash() {
  const [toast, setToast] = useState("");
  // 说了**几句**也要记账：同一句话说第二遍时，只看文本的断言会被上一次的残留骗过去。
  const [said, setSaid] = useState(0);
  const [refreshed, setRefreshed] = useState(0);
  const [current, setCurrent] = useState(PROJECTS[0]);
  // 播报口住在这一层，跟现场（WorkspaceShell）一样不随项目切换卸载。
  useProjectGitAnnouncer(
    (message) => { setToast(message); setSaid((value) => value + 1); },
    () => setRefreshed((value) => value + 1),
  );
  return (
    <main style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16, width: 460 }}>
      <div className="workspace-sidebar-top">
        <div className="workspace-sidebar-selectors">
          <ProjectGitContext
            key={current.id}
            projectId={current.id}
            health={current.health}
            project={current}
            canManage
            onOpenTerminal={null}
          />
        </div>
      </div>
      {/* 「浮层外面」的落点：测试点它来模拟手滑点到别处。 */}
      <button type="button" data-testid="outside" style={{ marginTop: 320, padding: 8 }}>
        别处
      </button>
      <button
        type="button"
        data-testid="switch-project"
        onClick={() => setCurrent((row) => (row.id === "p1" ? PROJECTS[1] : PROJECTS[0]))}
      >
        换项目
      </button>
      <p data-testid="toast">{toast}</p>
      <p data-testid="said">{said}</p>
      <p data-testid="refreshed">{refreshed}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);
