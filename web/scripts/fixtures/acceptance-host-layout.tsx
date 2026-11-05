import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, Task } from "@ash/shared";
import type { ScmOverview } from "../../src/lib/api.ts";
import { AuthContext } from "../../src/auth/authContext.ts";
import { AcceptanceControls } from "../../src/team/TeamReviewWorkspace.tsx";
import { TaskStatusDot } from "../../src/components/TaskStatusDot.tsx";
import "../../src/styles/global.css";

// 验收动作宿主(.acceptance-host)的几何舞台:三处宿主——普通任务顶栏、团队顶栏、讨论
// 结论那条横条——摆的是同一副形状,这里把它们并排铺出来,让 AcceptanceControls 带着
// 一串真实状态卡展开。判据与来由见 test-acceptance-host-layout.mjs。
//
// 状态文案给的是现场那一句(2026-11-02,任务 9tdMZpxobLQT):验收受阻时整句理由会被填进
// 主按钮当标签,长度没有上限。再多挂一个**没有 class 的** <p> —— 真实的
// AutoCommitOutcomeNotice 就是这样一个裸节点,按 class 列白名单的做法根本收不进它。
//
// 项目**没设**验收前置命令:设了命令时「验收通过」住进门禁卡的按钮行、门禁在跑时干脆不摆
// (1e4b9b61),顶栏里就没有那颗长标签主按钮可量了。没设命令时它仍在顶栏,受阻理由照样整句
// 填进去 —— 量的是标签长度对宿主的冲击,那句现场原文只是长度样本。
const BLOCK = "验收前置命令尚未确认整棵进程树退出，工作区仍被占用；暂不能合并或清理。";
const LOOSE_NOTE = "已跳过验收前自动提交：工作目录没有待提交改动";

const task = {
  id: "host-task", projectId: "proj-1", title: "ui 溢出了", body: "", labels: [], dependsOn: [], resumeDependsOn: [],
  agentType: "claude", mode: "single", status: "done", stage: "verified", useWorktree: false, workflowMode: "free",
  createdAt: "2026-11-02T01:03:00.000Z", updatedAt: "2026-11-02T01:24:00.000Z",
} as unknown as Task;

const overview: ScmOverview = {
  root: { path: "/repo", branch: "main", source: "project", gitRepo: true }, taskRunning: false, readOnly: null,
  acceptanceCommitBlock: null, acceptanceAutoCommit: { action: "skip", reason: "工作目录没有待提交改动" },
  status: {
    branch: { head: "main", detached: false, oid: "abc", upstream: null, ahead: null, behind: null },
    // 工作目录干净 —— 现场就是这一档（所以那句「已跳过验收前自动提交」才会出现，而
    // AcceptanceWorkspaceCommit 自己隐藏）。没有它插在中间，裸 <p> 才会和动作簇同排，
    // 复现出标题被两个宽邻居夹掉的那一行。
    staged: [], unstaged: [], untracked: [], merge: [], operation: null, truncated: false,
  }, commits: [],
} as unknown as ScmOverview;

const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
// SSE 在这一屏里只负责「有变化就重读」,舞台上不发事件,挂一个空壳免得它反复重连。
window.EventSource = class { close() {} } as unknown as typeof EventSource;
window.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.pathname === "/api/projects") return response([{ id: "proj-1", name: "harness", repoPath: "/repo",
    myRole: "admin", acceptGateCommand: null } as unknown as ProjectView]);
  if (url.pathname === "/api/tasks/host-task/accept-gate") return response({ command: null, running: null, latest: null, basis: null });
  if (url.pathname === "/api/tasks/host-task/scm") return response(overview);
  if (url.pathname === "/api/tasks/host-task") return response(task);
  throw new Error(`验证页面拒绝未声明的请求：${url.pathname}`);
};

function Controls() {
  const [, setNotice] = useState("");
  return <AcceptanceControls task={task} onTaskUpdated={() => {}} notify={setNotice} acceptanceBlock={BLOCK} />;
}

function Fixture() {
  return <AuthContext.Provider value={{ state: { mode: "single", user: null, needsSetup: false }, refresh: async () => {} }}>
    <section className="single-review-workspace" data-host="single">
      <header className="single-review-subbar acceptance-host">
        <div className="acceptance-host-title"><b>改动与提交</b><small>验证证据见右侧审查记录；这里核对任务分支相对基线的提交与 diff</small></div>
        <Controls />
        <p role="status">{LOOSE_NOTE}</p>
      </header>
    </section>
    <section className="team-review-workspace" data-host="team">
      <header className="team-review-subbar acceptance-host">
        <div className="acceptance-host-title"><b>团队验收台</b><small>核对共享分支与独立 worktree 后分别验收或打回。</small></div>
        <Controls />
        <p role="status">{LOOSE_NOTE}</p>
      </header>
    </section>
    {/* 团队里每个独立执行者那张记录卡的 header（TeamReviewWorkspace.tsx 的 ReviewRecord）。
        它不是 export 的、还要拉 commits/diff/body，所以这里照它的结构手搓一份：要点是
        标题块前面还站着展开钮和状态点，标题认的是显式标记而不是「第一个孩子」。 */}
    <article className="team-review-record" data-host="record">
      <header className="acceptance-host">
        <button type="button" aria-expanded="false" aria-label="展开">▾</button>
        <TaskStatusDot indicator="error" surface="team" />
        <button type="button" className="team-review-record-title acceptance-host-title">
          <span><b>执行者 1 · 修复顶栏布局</b><em>执行者 1</em><small>验证未通过</small></span>
          <p>把验收动作宿主的布局契约从白名单改成默认，并补上回归。</p>
        </button>
        <Controls />
        <p role="status">{LOOSE_NOTE}</p>
      </header>
    </article>
    <div className="duet-terminal-handoff" data-host="duet">
      <div className="duet-terminal-acceptance acceptance-host">
        <div className="acceptance-host-title"><b>讨论结论</b><small>确认这份结论，或带着意见让双方继续讨论。</small></div>
        <Controls />
        <p role="status">{LOOSE_NOTE}</p>
      </div>
    </div>
  </AuthContext.Provider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
