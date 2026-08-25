import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffPreflightResult, HandoffReturnGrant, HandoffTarget, Task } from "@ash/shared";
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
let returnProxy: { url: string; close(): Promise<void> } | null = null;
const ordinaryProxies: { close(): Promise<void> }[] = [];

async function startReturnProxy(upstream: string): Promise<{ url: string; close(): Promise<void> }> {
  let cutFirstImport = true;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if ((key === "content-type" || key.startsWith("x-ash-peer-")) && typeof value === "string") {
            headers[key] = value;
          }
        }
        const method = req.method ?? "GET";
        const upstreamResponse = await fetch(`${upstream}${req.url}`, {
          method,
          headers,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength) }),
        });
        const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
        if (cutFirstImport && req.url?.startsWith("/api/handoff/return/import")) {
          cutFirstImport = false;
          req.socket.destroy();
          return;
        }
        res.statusCode = upstreamResponse.status;
        res.setHeader("content-type", upstreamResponse.headers.get("content-type") ?? "application/json");
        res.end(responseBody);
      })().catch(() => req.socket.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startOrdinaryImportProxy(
  upstream: string,
  forwardBeforeCut: boolean,
  legacyCancel = false,
  cutPath = "/api/handoff/import",
): Promise<{
  url: string;
  deliverHeld(): Promise<{ status: number; body: { error?: string; ash?: boolean } }>;
  setUpstream(url: string): void;
  close(): Promise<void>;
}> {
  let activeUpstream = upstream;
  let cutFirstImport = true;
  let held: { path: string; method: string; headers: Record<string, string>; body: Buffer } | null = null;
  const forward = async (request: NonNullable<typeof held>) => {
    const response = await fetch(`${activeUpstream}${request.path}`, {
      method: request.method,
      headers: request.headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : {
        body: new Uint8Array(request.body.buffer as ArrayBuffer, request.body.byteOffset, request.body.byteLength),
      }),
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  };
  let closed = false;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      void (async () => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if ((key === "content-type" || key.startsWith("x-ash-peer-")) && typeof value === "string") {
            headers[key] = value;
          }
        }
        const request = {
          path: req.url ?? "/",
          method: req.method ?? "POST",
          headers,
          body: Buffer.concat(chunks),
        };
        if (legacyCancel && request.path.startsWith("/api/handoff/proxy/task/cancel-pending")) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (cutFirstImport && request.path.startsWith(cutPath)) {
          cutFirstImport = false;
          if (forwardBeforeCut) await forward(request);
          else held = request;
          req.socket.destroy();
          return;
        }
        const upstreamResponse = await forward(request);
        res.statusCode = upstreamResponse.status;
        res.setHeader("content-type", upstreamResponse.contentType);
        res.end(upstreamResponse.bytes);
      })().catch(() => req.socket.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    deliverHeld: async () => {
      if (!held) throw new Error("没有待投递的 import 请求");
      const response = await forward(held);
      return { status: response.status, body: JSON.parse(response.bytes.toString("utf8")) as { error?: string; ash?: boolean } };
    },
    setUpstream: (url: string) => { activeUpstream = url; },
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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
  const machineC = await startPeer({
    ASH_DB: join(root, "c.db"),
    ASH_RUNS_DIR: join(root, "runs-c"),
    ASH_UPLOADS_DIR: join(root, "uploads-c"),
  }, remember);
  serverPorts.push(Number(new URL(machineA).port), Number(new URL(machineB).port), Number(new URL(machineC).port));

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
  const { prepareWorktree, worktreePathFor } = await import("../src/git.js");
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

  const createSimpleTask = (title: string) => api<Task>(machineA, "/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: projectA.id, title, body: title, mode: "single", workflowMode: "free", useWorktree: false,
    }),
  });

  // 普通接力已送达但应答丢失：横幅的“在本机继续”必须被对端任务挡住，不能清标记造双跑。
  const receivedTask = await createSimpleTask("对端已收到时禁止恢复本机");
  const receivedProxy = await startOrdinaryImportProxy(machineB, true);
  ordinaryProxies.push(receivedProxy);
  const receivedInterrupted = await fetch(`${machineA}/api/tasks/${receivedTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: receivedProxy.url, targetProjectId: projectB.id, targetName: "B", autoResume: false }),
  });
  assert.equal(receivedInterrupted.status, 502);
  assert.equal((await fetch(`${machineB}/api/tasks/${receivedTask.id}`)).status, 200, "前提：对端实际已经收到任务");
  const blockedClear = await fetch(`${machineA}/api/tasks/${receivedTask.id}/handoff`, { method: "DELETE" });
  assert.equal(blockedClear.status, 409, "对端已有任务时必须阻止恢复本机旧副本");
  assert.match(((await blockedClear.json()) as { error: string }).error, /已经收到|原样重试/);
  const forcedBlockedClear = await fetch(`${machineA}/api/tasks/${receivedTask.id}/handoff`, {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: true, acknowledgeDuplicateRisk: true }),
  });
  assert.equal(forcedBlockedClear.status, 409, "即使直接调用强制端点，对端明确已收到时也不能绕过双任务硬拦截");
  assert.equal((await api<Task>(machineA, `/tasks/${receivedTask.id}`)).handoff?.pending, true, "被阻止后 pending 标记必须保留");
  await api(machineA, `/tasks/${receivedTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: receivedProxy.url, targetProjectId: projectB.id, targetName: "B", autoResume: false }),
  });

  // 请求尚未送达：目标机先登记撤销，源机才清标记；旧 import 即使随后到达也会被 tombstone 拒绝。
  const delayedTask = await createSimpleTask("撤销后旧请求不能晚到");
  const delayedProxy = await startOrdinaryImportProxy(machineB, false);
  ordinaryProxies.push(delayedProxy);
  const delayedInterrupted = await fetch(`${machineA}/api/tasks/${delayedTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: delayedProxy.url, targetProjectId: projectB.id, targetName: "B", autoResume: false }),
  });
  assert.equal(delayedInterrupted.status, 502);
  assert.equal((await fetch(`${machineB}/api/tasks/${delayedTask.id}`)).status, 404, "前提：旧 import 尚未送到目标机");
  const safeClear = await fetch(`${machineA}/api/tasks/${delayedTask.id}/handoff`, { method: "DELETE" });
  assert.equal(safeClear.status, 200, `目标机登记撤销后应允许恢复本机：${await safeClear.text()}`);
  assert.equal((await api<Task>(machineA, `/tasks/${delayedTask.id}`)).handoff, null);
  const lateDelivery = await delayedProxy.deliverHeld();
  assert.equal(lateDelivery.status, 409, "已登记撤销的旧 import 不能在清标记后晚到");
  assert.equal(lateDelivery.body.ash, true);
  assert.match(lateDelivery.body.error ?? "", /安全撤销|不能再导入/);
  assert.equal((await fetch(`${machineB}/api/tasks/${delayedTask.id}`)).status, 404, "旧请求被拒后目标机仍不能出现第二份任务");

  // 旧版目标机没有撤销路由时，默认仍不冒险清标记，但给用户显式承担双任务风险的逃生门。
  const legacyTask = await createSimpleTask("旧版目标机允许显式强制恢复");
  const legacyProxy = await startOrdinaryImportProxy(machineB, false, true);
  ordinaryProxies.push(legacyProxy);
  const legacyInterrupted = await fetch(`${machineA}/api/tasks/${legacyTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: legacyProxy.url, targetProjectId: projectB.id, targetName: "旧版 B", autoResume: false }),
  });
  assert.equal(legacyInterrupted.status, 502);
  const legacySafe = await fetch(`${machineA}/api/tasks/${legacyTask.id}/handoff`, { method: "DELETE" });
  assert.equal(legacySafe.status, 409);
  const legacySafeBody = (await legacySafe.json()) as { error: string; needsForce?: boolean; forceReason?: string };
  assert.equal(legacySafeBody.needsForce, true);
  assert.equal(legacySafeBody.forceReason, "legacy");
  assert.match(legacySafeBody.error, /版本过旧/);
  const legacyForced = await fetch(`${machineA}/api/tasks/${legacyTask.id}/handoff`, {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: true, acknowledgeDuplicateRisk: true }),
  });
  assert.equal(legacyForced.status, 200);
  assert.equal(((await legacyForced.json()) as { forced?: boolean }).forced, true);
  assert.equal((await api<Task>(machineA, `/tasks/${legacyTask.id}`)).handoff, null);

  // 永久离线与“版本过旧”必须给不同原因；仍只在第二次明确确认风险后恢复。
  const offlineTask = await createSimpleTask("离线目标机允许显式强制恢复");
  const offlineProxy = await startOrdinaryImportProxy(machineB, false);
  ordinaryProxies.push(offlineProxy);
  const offlineInterrupted = await fetch(`${machineA}/api/tasks/${offlineTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: offlineProxy.url, targetProjectId: projectB.id, targetName: "离线 B", autoResume: false }),
  });
  assert.equal(offlineInterrupted.status, 502);
  await offlineProxy.close();
  const offlineSafe = await fetch(`${machineA}/api/tasks/${offlineTask.id}/handoff`, { method: "DELETE" });
  assert.equal(offlineSafe.status, 409);
  const offlineSafeBody = (await offlineSafe.json()) as { error: string; needsForce?: boolean; forceReason?: string };
  assert.equal(offlineSafeBody.needsForce, true);
  assert.equal(offlineSafeBody.forceReason, "unreachable");
  assert.match(offlineSafeBody.error, /连不上对端/);
  const offlineForced = await fetch(`${machineA}/api/tasks/${offlineTask.id}/handoff`, {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: true, acknowledgeDuplicateRisk: true }),
  });
  assert.equal(offlineForced.status, 200);
  assert.equal((await api<Task>(machineA, `/tasks/${offlineTask.id}`)).handoff, null);

  // 地址可达但已经换成另一台机器时，不能误报网络离线；强制后无会话任务也必须留下持久风险记录。
  const identityTask = await createSimpleTask("目标地址换机后的强制恢复审计");
  const identityProxy = await startOrdinaryImportProxy(machineB, false);
  ordinaryProxies.push(identityProxy);
  const identityInterrupted = await fetch(`${machineA}/api/tasks/${identityTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: identityProxy.url, targetProjectId: projectB.id, targetName: "原 B", autoResume: false }),
  });
  assert.equal(identityInterrupted.status, 502);
  identityProxy.setUpstream(machineC);
  const identitySafe = await fetch(`${machineA}/api/tasks/${identityTask.id}/handoff`, { method: "DELETE" });
  assert.equal(identitySafe.status, 409);
  const identitySafeBody = (await identitySafe.json()) as { error: string; needsForce?: boolean; forceReason?: string };
  assert.equal(identitySafeBody.forceReason, "identity");
  assert.match(identitySafeBody.error, /无法证明仍是原目标机|身份和上次不一样/);
  assert.doesNotMatch(identitySafeBody.error, /当前连不上对端/);
  const identityForced = await fetch(`${machineA}/api/tasks/${identityTask.id}/handoff`, {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: true, acknowledgeDuplicateRisk: true }),
  });
  assert.equal(identityForced.status, 200);
  const identityRecovered = await api<Task>(machineA, `/tasks/${identityTask.id}`);
  assert.equal(identityRecovered.handoff, null);
  assert.equal(identityRecovered.handoffAudit?.kind, "forced-recovery");
  assert.equal(identityRecovered.handoffAudit?.forceReason, "identity");
  assert.deepEqual(await api<unknown[]>(machineA, `/tasks/${identityTask.id}/sessions`), [], "没有会话也必须靠任务行保留强制恢复审计");

  await api(machineA, `/tasks/${identityTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineB, targetProjectId: projectB.id, targetName: "B", autoResume: false }),
  });
  await api(machineB, `/tasks/${identityTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineA, targetProjectId: projectA.id, targetName: "A", autoResume: false }),
  });
  const identityReturned = await api<Task>(machineA, `/tasks/${identityTask.id}`);
  assert.equal(identityReturned.handoff?.direction, "returned");
  assert.equal(identityReturned.handoffAudit?.forceReason, "identity", "正常接力往返不能清掉强制恢复风险记录");
  await api(machineA, `/tasks/${identityTask.id}`, { method: "DELETE" });
  await api(machineB, `/tasks/${identityTask.id}`, { method: "DELETE" });

  await api(machineA, `/tasks/${task.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineB, targetProjectId: projectB.id, targetName: "B", autoResume: false }),
  });
  const inbound = await api<Task>(machineB, `/tasks/${task.id}`);
  assert.equal(inbound.handoff?.direction, "in");
  assert.equal(inbound.handoff?.peerUrl, machineA, "接收机应从真实来源地址与源端口恢复回程地址");
  const identityB = await api<{ fingerprint: string }>(machineB, "/handoff/identity");
  const grantsOnA = await api<{ grants: HandoffReturnGrant[] }>(machineA, "/handoff/return-grants");
  const returnGrant = grantsOnA.grants.find((grant) => grant.fingerprint === identityB.fingerprint);
  assert.equal(returnGrant?.taskCount, 2, "历史持有机应以任务级回程权限显式列出并聚合对应任务数");
  assert.equal(returnGrant?.blocked, false);
  const peersBeforeBlock = await api<{ peers: { fingerprint: string }[] }>(machineA, "/handoff/peers");
  assert.ok(!peersBeforeBlock.peers.some((peer) => peer.fingerprint === identityB.fingerprint), "展示任务级回程权限不能暗中建立整机批准");

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

  // 显式拉黑仍然优先；即使它从未申请整机接力，也能从历史回程权限列表直接撤销。
  const returnOnlyBlock = await api<{ status: string; returnOnly: boolean }>(
    machineA, `/handoff/peers/${identityB.fingerprint}/block`, { method: "POST" },
  );
  assert.equal(returnOnlyBlock.status, "blocked");
  assert.equal(returnOnlyBlock.returnOnly, true);
  const hiddenApprove = await fetch(`${machineA}/api/handoff/peers/${identityB.fingerprint}/approve`, { method: "POST" });
  assert.equal(hiddenApprove.status, 409, "纯回程拒绝记录不能被 API 偷偷升级成界面不可见的整机批准");
  const blocked = await fetch(`${machineB}/api/tasks/${task.id}/handoff/preflight`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: target.url }),
  });
  assert.equal(blocked.status, 502);
  assert.match(((await blocked.json()) as { error: string }).error, /明确拒绝|不能自动移回/);

  // 纯回程占位的解除只删拉黑行，不建立整机批准；任务历史里的指纹仍是回程凭据。
  await api(machineA, `/handoff/peers/${identityB.fingerprint}/unblock`, { method: "POST" });
  const grantsAfterUnblock = await api<{ grants: HandoffReturnGrant[] }>(machineA, "/handoff/return-grants");
  assert.equal(grantsAfterUnblock.grants.find((grant) => grant.fingerprint === identityB.fingerprint)?.blocked, false);
  const peersAfterReturnOnlyUnblock = await api<{ peers: { fingerprint: string }[] }>(machineA, "/handoff/peers");
  assert.ok(!peersAfterReturnOnlyUnblock.peers.some((peer) => peer.fingerprint === identityB.fingerprint));
  const probeAfterForget = await api<HandoffPreflightResult>(machineB, `/tasks/${task.id}/handoff/preflight`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: target.url }),
  });
  assert.equal(probeAfterForget.peer?.peerStatus, "approved");

  // 已批准来源被历史回程区拒绝再解除时，必须恢复原批准；pending 来源则不能借此提权。
  await api(machineB, "/handoff/request", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: machineA }),
  });
  await api(machineA, `/handoff/peers/${identityB.fingerprint}/approve`, { method: "POST" });
  await api(machineA, `/handoff/peers/${identityB.fingerprint}/block`, { method: "POST" });
  await api(machineA, `/handoff/peers/${identityB.fingerprint}/unblock`, { method: "POST" });
  const peersAfterApprovedUnblock = await api<{ peers: { fingerprint: string; status: string }[] }>(machineA, "/handoff/peers");
  assert.equal(peersAfterApprovedUnblock.peers.find((peer) => peer.fingerprint === identityB.fingerprint)?.status, "approved");
  await api(machineA, `/handoff/peers/${identityB.fingerprint}`, { method: "DELETE" });
  await api(machineB, "/handoff/request", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: machineA }),
  });
  await api(machineA, `/handoff/peers/${identityB.fingerprint}/block`, { method: "POST" });
  await api(machineA, `/handoff/peers/${identityB.fingerprint}/unblock`, { method: "POST" });
  const peersAfterPendingUnblock = await api<{ peers: { fingerprint: string; status: string }[] }>(machineA, "/handoff/peers");
  assert.equal(peersAfterPendingUnblock.peers.find((peer) => peer.fingerprint === identityB.fingerprint)?.status, "pending");
  await api(machineA, `/handoff/peers/${identityB.fingerprint}`, { method: "DELETE" });

  const holderWorktree = worktreePathFor(repoB, task.id);
  writeFileSync(join(holderWorktree, "remote-change.txt"), "commit created on holder\n");
  execFileSync("git", ["-C", holderWorktree, "add", "remote-change.txt"]);
  execFileSync("git", [
    "-C", holderWorktree,
    "-c", "user.name=Ash Handoff Test", "-c", "user.email=handoff@example.test",
    "commit", "-m", "holder commit",
  ]);
  const holderHead = execFileSync("git", ["-C", holderWorktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const originWorktree = worktreePathFor(repoA, task.id);
  writeFileSync(join(originWorktree, "seed.txt"), "tracked local edit\n");
  writeFileSync(join(originWorktree, "remote-change.txt"), "LOCAL UNTRACKED DRAFT\n");
  const trackedDirtyReturn = await fetch(`${machineB}/api/tasks/${task.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineA, targetProjectId: projectA.id, targetName: "A", autoResume: false }),
  });
  assert.equal(trackedDirtyReturn.status, 502);
  assert.match(((await trackedDirtyReturn.json()) as { error: string }).error, /已跟踪文件的未提交改动/);
  assert.equal((await api<Task>(machineB, `/tasks/${task.id}`)).handoff?.direction, "in", "已跟踪改动挡下移回后持有机仍应可运行");
  writeFileSync(join(originWorktree, "seed.txt"), "seed\n");
  const untrackedConflictReturn = await fetch(`${machineB}/api/tasks/${task.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineA, targetProjectId: projectA.id, targetName: "A", autoResume: false }),
  });
  assert.equal(untrackedConflictReturn.status, 502);
  assert.match(((await untrackedConflictReturn.json()) as { error: string }).error, /未跟踪文件.*remote-change\.txt/);
  assert.equal(readFileSync(join(originWorktree, "remote-change.txt"), "utf8"), "LOCAL UNTRACKED DRAFT\n", "冲突未跟踪文件的唯一内容不能被改写");
  assert.equal((await api<Task>(machineB, `/tasks/${task.id}`)).handoff?.direction, "in");
  rmSync(join(originWorktree, "remote-change.txt"));
  writeFileSync(join(originWorktree, ".DS_Store"), "finder metadata\n");
  returnProxy = await startReturnProxy(machineA);
  const interruptedResponse = await fetch(`${machineB}/api/tasks/${task.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: returnProxy.url, targetProjectId: projectA.id, targetName: "A", autoResume: false }),
  });
  assert.equal(interruptedResponse.status, 502, "移回已落到原机但应答中断时应保留送达未知态");
  assert.match(((await interruptedResponse.json()) as { error: string }).error, /原样重试.*幂等收口/);
  const pendingReturnTask = await api<Task>(machineB, `/tasks/${task.id}`);
  assert.equal(pendingReturnTask.handoff?.direction, "out");
  assert.equal(pendingReturnTask.handoff?.pending, true);
  assert.equal(pendingReturnTask.handoff?.returnTransferId, inbound.handoff?.transferId, "pending 标记必须冻结任务级移回凭据");
  assert.equal(pendingReturnTask.handoff?.peerFp, identityA.fingerprint, "移回重放必须继续钉死原机身份");

  const returnedBeforeRetry = await api<Task>(machineA, `/tasks/${task.id}`);
  assert.equal(returnedBeforeRetry.handoff?.direction, "returned", "代理断响应前原机已完成导入");
  assert.equal(returnedBeforeRetry.handoff?.returnTransferId, inbound.handoff?.transferId, "原机完成态应保留幂等探测凭据");
  const originHeadBeforeRetry = execFileSync("git", ["-C", worktreePathFor(repoA, task.id), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(originHeadBeforeRetry, holderHead, "首次已送达的移回应更新原机 worktree");
  assert.equal(existsSync(join(originWorktree, ".DS_Store")), true, "reset --hard 不应删除或阻止未跟踪的 .DS_Store");
  const blockedReturnClear = await fetch(`${machineB}/api/tasks/${task.id}/handoff`, { method: "DELETE" });
  assert.equal(blockedReturnClear.status, 409, "原机已接回任务时也不能撤销 pending 移回并恢复持有机旧副本");
  assert.equal((await api<Task>(machineB, `/tasks/${task.id}`)).handoff?.pending, true);

  const retryProbe = await api<HandoffPreflightResult>(machineB, `/tasks/${task.id}/handoff/preflight`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: returnProxy.url }),
  });
  assert.equal(retryProbe.taskScopedReturn, true, "移回 pending 重试仍必须走 return/ping");
  assert.equal(retryProbe.peer?.peerStatus, "approved", "移回 pending 重试不能退化成整机审批");

  const returnResult = await api<{ notes: string[] }>(machineB, `/tasks/${task.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: returnProxy.url, targetProjectId: projectA.id, targetName: "A", autoResume: false }),
  });
  assert.ok(returnResult.notes.some((note) => /幂等收口/.test(note)), "应答中断后的原样移回应安全收口而不是重复导入");
  assert.ok(!returnResult.notes.some((note) => /整条历史|全量历史/.test(note)), "免审批移回不应误报为全量 git 历史");
  const returned = await api<Task>(machineA, `/tasks/${task.id}`);
  assert.equal(returned.handoff?.direction, "returned");
  const originHead = execFileSync("git", ["-C", worktreePathFor(repoA, task.id), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(originHead, holderHead, "原机 worktree 应落到持有机返回的新提交");

  const peersOnA = await api<{ peers: { fingerprint: string }[] }>(machineA, "/handoff/peers");
  assert.ok(!peersOnA.peers.some((peer) => peer.fingerprint === identityB.fingerprint), "免审批移回不应暗中建立整机级批准记录");

  // 移回 pending 的地址若切到另一台新版 ash，404 表示存档不匹配，不是目标机版本过旧。
  const changedReturnTask = await createSimpleTask("移回地址换机不能误报旧版");
  await api(machineA, `/tasks/${changedReturnTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: machineB, targetProjectId: projectB.id, targetName: "B", autoResume: false }),
  });
  const changedReturnProxy = await startOrdinaryImportProxy(machineA, false, false, "/api/handoff/return/import");
  ordinaryProxies.push(changedReturnProxy);
  const changedReturnInterrupted = await fetch(`${machineB}/api/tasks/${changedReturnTask.id}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: changedReturnProxy.url, targetProjectId: projectA.id, targetName: "A", autoResume: false }),
  });
  assert.equal(changedReturnInterrupted.status, 502);
  changedReturnProxy.setUpstream(machineC);
  const changedReturnSafe = await fetch(`${machineB}/api/tasks/${changedReturnTask.id}/handoff`, { method: "DELETE" });
  assert.equal(changedReturnSafe.status, 409);
  const changedReturnSafeBody = (await changedReturnSafe.json()) as { error: string; forceReason?: string };
  assert.equal(changedReturnSafeBody.forceReason, "identity");
  assert.match(changedReturnSafeBody.error, /新版 ash.*没有对应的历史存档|地址已经换机|存档已删除/);
  assert.doesNotMatch(changedReturnSafeBody.error, /版本过旧/);
  await api(machineB, `/tasks/${changedReturnTask.id}/handoff`, {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: true, acknowledgeDuplicateRisk: true }),
  });
  await api(machineA, `/tasks/${changedReturnTask.id}`, { method: "DELETE" });
  await api(machineB, `/tasks/${changedReturnTask.id}`, { method: "DELETE" });

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

  const previousPort = process.env.PORT;
  process.env.PORT = "0";
  const { currentListeningPort, recordListeningPort } = await import("../src/listening-port.js");
  recordListeningPort(54_321);
  assert.equal(currentListeningPort(), 54_321);
  assert.equal(process.env.PORT, "0", "记录实际监听端口不能污染终端和 agent 继承的 PORT");
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  console.log("test-handoff-return ok");
} finally {
  await returnProxy?.close().catch(() => {});
  await Promise.all(ordinaryProxies.map((proxy) => proxy.close().catch(() => {})));
  for (const port of serverPorts) {
    for (const pid of listenerPidsSync(port)) killOne(pid, "SIGKILL");
  }
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
