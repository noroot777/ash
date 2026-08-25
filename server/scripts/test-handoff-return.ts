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
      useWorktree: true,
    }),
  });
  const { prepareWorktree } = await import("../src/git.js");
  await prepareWorktree(repoA, task.id, task.worktreeBase);

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

  const { assertReturnProject, sourceUrlFromPeer } = await import("../src/handoff-return.js");
  assert.equal(sourceUrlFromPeer("mac-mini.local", 4317), "http://mac-mini.local:4317", "mDNS 主机名应能组成回程地址");
  assert.equal(sourceUrlFromPeer("bad host", 4317), null, "非法主机名不能进入 URL");
  assert.throws(
    () => assertReturnProject("other-project", projectA.id),
    (error: unknown) => error instanceof Error
      && (error as { status?: number }).status === 403
      && /原任务所属项目/.test(error.message),
    "免审批 return/import 不能接受持有机篡改的目标项目",
  );

  const { peerRequestHeaders } = await import("../src/handoff-peer-client.js");
  const { resetIdentityCache } = await import("../src/handoff-identity.js");
  const attackerDb = process.env.ASH_DB!;
  const refsBody = JSON.stringify({
    taskId: task.id,
    returnTransferId: inbound.handoff?.transferId,
    nonce: "holder-return-refs-probe",
  });
  let refsStatus = 0;
  let refsCount = 0;
  try {
    process.env.ASH_DB = join(root, "b.db");
    resetIdentityCache();
    const refsProbe = await fetch(`${machineA}/api/handoff/return/ping`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...peerRequestHeaders(`${machineA}/api/handoff/return/ping`, "POST", refsBody),
      },
      body: refsBody,
    });
    refsStatus = refsProbe.status;
    const refsPayload = (await refsProbe.json()) as { returnRefs?: { name: string; commit: string }[] };
    refsCount = refsPayload.returnRefs?.length ?? 0;
  } finally {
    process.env.ASH_DB = attackerDb;
    resetIdentityCache();
  }
  assert.equal(refsStatus, 200);
  assert.ok(refsCount > 0, "任务级移回探测应只返回原项目 refs 供增量 bundle 协商");

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
  assert.equal(firstProbe.taskScopedReturn, true, "存档存在时应明确标记为任务级免审批移回");
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

  const returnResult = await api<{ notes: string[] }>(machineB, `/tasks/${task.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: target.url, targetProjectId: projectA.id, targetName: "A", autoResume: false }),
  });
  assert.ok(returnResult.notes.some((note) => /git 数据无需传输/.test(note)), "免审批移回应使用原项目 refs 协商空 bundle");
  assert.ok(!returnResult.notes.some((note) => /整条历史|全量历史/.test(note)), "免审批移回不应误报为全量 git 历史");
  const returned = await api<Task>(machineA, `/tasks/${task.id}`);
  assert.equal(returned.handoff?.direction, "returned");

  const peersOnA = await api<{ peers: { fingerprint: string }[] }>(machineA, "/handoff/peers");
  assert.ok(!peersOnA.peers.some((peer) => peer.fingerprint === identityB.fingerprint), "免审批移回不应暗中建立整机级批准记录");

  // 原机存档被删后，任务级免审批凭据不再成立；允许退回普通接力，但必须恢复整机审批。
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
  const pendingFallback = await api<HandoffPreflightResult>(machineB, `/tasks/${missingArchiveTask.id}/handoff/preflight`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: machineA }),
  });
  assert.equal(pendingFallback.taskScopedReturn, false, "存档缺失后预检必须结构化标明已降级为普通接力");
  assert.equal(pendingFallback.peer?.peerStatus, "pending", "存档缺失后应降级为需要整机审批的普通接力");
  assert.deepEqual(pendingFallback.projects, [], "未批准前普通接力不能读取原机项目清单");
  assert.ok(pendingFallback.local.notes.some((note) => /普通接力/.test(note)), "预检应解释为何重新需要审批");

  await api(machineA, `/handoff/peers/${identityB.fingerprint}/approve`, { method: "POST" });
  const approvedFallback = await api<HandoffPreflightResult>(machineB, `/tasks/${missingArchiveTask.id}/handoff/preflight`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: machineA }),
  });
  assert.equal(approvedFallback.taskScopedReturn, false);
  assert.equal(approvedFallback.peer?.peerStatus, "approved");
  assert.ok(approvedFallback.projects.some((project) => project.id === projectA.id));

  await api(machineB, `/tasks/${missingArchiveTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineA, targetProjectId: projectA.id, targetName: "A", autoResume: false }),
  });
  const restoredWithoutArchive = await api<Task>(machineA, `/tasks/${missingArchiveTask.id}`);
  assert.equal(restoredWithoutArchive.projectId, projectA.id);
  assert.equal(restoredWithoutArchive.handoff?.direction, "in", "本机没有历史存档时不能只凭来源机自报就标成 returned");
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
