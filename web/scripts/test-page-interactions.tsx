import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduledMessage } from "@ash/shared";
import { ScheduledMessageTray } from "../src/components/ScheduledMessageTray.tsx";
import { AutoCommitCheck, WorkspaceCommitRow } from "../src/acceptance/WorkspaceCheck.tsx";
import { workspaceCommitBlock, workspaceCommitPaths } from "../src/review/workspaceCommit.ts";
import type { ScmOverview, ScmChange } from "../src/lib/api.ts";
import { api } from "../src/lib/api.ts";

const originalFetch = globalThis.fetch;
const requests: { path: string; init?: RequestInit }[] = [];
globalThis.fetch = async (input, init) => {
  requests.push({ path: String(input), init });
  return Response.json({ sha: "test-commit" });
};
try {
  const taskId = "task / with spaces";
  await api.scmCommit(taskId, "normal commit");
  await api.scmCommit(taskId, "acceptance commit", { acceptance: true, stagePaths: ["task.txt"] });
  await api.scmCommit(taskId, "amend commit", { acceptance: false, amend: true, force: true });
  const root = `/api/tasks/${encodeURIComponent(taskId)}/scm`;
  assert.deepEqual(requests.map(request => request.path), [`${root}/commit`, `${root}/acceptance-commit`, `${root}/commit`]);
  assert.ok(requests.every(request => request.init?.method === "POST"));
  assert.deepEqual(requests.map(request => JSON.parse(String(request.init?.body))), [
    { message: "normal commit" },
    { message: "acceptance commit", acceptance: true, stagePaths: ["task.txt"] },
    { message: "amend commit", acceptance: false, amend: true, force: true },
  ]);
} finally {
  globalThis.fetch = originalFetch;
}

const change = (path: string, origPath: string | null = null): ScmChange => ({ path, origPath, kind: "modified", nested: false, conflict: null });
const overview: ScmOverview = {
  root: { path: "/tmp/task", source: "worktree", branch: "task", gitRepo: true }, taskRunning: false, readOnly: null, acceptanceCommitBlock: null,
  acceptanceAutoCommit: { action: "disabled", reason: "项目未开启验收前自动提交" },
  status: { branch: { head: "task", detached: false, oid: "abc", upstream: null, ahead: null, behind: null },
    staged: [change("both.txt")], unstaged: [change("both.txt"), change("new.txt", "old.txt")],
    untracked: [change("untracked.txt")], merge: [], operation: null, truncated: false }, commits: [],
};
assert.deepEqual(workspaceCommitPaths(overview.status), ["both.txt", "new.txt", "old.txt", "untracked.txt"]);
assert.equal(workspaceCommitBlock(overview), null);
assert.match(workspaceCommitBlock({ ...overview, acceptanceCommitBlock: undefined })!, /尚未确认/);
assert.match(workspaceCommitBlock({ ...overview, acceptanceCommitBlock: "共用项目目录，不属于任务独占工作区" })!, /共用项目目录/);
assert.match(workspaceCommitBlock({ ...overview, taskRunning: true })!, /运行/);
assert.match(workspaceCommitBlock({ ...overview, readOnly: "已归档" })!, /归档/);
assert.match(workspaceCommitBlock({ ...overview, status: { ...overview.status, operation: "rebase" } })!, /Git 操作/);
assert.match(workspaceCommitBlock({ ...overview, status: { ...overview.status, truncated: true } })!, /不完整/);
assert.match(workspaceCommitBlock({ ...overview, status: { ...overview.status, untracked: [{ ...change("nested"), nested: true }] } })!, /嵌套/);
// 前提列里那一行（WorkspaceCommitRow）：文字是「N 个文件未提交」，状态那半句照抄服务端预检，行尾只有「提交」。
// 展开层（为什么不能提交、文件清单）默认收着，静态渲染里不出现。
const notice = (value: ScmOverview, props: { busy?: boolean; disabled?: boolean; error?: string | null } = {}) => renderToStaticMarkup(
  <WorkspaceCommitRow overview={value} busy={props.busy ?? false} disabled={props.disabled} error={props.error ?? null} onCommit={() => {}} />);
const submitButton = (html: string) => html.match(/<button[^>]*class="acc-btn is-sm"[^>]*>.*?<\/button>/)?.[0] ?? "";
assert.match(notice(overview), /data-check="workspace"/);
assert.match(notice(overview), /class="acc-check is-warn/);
assert.match(notice(overview), /3 个文件未提交/);
assert.match(submitButton(notice(overview)), />提交<\/button>/);
assert.doesNotMatch(submitButton(notice(overview)), /disabled=""/);
assert.match(notice(overview), /项目未开启验收前自动提交/);
assert.match(notice({ ...overview, acceptanceAutoCommit: { action: "commit", reason: "预检通过，验收时将尝试提交" } }), /预检通过/);
for (const reason of ["任务正在运行", "存在冲突", "存在未完成的 Git 操作", "文件列表不完整", "包含嵌套 Git 仓库", "不是独占工作区"]) {
  const html = notice({ ...overview, acceptanceAutoCommit: { action: "skip", reason } });
  assert.match(html, /验收时不会替你提交/);
  assert.ok(html.includes(reason));
  assert.doesNotMatch(html, /会先提交|预检通过/);
}
assert.match(notice({ ...overview, acceptanceAutoCommit: undefined }), /验收时会不会替你提交还没确认/);
assert.match(renderToStaticMarkup(<AutoCommitCheck outcome={{ status: "skipped", reason: "共用项目目录" }} />), /已跳过验收前自动提交：共用项目目录/);
assert.match(renderToStaticMarkup(<AutoCommitCheck outcome={{ status: "skipped", reason: "共用项目目录" }} />), /data-check="auto-commit"/);
assert.match(renderToStaticMarkup(<AutoCommitCheck outcome={{ status: "committed", reason: "预检通过", sha: "abcdef1234567" }} />), /is-passed[^"]*"[^>]*>[\s\S]*abcdef12/);
assert.match(renderToStaticMarkup(<AutoCommitCheck outcome={{ status: "failed", reason: "提交失败" }} />), /class="acc-check is-warn/);
// 任务在跑：「提交」灰着，状态说清等它结束；灰着不是正在提交（不转圈、不 aria-busy）。
const running = notice({ ...overview, taskRunning: true });
assert.match(submitButton(running), /disabled=""/);
assert.match(running, /任务还在跑，结束后再提交/);
assert.doesNotMatch(running, /acc-spin|aria-busy/);
const disabledNotice = notice(overview, { disabled: true });
assert.match(submitButton(disabledNotice), /disabled=""/);
assert.doesNotMatch(disabledNotice, /acc-spin|aria-busy/);
// 正在提交：同一颗键转圈 + aria-busy，文字不变。
const busyNotice = notice(overview, { busy: true });
assert.match(submitButton(busyNotice), /aria-busy="true"/);
assert.match(submitButton(busyNotice), /acc-spin/);
assert.match(submitButton(busyNotice), />提交<\/button>/);
// 提交失败：这一行变红，状态那半句换成失败原因。
const failed = notice(overview, { error: "提交失败：请配置 Git 用户信息" });
assert.match(failed, /class="acc-check is-block/);
assert.match(failed, /请配置 Git 用户信息/);
assert.doesNotMatch(failed, /项目未开启验收前自动提交/);
// 归属拿不准（共用项目目录等）：「提交」灰着。
assert.match(submitButton(notice({ ...overview, acceptanceCommitBlock: "共用项目目录，不属于任务独占工作区" })), /disabled=""/);
assert.equal(notice({ ...overview, status: { ...overview.status, staged: [], unstaged: [], untracked: [] } }), "");
// 重读失败（下面摆的还是上一次读到的）：状态说「重读失败」，行尾多一个「重试」；干净的工作区也照样出这一行，
// 不然读失败了既看不出来也没处补。
const stale = (value: ScmOverview) => renderToStaticMarkup(
  <WorkspaceCommitRow overview={value} busy={false} error={null} readError="网络断了" onCommit={() => {}} onRetry={() => {}} />);
assert.match(stale(overview), /重读失败：网络断了/);
assert.match(stale(overview), />重试<\/button>/);
assert.match(stale(overview), />提交<\/button>/);
const cleanStale = stale({ ...overview, status: { ...overview.status, staged: [], unstaged: [], untracked: [] } });
assert.match(cleanStale, /未提交改动待核对/);
assert.match(cleanStale, />重试<\/button>/);
assert.doesNotMatch(cleanStale, />提交<\/button>/);

const message = (id: string): ScheduledMessage => ({ id, taskId: "task", text: id, attachments: [], agent: null,
  executorId: null, model: null, reasoningEffort: null, origin: null, sessionRole: null, mode: "queued",
  status: "pending", createdAt: "2026-10-28T00:00:00Z", sendAt: "2026-10-28T00:00:00Z", sentAt: null });
const tray = (messages: ScheduledMessage[]) => renderToStaticMarkup(<ScheduledMessageTray messages={messages} loading={false}
  error={null} cancelingIds={new Set()} onSteer={() => {}} onWithdraw={() => {}} onCancel={() => {}} />);
const mine = tray([{ ...message("mine"), steerable: true }]);
assert.match(mine, /scheduled-message-previews/);
assert.match(mine, /scheduled-message-guide/);
assert.match(mine, /scheduled-message-withdraw/);
assert.doesNotMatch(mine, /is-expanded/);
assert.doesNotMatch(tray([message("idle")]), /scheduled-message-guide/, "服务端没说能引导(任务不在跑、旧服务端)就不给这颗键");
const monitor = tray([{ ...message("monitor"), origin: "monitor:test", text: "【哨兵结束】检查，退出码 1。" }]);
assert.doesNotMatch(monitor, /scheduled-message-guide|scheduled-message-withdraw/);
assert.match(monitor, /取消哨兵事件/);
assert.match(monitor, /exit 1/);
const managed = tray([{ ...message("review"), sessionRole: "reviewer" }]);
assert.doesNotMatch(managed, /scheduled-message-guide|scheduled-message-withdraw|取消哨兵事件/);
assert.match(managed, /由审查链投递/);
const mixed = tray([{ ...message("0-monitor"), origin: "monitor:test" }, { ...message("1-mine"), steerable: true }, message("2-mine")]);
assert.equal((mixed.match(/class="scheduled-message-guide"/g) ?? []).length, 1);
assert.equal((mixed.match(/class="scheduled-message-withdraw"/g) ?? []).length, 2);
const monitorFirst = tray([{ ...message("0-monitor"), origin: "monitor:test" },
  { ...message("1-monitor"), origin: "monitor:test" }, { ...message("2-mine"), steerable: true }]);
assert.match(monitorFirst, /scheduled-message-guide/);
assert.match(monitorFirst, /scheduled-message-withdraw/);
const css = readFileSync(new URL("../src/styles/scheduled-message-tray.css", import.meta.url), "utf8");
assert.doesNotMatch(css, /\.scheduled-message-previews[^{}]*> button[^{}]*\{[^{}]*display:\s*none/);
console.log("page interactions: extracted SCM API routing, commit safety, collapsed user actions, monitor and review message compatibility passed");
