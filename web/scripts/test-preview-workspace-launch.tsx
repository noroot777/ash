import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspacePreviewLaunch } from "../../shared/src/preview.ts";
import type { FreeWorkflowPreviewState } from "../../shared/src/free-workflow.ts";
import type { AnnotationBatchRecord } from "../../shared/src/page-annotation-batch.ts";
import { PreviewLaunchOptions } from "../src/preview-workspace/PreviewLauncher.tsx";
import { PreviewWorkspaceStage, previewWorkspaceLaunchHint } from "../src/preview-workspace/PreviewWorkspaceStage.tsx";
import { createPreviewLaunchController, type PreviewLaunchState } from "../src/preview-workspace/previewLaunchController.ts";
import type { useAnnotationBatch } from "../src/preview-workspace/useAnnotationBatch.ts";
import type { useAnnotationReview } from "../src/preview-workspace/useAnnotationReview.ts";
import type { request } from "../src/lib/apiClient.ts";

Object.assign(globalThis, { React });
const info: WorkspacePreviewLaunch = { kind: "free", reason: "", directory: "/task/worktree", steps: [], configured: null, truncated: false,
  candidates: [{ id: "site", name: "dist 静态页面", command: "serve dist", directory: "dist", enabled: false, kind: "web", requiresSelection: true }] };
const state: PreviewLaunchState = { info, loading: false, action: null, error: "", notice: "" };
const html = (patch: Partial<PreviewLaunchState> = {}, starting = false) => renderToStaticMarkup(<PreviewLaunchOptions
  state={{ ...state, ...patch }} starting={starting} stopped={false} onStart={() => {}} onCancel={() => {}} onRetry={() => {}} />);
assert.match(html(), /启动 dist 静态页面/);
assert.match(html(), /不经过构建/);
assert.match(html(), /本次预览命令/);
assert.match(html(), /改用截图批注/);
assert.match(html({ loading: true, info: null }), /正在检查任务工作目录/);
assert.match(html({ action: "opening" }, true), /就绪后会自动接入/);
assert.match(html({ error: "进程已退出\nMODULE_NOT_FOUND" }), /role="alert"[^>]*>进程已退出\nMODULE_NOT_FOUND/);
assert.match(renderToStaticMarkup(<PreviewLaunchOptions state={state} starting={false} stopped={false} failed
  onStart={() => {}} onCancel={() => {}} onRetry={() => {}} />), /上次预览未能启动或已退出/);
const gone = html({ info: { ...info, directory: null, reason: "任务工作目录已不存在，已验收清理" } });
assert.match(gone, /已验收清理/); assert(!gone.includes("启动 dist 静态页面"));
const preset = html({ info: { ...info, kind: "workflow", steps: [{ id: "first", command: "npm run dev" }, { id: "second", command: "npm start" }] } });
assert.match(preset, /预览步骤/); assert.match(preset, /启动工作流预览/);

const idle: FreeWorkflowPreviewState = { running: false, starting: false, hasLog: false, url: null, port: null, command: null, startedAt: null };
const direct: FreeWorkflowPreviewState = { ...idle, running: true, proxied: false, url: "http://localhost:5173", command: "npm run dev",
  services: [{ id: "main", name: "预览脚本", command: "npm run dev", status: "ready", url: "http://localhost:5173", port: 5173 }] };
const current = direct.services![0];
const directHint = previewWorkspaceLaunchHint(direct, current, false, false);
assert.match(directHint, /直连方式运行.*代理方式重启/);
const options = (patch: Partial<PreviewLaunchState> = {}) => renderToStaticMarkup(<PreviewLaunchOptions
  state={{ ...state, info: { ...info, configured: { command: current.command } }, ...patch }} starting={false} stopped={false}
  restarting hint={directHint} onStart={() => {}} onCancel={() => {}} onRetry={() => {}} />);
assert.match(options(), /以代理方式在工作区重启/);
assert.match(options(), /直连方式运行/);
assert.match(options(), /<button type="button">按已保存配置重启<\/button>/, "a ready direct preview must offer an enabled restart action");
const gated = options({ info: { ...info, reason: "还有待投递的后续消息" } });
assert.match(gated, /还有待投递的后续消息/);
assert(!gated.includes("按已保存配置重启"));
assert.match(gated, /改用截图批注/);

const delivered: AnnotationBatchRecord = { revision: 1, state: "reviewable", messageId: "sent", savedAt: "2026-09-11", deliveredAt: "2026-09-11", error: null,
  review: { releasedAt: "2026-09-11", roundStatus: "done", decisions: [] },
  batch: { id: "batch", taskId: "task", gen: "old", serviceId: "main", createdAt: 1, items: [], evidence: [] } };
const review = { canPrompt: true, dismissed: false, busy: false, error: "", status: { canReopen: true, reason: "" } } as ReturnType<typeof useAnnotationReview>;
const stage = (preview: FreeWorkflowPreviewState | null, records: AnnotationBatchRecord[] = [], source: string | null = null) => renderToStaticMarkup(
  <PreviewWorkspaceStage taskId="task" source={source} preview={preview} refresh={async () => {}} hint={directHint}
    controller={{ records, busy: false, review: false } as ReturnType<typeof useAnnotationBatch>} review={review}>
    <iframe src={source ?? undefined} title="任务页面预览" />
  </PreviewWorkspaceStage>);
for (const preview of [null, idle, direct, { ...direct, proxied: true }, { ...direct, starting: true },
  { ...direct, running: false, services: [{ ...current, status: "failed" as const }] },
  { ...direct, running: false, services: [{ ...current, status: "stopped" as const }] }]) {
  const empty = stage(preview);
  assert.match(empty, /aria-label="启动页面预览"/, "every source-less state must render the launcher, including ready direct services");
  assert(!empty.includes("<iframe"));
  assert(!empty.includes("修改期等待区"), "services alone must not create an annotation waiting area");
  const withBatch = stage(preview, [delivered]);
  assert(withBatch.indexOf('aria-label="启动页面预览"') < withBatch.indexOf('aria-label="修改期等待区"'), "launch actions precede delivered history");
  assert(!withBatch.includes(">重新打开预览</button>"), "the waiting area must not offer a competing legacy reopen action");
}
assert(!stage(direct, [{ ...delivered, messageId: null, state: "saved" }]).includes("修改期等待区"));
const embedded = stage({ ...direct, proxied: true }, [delivered], "/api/tasks/task/preview/open/main");
assert.match(embedded, /<iframe src="\/api\/tasks\/task\/preview\/open\/main"/);
assert(!embedded.includes("启动页面预览")); assert(!embedded.includes("修改期等待区"));
assert.match(previewWorkspaceLaunchHint({ ...direct, starting: true }, undefined, true, true), /查看日志或取消启动/);
assert.match(previewWorkspaceLaunchHint(direct, current, true, true), /批注已投递.*查看启动条件/);
assert.match(previewWorkspaceLaunchHint({ ...direct, proxied: true }, current, false, true), /投递批注前的版本.*重新启动/);
assert.match(previewWorkspaceLaunchHint(idle, undefined, false, false), /选择并启动预览/);

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function scenario(kind: WorkspacePreviewLaunch["kind"]) {
  const posts: Array<{ path: string; body: unknown }> = [];
  let pending = deferred();
  let refreshes = 0;
  let snapshot = { ...info, kind };
  const send: typeof request = async <T,>(path: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push({ path, body: JSON.parse(String(init.body)) }); return await pending.promise as T; }
    if (init?.method === "DELETE") return { stopped: true } as T;
    return snapshot as T;
  };
  const controller = createPreviewLaunchController("task / one", async () => { ++refreshes; }, send);
  controller.activate(); await controller.load();
  const launch = controller.start({ command: current.command, ...(kind === "workflow" ? { stepId: "chosen" } : {}) }, direct);
  assert.equal(controller.snapshot().action, "opening");
  await controller.start({ command: "duplicate" }, direct);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, `/tasks/task%20%2F%20one/${kind === "free" ? "free-workflow/preview" : "preview/restart"}`);
  assert.deepEqual(posts[0].body, { command: current.command, ...(kind === "workflow" ? { stepId: "chosen" } : {}), workspace: true });
  pending.resolve({ running: true, starting: false }); await launch;
  assert(refreshes > 0, "ready response must refresh the iframe service snapshot");
  assert.match(controller.snapshot().notice, /已就绪/);

  pending = deferred();
  const fail = controller.start({ command: "bad command" }, idle);
  pending.reject(new Error("缺少依赖\nMODULE_NOT_FOUND")); await fail;
  assert.equal(controller.snapshot().error, "缺少依赖\nMODULE_NOT_FOUND");
  assert.equal(controller.snapshot().action, null);
  await controller.load();
  assert.match(controller.snapshot().error, /MODULE_NOT_FOUND/, "polling must retain the failure");

  pending = deferred();
  const canceled = controller.start({ command: "slow" }, idle);
  await controller.cancel();
  const afterCancel = refreshes;
  pending.resolve({ running: true }); await canceled;
  assert.equal(refreshes, afterCancel, "late success cannot reconnect a canceled preview");
  assert.match(controller.snapshot().notice, /已取消/);

  snapshot = { ...snapshot, reason: "还有待投递的后续消息" };
  await controller.load();
  const count = posts.length;
  await controller.start({ command: "blocked" }, direct); assert.equal(posts.length, count);
  snapshot = { ...snapshot, reason: "" }; await controller.load();
  await controller.start({ command: "unknown preview" }, null); assert.equal(posts.length, count);
  await controller.start({ command: "already starting" }, { ...direct, starting: true }); assert.equal(posts.length, count);
  pending = deferred();
  const leaving = controller.start({ command: "old task" }, idle);
  controller.dispose(); const beforeLate = refreshes;
  pending.resolve({ running: true }); await leaving;
  assert.equal(refreshes, beforeLate, "a departed task must not refresh the current iframe");
}
await scenario("free"); await scenario("workflow");
console.log("preview workspace: ready direct restart, source-less launch states, delivered history priority, embedded page, candidates, guards, free/workflow launch and duplicate/cancel/task-switch races passed");
