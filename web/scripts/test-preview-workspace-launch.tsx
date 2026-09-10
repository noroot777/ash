import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspacePreviewLaunch } from "../../shared/src/preview.ts";
import { PreviewLaunchOptions } from "../src/preview-workspace/PreviewLauncher.tsx";
import { createPreviewLaunchController, type PreviewLaunchState } from "../src/preview-workspace/previewLaunchController.ts";
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
  const launch = controller.start({ command: "serve dist", ...(kind === "workflow" ? { stepId: "chosen" } : {}) }, false);
  assert.equal(controller.snapshot().action, "opening");
  await controller.start({ command: "duplicate" }, false);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, `/tasks/task%20%2F%20one/${kind === "free" ? "free-workflow/preview" : "preview/restart"}`);
  assert.deepEqual(posts[0].body, { command: "serve dist", ...(kind === "workflow" ? { stepId: "chosen" } : {}), workspace: true });
  pending.resolve({ running: true, starting: false }); await launch;
  assert(refreshes > 0, "ready response must refresh the iframe service snapshot");
  assert.match(controller.snapshot().notice, /已就绪/);

  pending = deferred();
  const fail = controller.start({ command: "bad command" }, false);
  pending.reject(new Error("缺少依赖\nMODULE_NOT_FOUND")); await fail;
  assert.equal(controller.snapshot().error, "缺少依赖\nMODULE_NOT_FOUND");
  assert.equal(controller.snapshot().action, null);
  await controller.load();
  assert.match(controller.snapshot().error, /MODULE_NOT_FOUND/, "polling must retain the failure");

  pending = deferred();
  const canceled = controller.start({ command: "slow" }, false);
  await controller.cancel();
  const afterCancel = refreshes;
  pending.resolve({ running: true }); await canceled;
  assert.equal(refreshes, afterCancel, "late success cannot reconnect a canceled preview");
  assert.match(controller.snapshot().notice, /已取消/);

  snapshot = { ...snapshot, reason: "还有待投递的后续消息" };
  await controller.load();
  const count = posts.length;
  await controller.start({ command: "blocked" }, false); assert.equal(posts.length, count);
  snapshot = { ...snapshot, reason: "" }; await controller.load();
  await controller.start({ command: "already starting" }, true); assert.equal(posts.length, count);
  pending = deferred();
  const leaving = controller.start({ command: "old task" }, false);
  controller.dispose(); const beforeLate = refreshes;
  pending.resolve({ running: true }); await leaving;
  assert.equal(refreshes, beforeLate, "a departed task must not refresh the current iframe");
}
await scenario("free"); await scenario("workflow");
console.log("preview workspace: candidates, missing workspace, failures, free/workflow launch, auto refresh, duplicate/cancel/task-switch races passed");
