import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffPreflightResult, HandoffTarget, Task } from "@ash/shared";
import { api, makeRepo, startPeer } from "./handoff-test-utils.js";
import { killOne, listenerPidsSync } from "../src/platform.js";

const root = mkdtempSync(join(tmpdir(), "ash-handoff-return-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ASH_DB = join(root, "attacker.db");

const children: ChildProcess[] = [];
const serverPorts: number[] = [];
const remember = (proc: ChildProcess) => children.push(proc);

try {
  const repoA = makeRepo(join(root, "repo-a"));
  const repoB = join(root, "repo-b");
  execFileSync("git", ["clone", "--quiet", repoA, repoB]);

  const machineA = await startPeer({
    ASH_DB: join(root, "a.db"),
    ASH_RUNS_DIR: join(root, "runs-a"),
    ASH_UPLOADS_DIR: join(root, "uploads-a"),
  }, remember);
  const machineB = await startPeer({
    ASH_DB: join(root, "b.db"),
    ASH_RUNS_DIR: join(root, "runs-b"),
    ASH_UPLOADS_DIR: join(root, "uploads-b"),
  }, remember);
  serverPorts.push(Number(new URL(machineA).port), Number(new URL(machineB).port));

  const projectA = await api<{ id: string }>(machineA, "/projects", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "harness", repoPath: repoA }),
  });
  const projectB = await api<{ id: string }>(machineB, "/projects", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "harness", repoPath: repoB }),
  });
  const task = await api<Task>(machineA, "/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: projectA.id,
      title: "免重复审批移回",
      body: "验证接力回程只认原持有机",
      mode: "single",
      workflowMode: "free",
      useWorktree: false,
    }),
  });

  await api(machineA, "/settings", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ handoffTargets: [{ name: "B", url: machineB }] }),
  });
  await api(machineA, "/handoff/request", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineB }),
  });
  const identityA = await api<{ fingerprint: string }>(machineA, "/handoff/identity");
  await api(machineB, `/handoff/peers/${identityA.fingerprint}/approve`, { method: "POST" });

  await api(machineA, `/tasks/${task.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineB, targetProjectId: projectB.id, targetName: "B", autoResume: false }),
  });
  const inbound = await api<Task>(machineB, `/tasks/${task.id}`);
  assert.equal(inbound.handoff?.direction, "in");
  assert.equal(inbound.handoff?.peerUrl, machineA, "接收机应从真实来源地址与源端口恢复回程地址");

  const { target } = await api<{ target: HandoffTarget }>(machineB, `/tasks/${task.id}/handoff/return-target`);
  assert.equal(target.url, machineA);
  assert.equal(target.peerFp, identityA.fingerprint);

  // 设置里同指纹的地址可能已经过期；本次任务导入从 TCP 恢复出的 peerUrl 更新，必须优先。
  await api(machineB, "/settings", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      handoffTargets: [{ name: "过期的 A", url: "http://127.0.0.1:1", peerFp: identityA.fingerprint }],
    }),
  });
  const { target: markerTarget } = await api<{ target: HandoffTarget }>(machineB, `/tasks/${task.id}/handoff/return-target`);
  assert.equal(markerTarget.url, machineA, "任务刚恢复的 peerUrl 不应被设置里的旧 URL 盖掉");

  const { sourceUrlFromPeer } = await import("../src/handoff-return.js");
  assert.equal(sourceUrlFromPeer("mac-mini.local", 4317), "http://mac-mini.local:4317", "mDNS 主机名应能组成回程地址");
  assert.equal(sourceUrlFromPeer("bad host", 4317), null, "非法主机名不能进入 URL");

  const { peerRequestHeaders } = await import("../src/handoff-peer-client.js");
  const forgedBody = JSON.stringify({
    taskId: task.id,
    returnTransferId: inbound.handoff?.transferId,
    nonce: "third-machine-return-probe",
  });
  const forged = await fetch(`${machineA}/api/handoff/return/ping`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...peerRequestHeaders(`${machineA}/api/handoff/return/ping`, "POST", forgedBody),
    },
    body: forgedBody,
  });
  assert.equal(forged.status, 403, "第三台机器即使知道 taskId 与 transferId，也不能冒充当前持有机移回");

  const firstProbe = await api<HandoffPreflightResult>(machineB, `/tasks/${task.id}/handoff/preflight`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: target.url }),
  });
  assert.equal(firstProbe.peer?.peerStatus, "approved", "任务级安全移回不应要求原机再次批准整台机器");
  assert.deepEqual(firstProbe.projects.map((project) => project.id), [projectA.id], "免审批探测只应暴露原任务项目");

  // 显式拉黑仍然优先：先用普通申请让 B 出现在 A 的来源列表，再拉黑它。
  await api(machineB, "/handoff/request", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: machineA }),
  });
  const identityB = await api<{ fingerprint: string }>(machineB, "/handoff/identity");
  await api(machineA, `/handoff/peers/${identityB.fingerprint}/block`, { method: "POST" });
  const blocked = await fetch(`${machineB}/api/tasks/${task.id}/handoff/preflight`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: target.url }),
  });
  assert.equal(blocked.status, 502);
  assert.match(((await blocked.json()) as { error: string }).error, /明确拒绝|不能自动移回/);

  // 忘记这条整机级记录后，不需要 approve；任务历史里的持有者指纹本身就是回程凭据。
  await api(machineA, `/handoff/peers/${identityB.fingerprint}`, { method: "DELETE" });
  const probeAfterForget = await api<HandoffPreflightResult>(machineB, `/tasks/${task.id}/handoff/preflight`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: target.url }),
  });
  assert.equal(probeAfterForget.peer?.peerStatus, "approved");

  await api(machineB, `/tasks/${task.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: target.url, targetProjectId: projectA.id, targetName: "A", autoResume: false }),
  });
  const returned = await api<Task>(machineA, `/tasks/${task.id}`);
  assert.equal(returned.handoff?.direction, "returned");

  const peersOnA = await api<{ peers: { fingerprint: string }[] }>(machineA, "/handoff/peers");
  assert.ok(!peersOnA.peers.some((peer) => peer.fingerprint === identityB.fingerprint), "免审批移回不应暗中建立整机级批准记录");

  // 新版 return/ping 的任务级 404 必须原样失败，不能误当成“旧版没有路由”再退回普通 ping。
  const missingArchiveTask = await api<Task>(machineA, "/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: projectA.id,
      title: "原机存档缺失",
      body: "验证业务 404 不被兼容分支吞掉",
      mode: "single",
      workflowMode: "free",
      useWorktree: false,
    }),
  });
  await api(machineA, `/tasks/${missingArchiveTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineB, targetProjectId: projectB.id, targetName: "B", autoResume: false }),
  });
  await api(machineA, `/tasks/${missingArchiveTask.id}`, { method: "DELETE" });
  const missingArchive = await fetch(`${machineB}/api/tasks/${missingArchiveTask.id}/handoff/preflight`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineA }),
  });
  const missingArchiveBody = (await missingArchive.json()) as { error?: string };
  assert.equal(missingArchive.status, 502);
  assert.match(missingArchiveBody.error ?? "", /原机没有这条任务的历史存档/);
  console.log("test-handoff-return ok");
} finally {
  for (const port of serverPorts) {
    for (const pid of listenerPidsSync(port)) killOne(pid, "SIGKILL");
  }
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
