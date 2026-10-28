import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, ScheduledMessage, TaskListItem } from "@ash/shared";
import type { ScmOverview } from "../../src/lib/api.ts";
import { ScheduledMessageTray } from "../../src/components/ScheduledMessageTray.tsx";
import { AcceptanceWorkspaceCommit } from "../../src/review/AcceptanceWorkspaceCommit.tsx";
import { CreateProjectDialog } from "../../src/overlays/CreateProjectDialog.tsx";
import { AuthContext } from "../../src/auth/authContext.ts";
import "../../src/styles/global.css";

let overview: ScmOverview = {
  root: { path: "/workspace/demo/.worktrees/task", source: "worktree", gitRepo: true }, taskRunning: false, readOnly: null,
  status: { branch: { head: "task", detached: false, oid: "abc", upstream: null, ahead: null, behind: null },
    staged: [], unstaged: [{ path: "src/app.tsx", kind: "modified", origPath: null, conflict: null, nested: false }],
    untracked: [{ path: "notes.md", kind: "untracked", origPath: null, conflict: null, nested: false }], merge: [], operation: null, truncated: false }, commits: [],
};
const project = { id: "demo", name: "示例项目", repoPath: "/workspace/demo", acceptAutoCommit: false } as ProjectView;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.pathname === "/api/host") return response({ platform: "linux", sep: "/", home: "/workspace", canPickDirectory: false });
  if (url.pathname === "/api/projects/check") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const exists = !String(body.repoPath).includes("new");
    return response({ exists, isRepo: exists, dirty: false, empty: true });
  }
  if (url.pathname === "/api/projects" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    return response({ ...project, ...body, id: "created" }, 201);
  }
  if (url.pathname === "/api/projects") return response([project]);
  if (url.pathname === "/api/projects/clone") return response({ ...project, name: "cloned", id: "cloned" }, 201);
  if (url.pathname === "/api/tasks/demo/scm/commit") {
    overview = { ...overview, status: { ...overview.status, staged: [], unstaged: [], untracked: [] } };
    return response({ ok: true, sha: "abc123456789", subject: "示例提交", status: overview.status });
  }
  if (url.pathname === "/api/tasks/demo/scm") return response(overview);
  throw new Error(`验证页面拒绝未声明的请求：${url.pathname}`);
};
const message = (id: string, text: string): ScheduledMessage => ({ id, text, taskId: "demo", attachments: [], agent: null,
  executorId: null, model: null, reasoningEffort: null, sessionRole: null, origin: null, mode: "queued", status: "pending",
  sendAt: `2026-10-28T00:00:0${id}Z`, createdAt: `2026-10-28T00:00:0${id}Z`, sentAt: null });
const initial = [message("1", "请先修复项目创建流程，再调整验收页面"), message("2", "补充：保留现在的工作区隔离方式")];
function Fixture() {
  const [messages, setMessages] = useState(initial);
  const [dialog, setDialog] = useState(false);
  const [notice, setNotice] = useState("");
  return <AuthContext.Provider value={{ state: { mode: "single", user: null, needsSetup: false }, refresh: async () => {} }}>
    <main style={{ maxWidth: 960, margin: "40px auto", padding: 20 }}>
      <h1>项目与会话交互</h1><button onClick={() => setDialog(true)}>创建项目</button>
      <h2>用户消息 · 收起时可直接操作</h2>
      <ScheduledMessageTray messages={messages} loading={false} error={null} cancelingIds={new Set()}
        onWithdraw={message => { setMessages(rows => rows.filter(row => row.id !== message.id)); setNotice(`已撤回：${message.text}`); }}
        onSteer={id => { setMessages(rows => rows.filter(row => row.id !== id)); setNotice("已引导会话"); }} />
      <h2>系统消息 · 不混用用户操作</h2>
      <ScheduledMessageTray messages={[{ ...message("3", "【哨兵结束】构建检查，退出码 1。请检查错误日志"), origin: "monitor:test" },
        { ...message("4", "审查完成后投递的答复"), sessionRole: "reviewer" }]} loading={false} error={null} cancelingIds={new Set()}
        onWithdraw={() => setNotice("不应撤回系统消息")}
        onSteer={() => setNotice("不应引导系统消息")}
        onCancel={() => setNotice("仅取消这次哨兵唤醒，不停止哨兵")} />
      <h2>验收 · 未提交改动</h2>
      <AcceptanceWorkspaceCommit task={{ id: "demo", projectId: "demo", title: "改进页面交互", updatedAt: "1" } as TaskListItem} notify={setNotice} />
      <p role="status" data-testid="result">{notice}</p>
      {dialog && <CreateProjectDialog projects={[]} onClose={() => setDialog(false)} notify={setNotice}
        onCreated={created => { setDialog(false); setNotice(`已创建项目：${created.name} · ${created.repoPath}`); }} />}
    </main>
  </AuthContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
