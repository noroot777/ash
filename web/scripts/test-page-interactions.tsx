import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduledMessage } from "@ash/shared";
import { ScheduledMessageTray } from "../src/components/ScheduledMessageTray.tsx";
import { WorkspaceCommitNotice } from "../src/review/AcceptanceWorkspaceCommit.tsx";
import { workspaceCommitBlock, workspaceCommitPaths } from "../src/review/workspaceCommit.ts";
import type { ScmOverview, ScmChange } from "../src/lib/api.ts";

const change = (path: string, origPath: string | null = null): ScmChange => ({ path, origPath, kind: "modified", nested: false, conflict: null });
const overview = {
  root: { path: "/tmp/task", source: "worktree", isRepo: true }, taskRunning: false, readOnly: null,
  status: { branch: { head: "task", detached: false, oid: "abc", upstream: null, ahead: null, behind: null },
    staged: [change("both.txt")], unstaged: [change("both.txt"), change("new.txt", "old.txt")],
    untracked: [change("untracked.txt")], merge: [], operation: null, truncated: false }, commits: [],
} as ScmOverview;
assert.deepEqual(workspaceCommitPaths(overview.status), ["both.txt", "new.txt", "old.txt", "untracked.txt"]);
assert.equal(workspaceCommitBlock(overview), null);
assert.match(workspaceCommitBlock({ ...overview, taskRunning: true })!, /运行/);
assert.match(workspaceCommitBlock({ ...overview, readOnly: "已归档" })!, /归档/);
assert.match(workspaceCommitBlock({ ...overview, status: { ...overview.status, operation: "rebase" } })!, /Git 操作/);
assert.match(workspaceCommitBlock({ ...overview, status: { ...overview.status, truncated: true } })!, /不完整/);
assert.match(workspaceCommitBlock({ ...overview, status: { ...overview.status, untracked: [{ ...change("nested"), nested: true }] } })!, /嵌套/);
const notice = (value: ScmOverview, autoCommit = false) => renderToStaticMarkup(<WorkspaceCommitNotice overview={value}
  autoCommit={autoCommit} busy={false} error={null} onCommit={() => {}} onRefresh={() => {}} />);
assert.match(notice(overview), /有 3 个文件尚未提交/);
assert.match(notice(overview), /一键提交改动/);
assert.match(notice(overview), /项目未开启自动提交/);
assert.match(notice(overview, true), /点击验收时会先提交/);
assert.match(notice({ ...overview, taskRunning: true }), /disabled=""/);
assert.equal(notice({ ...overview, status: { ...overview.status, staged: [], unstaged: [], untracked: [] } }), "");

const message = (id: string): ScheduledMessage => ({ id, taskId: "task", text: id, attachments: [], agent: null,
  executorId: null, model: null, reasoningEffort: null, origin: null, sessionRole: null, mode: "queued",
  status: "pending", createdAt: "2026-10-28T00:00:00Z", sendAt: "2026-10-28T00:00:00Z", sentAt: null });
const tray = (messages: ScheduledMessage[]) => renderToStaticMarkup(<ScheduledMessageTray messages={messages} loading={false}
  error={null} cancelingIds={new Set()} onSteer={() => {}} onWithdraw={() => {}} onCancel={() => {}} />);
const mine = tray([message("mine")]);
assert.match(mine, /scheduled-message-previews/);
assert.match(mine, /scheduled-message-guide/);
assert.match(mine, /scheduled-message-withdraw/);
assert.doesNotMatch(mine, /is-expanded/);
const monitor = tray([{ ...message("monitor"), origin: "monitor:test", text: "【哨兵结束】检查，退出码 1。" }]);
assert.doesNotMatch(monitor, /scheduled-message-guide|scheduled-message-withdraw/);
assert.match(monitor, /取消哨兵事件/);
assert.match(monitor, /exit 1/);
const managed = tray([{ ...message("review"), sessionRole: "reviewer" }]);
assert.doesNotMatch(managed, /scheduled-message-guide|scheduled-message-withdraw|取消哨兵事件/);
assert.match(managed, /由审查链投递/);
const mixed = tray([{ ...message("0-monitor"), origin: "monitor:test" }, message("1-mine"), message("2-mine")]);
assert.equal((mixed.match(/class="scheduled-message-guide"/g) ?? []).length, 1);
assert.equal((mixed.match(/class="scheduled-message-withdraw"/g) ?? []).length, 2);
const monitorFirst = tray([{ ...message("0-monitor"), origin: "monitor:test" },
  { ...message("1-monitor"), origin: "monitor:test" }, message("2-mine")]);
assert.match(monitorFirst, /scheduled-message-guide/);
assert.match(monitorFirst, /scheduled-message-withdraw/);
const css = readFileSync(new URL("../src/styles/scheduled-message-tray.css", import.meta.url), "utf8");
assert.doesNotMatch(css, /\.scheduled-message-previews[^{}]*> button[^{}]*\{[^{}]*display:\s*none/);
console.log("page interactions: commit safety, collapsed user actions, monitor and review message compatibility passed");
