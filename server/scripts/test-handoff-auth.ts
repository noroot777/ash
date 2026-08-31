// 接力鉴权回归:**身份**而不是口令。分两个方向验,它们防的不是同一件事。
//
//  入站(谁能把任务推进本机)——真起一台对端 server,用原始 HTTP 打它的机器对机器端点:
//   1. 陌生机器:ping 能敲门(那是配对请求本身)但拿不到项目清单,/refs 与 /import 401,
//      且应答带 ash 标记(源机据此回滚,不会留下「送达未知」的 pending)
//   2. 批准后放行;拉黑后 403
//   3. 没带签名头(旧版源机)→ 401
//   4. body 被改过 → 401(签名覆盖 body 哈希,不然中间人留着签名头换 manifest 照样过)
//   5. 原样重放 → 401(nonce 用过)
//   6. 时间戳超窗 → 401
//   7. 关掉审批开关 → 退回旧行为,陌生机器也能进(升级期的兼容闸)
//
//  出站(我要发的这台还不是原来那台)——这半边才是接力最该防的,因为推出去的是整个
//  仓库和完整会话历史:
//   8. 显式申请会送达待审批列表并记住对端指纹；首次接力成功同样会记住
//   9. 指纹对不上:预检和导出都在**打包之前**硬拒绝,且零副作用(任务没被停、没落标记)
//  10. 对端突然不报身份(降级/冒充):本机记过指纹就一律拒绝
//  11. manifest 里进 git argv 的分支名/提交号(参数注入面,和文件落盘的路径穿越并列)
//  12. 传输加密:架一个中间人抄下线上字节,断言密文里读不到任务正文;关掉开关就是明文
//  13. body 上限:验签只能排在读完之后,所以这道闸必须自己站在最前面且是流式的
//
// 12/13 这两节住在 test-handoff-payload.ts(700 行上限),环境仍由这边搭好传过去。
//
// ASH_RUNS_DIR 指到临时目录顺带打开 guardAgentSpawn:即使哪里失手触发续跑也不会真
// 拉起 CLI 烧额度;接力本身一律 autoResume:false。
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createHash, randomBytes, sign as edSign } from "node:crypto";
import { api, makeRepo, pairWithPeer, startPeer } from "./handoff-test-utils.js";
import { checkPayloadGuards } from "./test-handoff-payload.js";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-handoff-auth-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ASH_DB = join(root, "source.db");
process.env.ASH_RUNS_DIR = join(root, "runs-src");
process.env.ASH_UPLOADS_DIR = join(root, "uploads-src");
requireTmpDb("ash-handoff-auth");

let peer: ChildProcess | undefined;

async function main(): Promise<void> {
  // 环境变量设好之后再加载 src:paths.ts 在模块求值那一刻就把目录定死了。
  const { db } = await import("../src/db/index.js");
  const { ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { exportHandoff, preflightHandoff } = await import("../src/handoff.js");
  const {
    peerRequestHeaders, pingPeer, probePeerIdentity, requestHandoffApproval,
  } = await import("../src/handoff-peer-client.js");
  const { localIdentity, shortFingerprint } = await import("../src/handoff-identity.js");
  const { getAppSettings, patchAppSettings } = await import("../src/app-settings.js");
  const { HandoffError } = await import("../src/handoff-types.js");
  await ensureSchema();

  const srcRepo = makeRepo(join(root, "src-repo"));
  const dstRepo = makeRepo(join(root, "dst-repo"));
  const projectId = "handoff-auth-project";
  await db.insert(projects).values([{
    id: projectId, name: "acme", repoPath: srcRepo, createdAt: "2026-08-22T09:00:00.000Z",
  }]);
  const mkTask = async (id: string) => {
    await db.insert(tasks).values([{
      id, projectId, title: `鉴权用例 ${id}`, body: "probe",
      mode: "single", status: "paused", agentType: "claude",
      useWorktree: false, workflowMode: "free",
      createdAt: "2026-08-22T09:00:00.000Z", updatedAt: "2026-08-22T09:00:00.000Z",
    }]);
    return id;
  };

  const peerUrl = await startPeer({
    ASH_DB: join(root, "target.db"),
    ASH_RUNS_DIR: join(root, "runs-dst"),
    ASH_UPLOADS_DIR: join(root, "uploads-dst"),
  }, (proc) => { peer = proc; });
  const peerProject = await api<{ id: string }>(peerUrl, "/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "acme", repoPath: dstRepo }),
  });
  const peerIdentity = await api<{ fingerprint: string; short: string }>(peerUrl, "/handoff/identity");
  assert.match(peerIdentity.fingerprint, /^[0-9a-f]{64}$/, "对端身份指纹应是 64 位小写 hex");
  assert.equal(peerIdentity.short, shortFingerprint(peerIdentity.fingerprint));
  assert.notEqual(
    peerIdentity.fingerprint, localIdentity().fingerprint,
    "源机与对端各有一份身份:同一台电脑上跑两个实例也不能共用(密钥挂 ASH_DB 而不是 DATA_DIR)",
  );
  const peersBeforeIdentityProbe = await api<{ peers: unknown[] }>(peerUrl, "/handoff/peers");
  assert.equal((await probePeerIdentity(peerUrl)).fingerprint, peerIdentity.fingerprint);
  assert.deepEqual(
    await api<{ peers: unknown[] }>(peerUrl, "/handoff/peers"),
    peersBeforeIdentityProbe,
    "公开身份探测不能携带本机签名或让目标机新增待审批来源",
  );
  await assert.rejects(
    pingPeer(
      peerUrl,
      peerIdentity.fingerprint,
      { taskId: "missing-return-archive", returnTransferId: null },
      { allowReturnFallback: false },
    ),
    (error: unknown) => error instanceof HandoffError && error.remoteStatus === 404,
  );
  assert.deepEqual(
    await api<{ peers: unknown[] }>(peerUrl, "/handoff/peers"),
    peersBeforeIdentityProbe,
    "移回预检缺少任务存档时不能降级成会落待审批记录的普通 ping",
  );

  const raw = (path: string, init: RequestInit & { sign?: false }) =>
    fetch(`${peerUrl}/api${path}`, init);
  const signedInit = (path: string, method: string, body: string) => ({
    method,
    headers: {
      "content-type": "application/json",
      ...peerRequestHeaders(`${peerUrl}/api${path}`, method, body),
    },
    ...(method === "GET" ? {} : { body }),
  });
  const manifest = (taskId: string) => JSON.stringify({
    version: 1, sourceHost: "auth-test", sourceFingerprint: localIdentity().fingerprint, sourceWorkspace: null,
    targetProjectId: peerProject.id, autoResume: false, git: null, files: [],
    transferId: `transfer-${taskId}`,
    task: {
      id: taskId, title: "鉴权用例", body: "probe",
      status: "paused", question: "远程执行器在问：选哪条路？", questionOptions: ["方案甲", "方案乙"],
      createdAt: "2026-08-22T09:00:00.000Z",
    },
    sessions: [],
  });

  // ── 1. 陌生机器:能敲门,进不来 ───────────────────────────────────────────
  await patchAppSettings({ handoffTargets: [{ name: "待申请对端", url: peerUrl }] });
  const requested = await requestHandoffApproval(peerUrl);
  assert.equal(requested.peer?.peerStatus, "pending", "显式申请应把本机送进对端待审批列表");
  assert.equal(requested.projects.length, 0, "申请未获接受前不能借申请端点读到项目清单");
  assert.equal(
    (await getAppSettings()).handoffTargets[0]?.peerFp,
    peerIdentity.fingerprint,
    "用户明确申请后应记住目标机身份，地址背后换机器时再次申请就能拦住",
  );
  const ping1 = await (await raw("/handoff/ping?nonce=n1", signedInit("/handoff/ping?nonce=n1", "GET", ""))).json() as {
    peerStatus: string; projects: unknown[]; identity?: { publicKey: string };
  };
  assert.equal(ping1.peerStatus, "pending", "没批准过的机器,对端应如实回报「待批准」");
  assert.equal(ping1.projects.length, 0, "没批准就不该报出项目清单——那是本机的仓库布局");
  assert.ok(ping1.identity?.publicKey, "ping 必须带身份,否则源机无从核对对面是不是原来那台");

  const peers1 = (await api<{ peers: { fingerprint: string; status: string }[] }>(peerUrl, "/handoff/peers")).peers;
  assert.equal(
    peers1.find((p) => p.fingerprint === localIdentity().fingerprint)?.status, "pending",
    "签名 ping 应把来访机器落进待批准列表——配对请求就是这么送达的,不用手工搬密钥",
  );

  const refs401 = await raw(
    `/handoff/projects/${peerProject.id}/refs`,
    signedInit(`/handoff/projects/${peerProject.id}/refs`, "GET", ""),
  );
  assert.equal(refs401.status, 401, "未批准的机器不该读到对端的分支与提交");
  const import401 = await raw("/handoff/import", signedInit("/handoff/import", "POST", manifest("auth-unapproved")));
  assert.equal(import401.status, 401);
  const body401 = await import401.json() as { error: string; ash?: boolean };
  assert.equal(body401.ash, true, "鉴权拒绝确实什么都没导入,必须带 ash 标记让源机回滚而不是留 pending");
  assert.match(body401.error, /还没批准/);
  assert.equal(
    (await fetch(`${peerUrl}/api/tasks/auth-unapproved`)).status, 404,
    "被拒的导入不该在对端留下任何任务行",
  );

  // ── 2. 批准后放行 ────────────────────────────────────────────────────────
  await pairWithPeer(peerUrl);
  assert.equal(
    (await raw(`/handoff/projects/${peerProject.id}/refs`,
      signedInit(`/handoff/projects/${peerProject.id}/refs`, "GET", ""))).status,
    200, "批准之后同一台机器就该畅通",
  );
  const pingApproved = await (await raw("/handoff/ping?nonce=n2", signedInit("/handoff/ping?nonce=n2", "GET", ""))).json() as {
    peerStatus: string; projects: unknown[];
  };
  assert.equal(pingApproved.peerStatus, "approved");
  assert.equal(pingApproved.projects.length, 1, "批准之后才报项目清单");

  // ── 3. 没带签名头(旧版源机)────────────────────────────────────────────
  const unsigned = await raw("/handoff/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: manifest("auth-unsigned"),
  });
  assert.equal(unsigned.status, 401, "开着审批时,不带身份签名的请求一律拒绝");
  assert.match((await unsigned.json() as { error: string }).error, /没带身份签名/);

  // ── 4. body 被改过 ───────────────────────────────────────────────────────
  // 签名头合法、但配的是另一份 body:签名覆盖 body 哈希,所以这必须失败。
  // 不覆盖 body 的话,中间人可以留着签名头把 manifest 换成任意内容——而接力的 body
  // 就是整个仓库和会话历史。
  const good = manifest("auth-tamper-a");
  const init4 = signedInit("/handoff/import", "POST", good);
  const tampered = await raw("/handoff/import", { ...init4, body: manifest("auth-tamper-b") });
  assert.equal(tampered.status, 401);
  assert.match((await tampered.json() as { error: string }).error, /签名验不过/);

  // ── 5. 原样重放 ──────────────────────────────────────────────────────────
  const replayBody = manifest("auth-replay");
  const init5 = signedInit("/handoff/import", "POST", replayBody);
  assert.equal((await raw("/handoff/import", init5)).status, 200, "前提:第一次是正常导入");
  const snapshotBody = JSON.stringify({ taskId: "auth-replay" });
  const snapshot = await raw(
    "/handoff/proxy/task/snapshot",
    signedInit("/handoff/proxy/task/snapshot", "POST", snapshotBody),
  );
  const snapshotText = await snapshot.text();
  assert.equal(snapshot.status, 200, `来源机应能通过签名代理读取自己交来的远端任务:${snapshotText}`);
  const snapshotJson = JSON.parse(snapshotText) as { task: { id: string; question: string | null }; sessions: unknown[]; persisted: unknown[] };
  assert.equal(snapshotJson.task.id, "auth-replay");
  assert.equal(snapshotJson.task.question, "远程执行器在问：选哪条路？");
  assert.deepEqual(snapshotJson.sessions, []);
  assert.deepEqual(snapshotJson.persisted, []);
  const answerBody = JSON.stringify({ taskId: "auth-replay", answer: "方案甲" });
  const answered = await raw(
    "/handoff/proxy/task/answer",
    signedInit("/handoff/proxy/task/answer", "POST", answerBody),
  );
  assert.equal(answered.status, 200, "远程提问必须走 answer 语义而不是普通 reply");
  assert.equal((await answered.json() as { answered?: boolean }).answered, true);
  const afterAnswerBody = JSON.stringify({ taskId: "auth-replay" });
  const afterAnswer = await raw(
    "/handoff/proxy/task/snapshot",
    signedInit("/handoff/proxy/task/snapshot", "POST", afterAnswerBody),
  );
  assert.equal((await afterAnswer.json() as { task: { question: string | null } }).task.question, null, "答复后必须 CAS 清掉远端 question");
  const replayed = await raw("/handoff/import", init5);
  assert.equal(replayed.status, 401, "同一份签名重发必须被 nonce 挡住");
  assert.match((await replayed.json() as { error: string }).error, /重放/);

  // 身份字段上线前已经导入的任务没有 peerFp。源机仍持有同一次接力的 transferId，
  // 所以可以在获批并验签之后用它一次性补绑；光有 taskId 或猜错 transferId 都不行。
  const legacyTaskId = "auth-legacy-owner";
  const legacyManifest = JSON.parse(manifest(legacyTaskId)) as Record<string, unknown>;
  delete legacyManifest.sourceFingerprint;
  delete legacyManifest.originFingerprint;
  const legacyImportBody = JSON.stringify(legacyManifest);
  assert.equal(
    (await raw("/handoff/import", signedInit("/handoff/import", "POST", legacyImportBody))).status,
    200,
    "旧版 manifest 应照常导入，留下待安全补绑的入站任务",
  );
  const legacyWithoutId = JSON.stringify({ taskId: legacyTaskId });
  assert.equal(
    (await raw("/handoff/proxy/task/snapshot",
      signedInit("/handoff/proxy/task/snapshot", "POST", legacyWithoutId))).status,
    403,
    "缺少 transferId 时不能把旧任务认领给当前机器",
  );
  const legacyWrongId = JSON.stringify({ taskId: legacyTaskId, transferId: "transfer-wrong" });
  assert.equal(
    (await raw("/handoff/proxy/task/snapshot",
      signedInit("/handoff/proxy/task/snapshot", "POST", legacyWrongId))).status,
    403,
    "transferId 对不上时不能把旧任务认领给当前机器",
  );
  const legacyTransferId = `transfer-${legacyTaskId}`;
  const legacyClaim = JSON.stringify({ taskId: legacyTaskId, transferId: legacyTransferId });
  assert.equal(
    (await raw("/handoff/proxy/task/snapshot",
      signedInit("/handoff/proxy/task/snapshot", "POST", legacyClaim))).status,
    200,
    "获批来源机应能用原接力 transferId 给旧任务安全补绑",
  );
  const legacyTask = await api<{ handoff: { peerFp?: string; originFp?: string } }>(peerUrl, `/tasks/${legacyTaskId}`);
  assert.equal(legacyTask.handoff.peerFp, localIdentity().fingerprint, "补绑后应记住来源机指纹");
  assert.equal(legacyTask.handoff.originFp, localIdentity().fingerprint, "直达旧任务的原机也应补成来源机");

  // ── 6. 时间戳超窗 ────────────────────────────────────────────────────────
  // 手工造一个 10 分钟前的签名(私钥是本机的,所以签名本身合法),只有时间不对。
  const staleBody = manifest("auth-stale");
  const staleTs = String(Date.now() - 10 * 60_000);
  const staleNonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(staleBody, "utf8").digest("hex");
  const canonical = ["ash-handoff-v1", "POST", "/api/handoff/import", staleTs, staleNonce, bodyHash].join("\n");
  const { publicKey: srcPub } = { publicKey: localIdentity().publicKey };
  const stale = await raw("/handoff/import", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ash-peer-key": srcPub,
      "x-ash-peer-sig": (await import("../src/handoff-identity.js")).signWithLocalKey(canonical),
      "x-ash-peer-ts": staleTs,
      "x-ash-peer-nonce": staleNonce,
    },
    body: staleBody,
  });
  assert.equal(stale.status, 401);
  assert.match((await stale.json() as { error: string }).error, /时间戳超出/);

  // 冒充:另一对现造的密钥(合法签名、陌生指纹)→ 待批准,进不来。
  const stranger = generateKeyPairSync("ed25519");
  const strangerPub = stranger.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const strangerSigned = (path: string, body: string) => {
    const ts = String(Date.now());
    const nonce = randomBytes(16).toString("hex");
    const canonical = [
      "ash-handoff-v1", "POST", `/api${path}`, ts, nonce,
      createHash("sha256").update(body, "utf8").digest("hex"),
    ].join("\n");
    return raw(path, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-ash-peer-key": strangerPub,
        "x-ash-peer-sig": edSign(null, Buffer.from(canonical, "utf8"), stranger.privateKey).toString("base64"),
        "x-ash-peer-ts": ts, "x-ash-peer-nonce": nonce,
      },
      body,
    });
  };
  const strangerBody = manifest("auth-stranger");
  const sTs = String(Date.now());
  const sNonce = randomBytes(16).toString("hex");
  const sCanonical = [
    "ash-handoff-v1", "POST", "/api/handoff/import", sTs, sNonce,
    createHash("sha256").update(strangerBody, "utf8").digest("hex"),
  ].join("\n");
  const strangerRes = await raw("/handoff/import", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ash-peer-key": strangerPub,
      "x-ash-peer-sig": edSign(null, Buffer.from(sCanonical, "utf8"), stranger.privateKey).toString("base64"),
      "x-ash-peer-ts": sTs,
      "x-ash-peer-nonce": sNonce,
      "x-ash-peer-host": encodeURIComponent("陌生机器·stranger"),
    },
    body: strangerBody,
  });
  assert.equal(strangerRes.status, 401, "签名合法但指纹陌生:身份对了不等于获授权");
  const strangerFp = createHash("sha256").update(Buffer.from(strangerPub, "base64")).digest("hex");
  const peerList = async () =>
    (await api<{ peers: { fingerprint: string; status: string; name: string }[] }>(peerUrl, "/handoff/peers")).peers;
  // **/import 不建待批准记录**。2026-08-31 之前它建,于是源机的自动状态轮询
  // (/proxy/tasks/state,同一道 requireApprovedPeer)每 20 秒就在对端刷出一条
  // 「收到接力申请」——用户压根没申请过。配对只认配对入口,见下面那段。
  assert.equal(
    (await peerList()).find((p) => p.fingerprint === strangerFp), undefined,
    "已建立关系的通道(import/refs/proxy)遇到陌生指纹只该 401,不该把它落成一条待批准申请",
  );

  // 配对入口:带申请意图的签名 ping 才建记录。顺带验主机名的非 ASCII 还原。
  const pTs = String(Date.now());
  const pNonce = randomBytes(16).toString("hex");
  const pingPath = "/api/handoff/ping";
  const pCanonical = [
    "ash-handoff-v1", "GET", pingPath, pTs, pNonce,
    createHash("sha256").update("", "utf8").digest("hex"),
  ].join("\n");
  const pingRes = await raw("/handoff/ping?nonce=pair-probe", {
    headers: {
      "x-ash-peer-key": strangerPub,
      "x-ash-peer-sig": edSign(null, Buffer.from(pCanonical, "utf8"), stranger.privateKey).toString("base64"),
      "x-ash-peer-ts": pTs,
      "x-ash-peer-nonce": pNonce,
      "x-ash-peer-host": encodeURIComponent("陌生机器·stranger"),
    },
  });
  assert.equal(pingRes.status, 200, "配对入口对谁都开着(项目清单为空而已)");
  const strangerRow = (await peerList()).find((p) => p.fingerprint === strangerFp);
  assert.equal(strangerRow?.status, "pending", "带申请意图的签名 ping 才是配对请求本身");
  assert.equal(
    strangerRow?.name, "陌生机器·stranger",
    "主机名里的非 ASCII 要能原样还原:HTTP 头只装 ByteString,所以出站 percent 编码、入站解回来",
  );

  const tombstoneDir = join(root, "handoff-canceled");
  const tombstones = () => existsSync(tombstoneDir) ? readdirSync(tombstoneDir).length : 0;
  const tombstonesBefore = tombstones();
  const strangerCancel = await strangerSigned("/handoff/proxy/task/cancel-pending", JSON.stringify({
    taskId: "missing-return-task", transferId: "missing-transfer", returnTransferId: "missing-return-transfer",
  }));
  assert.equal(strangerCancel.status, 404, "未获批准机器不能为不存在的移回存档制造 tombstone");
  assert.equal(tombstones(), tombstonesBefore);
  const hugeCancel = await strangerSigned("/handoff/proxy/task/cancel-pending", JSON.stringify({
    taskId: "B".repeat(100_000), transferId: "missing-transfer", returnTransferId: "missing-return-transfer",
  }));
  assert.equal(hugeCancel.status, 400, "超长 taskId 必须在写盘前拒绝");
  const longTransfer = await strangerSigned("/handoff/proxy/task/cancel-pending", JSON.stringify({
    taskId: "missing-return-task", transferId: "T".repeat(65), returnTransferId: "missing-return-transfer",
  }));
  assert.equal(longTransfer.status, 400, "超长 transferId 必须在写盘前拒绝");
  assert.equal(tombstones(), tombstonesBefore);

  await api(peerUrl, `/handoff/peers/${strangerFp}/approve`, { method: "POST" });
  const foreignSnapshotBody = JSON.stringify({ taskId: legacyTaskId, transferId: legacyTransferId });
  const foreignSnapshotTs = String(Date.now());
  const foreignSnapshotNonce = randomBytes(16).toString("hex");
  const foreignSnapshotCanonical = [
    "ash-handoff-v1", "POST", "/api/handoff/proxy/task/snapshot", foreignSnapshotTs, foreignSnapshotNonce,
    createHash("sha256").update(foreignSnapshotBody, "utf8").digest("hex"),
  ].join("\n");
  const foreignSnapshot = await raw("/handoff/proxy/task/snapshot", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ash-peer-key": strangerPub,
      "x-ash-peer-sig": edSign(null, Buffer.from(foreignSnapshotCanonical, "utf8"), stranger.privateKey).toString("base64"),
      "x-ash-peer-ts": foreignSnapshotTs,
      "x-ash-peer-nonce": foreignSnapshotNonce,
    },
    body: foreignSnapshotBody,
  });
  assert.equal(foreignSnapshot.status, 403, "另一台已批准机器即使拿到 transferId 也不能覆盖已补绑的任务归属");
  assert.match((await foreignSnapshot.json() as { error: string }).error, /无权读取或操作/);

  // 拉黑之后是 403(明确拒绝),和「还没看过」区分得开。
  await api(peerUrl, `/handoff/peers/${strangerFp}/block`, { method: "POST" });
  const blocked = await raw("/handoff/import", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ash-peer-key": strangerPub,
      "x-ash-peer-sig": edSign(null, Buffer.from([
        "ash-handoff-v1", "POST", "/api/handoff/import", sTs, `${sNonce}b`,
        createHash("sha256").update(strangerBody, "utf8").digest("hex"),
      ].join("\n"), "utf8"), stranger.privateKey).toString("base64"),
      "x-ash-peer-ts": sTs,
      "x-ash-peer-nonce": `${sNonce}b`,
    },
    body: strangerBody,
  });
  assert.equal(blocked.status, 403, "已拉黑的机器要给出和「待批准」不同的应答");

  // ── 8. 首次配对 TOFU:接力成功后记住对端指纹 ─────────────────────────────
  await patchAppSettings({ handoffTargets: [{ name: "对端", url: peerUrl }] });
  const tofuTask = await mkTask("handoff-auth-tofu");
  const probe = await preflightHandoff(tofuTask, peerUrl);
  assert.equal(probe.peer?.trust, "first-seen", "还没记过指纹时应报「首次」");
  assert.equal(probe.peer?.fingerprint, peerIdentity.fingerprint);
  assert.equal(probe.peer?.peerStatus, "approved");
  assert.ok(
    probe.local.notes.some((n) => n.includes(peerIdentity.short)),
    "首次配对要把指纹摆进预检结果,用户才有得核对",
  );
  const exported = await exportHandoff(tofuTask, {
    targetUrl: peerUrl, targetProjectId: peerProject.id, autoResume: false,
  });
  assert.equal(exported.ok, true);
  const afterTofu = await getAppSettings();
  assert.equal(
    afterTofu.handoffTargets[0].peerFp, peerIdentity.fingerprint,
    "接力成功后必须记住对端指纹,否则下次换了机器没有比对的基准",
  );

  // ── 9. 指纹对不上:打包之前硬拒绝,零副作用 ──────────────────────────────
  const wrongFp = "0".repeat(64);
  await patchAppSettings({ handoffTargets: [{ name: "对端", url: peerUrl, peerFp: wrongFp }] });
  const mismatchTask = await mkTask("handoff-auth-mismatch");
  await assert.rejects(
    preflightHandoff(mismatchTask, peerUrl),
    (e: unknown) => e instanceof HandoffError && /身份和上次不一样/.test(e.message),
    "记住的指纹对不上,预检就该拦住:接力推的是整个仓库和会话历史,发错机器无法挽回",
  );
  await assert.rejects(
    exportHandoff(mismatchTask, { targetUrl: peerUrl, targetProjectId: peerProject.id, autoResume: false }),
    (e: unknown) => e instanceof HandoffError && /身份和上次不一样/.test(e.message),
  );
  await assert.rejects(
    pingPeer(peerUrl, wrongFp, { taskId: "missing-return-archive", returnTransferId: null }),
    (e: unknown) => e instanceof HandoffError
      && /接力记录里/.test(e.message)
      && /设置页没有可清除项/.test(e.message)
      && !/清掉记住的指纹/.test(e.message),
    "任务 marker 提供的指纹不能误导用户去设置页清理不存在的整机指纹",
  );
  const untouched = (await db.select().from(tasks).where(eq(tasks.id, mismatchTask))).at(0)!;
  assert.equal(untouched.status, "paused", "被身份核对拦下的导出不该停任务");
  assert.equal(untouched.handoff, null, "更不该留下任何接力标记");
  assert.equal(
    (await fetch(`${peerUrl}/api/tasks/${mismatchTask}`)).status, 404,
    "对端也不该收到任何东西",
  );

  // ── 10. 对端突然不报身份(降级/冒充)────────────────────────────────────
  const { createServer } = await import("node:http");
  const legacy = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true, service: "ash", host: "legacy",
      projects: [{ id: peerProject.id, name: "acme", repoPath: dstRepo, isRepo: true }],
    }));
  });
  await new Promise<void>((r) => legacy.listen(0, "127.0.0.1", r));
  const legacyUrl = `http://127.0.0.1:${(legacy.address() as { port: number }).port}`;
  try {
    // 本机没记过它 → 无从核对,放行(否则升级路径直接断掉)。
    await patchAppSettings({ handoffTargets: [{ name: "旧版", url: legacyUrl }] });
    const legacyTask = await mkTask("handoff-auth-legacy");
    const legacyProbe = await preflightHandoff(legacyTask, legacyUrl);
    assert.equal(legacyProbe.peer, null, "对端没报身份时如实报 null,不假装核对过");
    assert.ok(
      legacyProbe.local.notes.some((n) => n.includes("没有报出身份")),
      "无法核对这件事必须写进预检结果,不能悄悄放过",
    );
    // 记过指纹的机器突然不报身份 → 一律拒绝(防降级)。
    await patchAppSettings({ handoffTargets: [{ name: "旧版", url: legacyUrl, peerFp: peerIdentity.fingerprint }] });
    await assert.rejects(
      preflightHandoff(legacyTask, legacyUrl),
      (e: unknown) => e instanceof HandoffError && /没有报出身份/.test(e.message),
      "报过身份的机器突然不报了,不是降级就是冒充,不能按「旧版」放过",
    );
  } finally {
    await new Promise<void>((r) => legacy.close(() => r()));
  }

  // ── 7. 关掉审批开关:退回旧行为 ──────────────────────────────────────────
  // 升级期的兼容闸:两台机器版本不一致、老源机没法签名时才用,所以要验它真的放行。
  await api(peerUrl, "/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handoffRequireApproval: false }),
  });
  const openRes = await raw("/handoff/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: manifest("auth-open-gate"),
  });
  assert.equal(openRes.status, 200, "关掉审批后,未签名的旧版源机也该能推进来");
  const openPing = await (await raw("/handoff/ping", { method: "GET" })).json() as { peerStatus: string; projects: unknown[] };
  assert.equal(openPing.peerStatus, "open");
  assert.equal(openPing.projects.length, 1, "审批关掉时项目清单照报,否则旧版源机匹配不到项目");

  // ── 11. manifest 里的分支名/提交号会直接进 git 的 argv ─────────────────────
  // 挡的是「进 argv 的字符串」这一面:`-` 开头会被 git 当成选项,`..`/`:`/换行能把
  // refspec 拆坏或指到仓库目录之外。文件落盘方向的路径穿越由 safeRel / SAFE_NAME 另挡。
  const withGit = (taskId: string, branch: string, head: string) => {
    const m = JSON.parse(manifest(taskId)) as Record<string, unknown>;
    m.git = { branch, head, full: false, prereqs: [], bundleBase64: "" };
    return JSON.stringify(m);
  };
  const postGit = (taskId: string, branch: string, head: string) => raw("/handoff/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: withGit(taskId, branch, head),
  });
  const evilBranches = [
    ["--upload-pack=touch /tmp/ash-pwned", "`-` 开头会被 git 当成选项"],
    ["../../../../etc/evil", "`..` 能把 ref 指到 .git 之外"],
    ["main\nrefs/heads/x", "换行能把 refspec 拆成两条"],
    ["main:refs/heads/x", "`:` 是 refspec 的分隔符"],
  ] as const;
  for (const [i, [branch, why]] of evilBranches.entries()) {
    const res = await postGit(`auth-branch-${i}`, branch, "a".repeat(40));
    assert.equal(res.status, 400, `分支名 ${JSON.stringify(branch)} 必须在落库前被拒:${why}`);
  }
  const badHead = await postGit("auth-head-bad", "main", "$(touch /tmp/ash-pwned)");
  assert.equal(badHead.status, 400, "head 只收 40/64 位 hex 提交号,别的一律不进 git 命令");
  const cnBranch = await postGit("auth-branch-cn", "功能/中文分支", "a".repeat(40));
  assert.notEqual(cnBranch.status, 400, "中文分支名在 git 里合法,校验不能把它一起误伤");

  // ── 12/13. 载荷面(传输加密、body 上限)──────────────────────────────────
  // 拆在 test-handoff-payload.ts:两节加起来 140 行,留在这儿会顶穿 700 行上限。
  // 对端 server、临时库和签名工具都在这边架好了,所以那边只收依赖不自己搭环境。
  await checkPayloadGuards({
    peerUrl,
    peerProjectId: peerProject.id,
    raw,
    mkTask,
    patchAppSettings,
    preflightHandoff,
    exportHandoff,
    manifest,
    postGit,
    setTaskBody: async (taskId, body) => {
      await db.update(tasks).set({ body }).where(eq(tasks.id, taskId));
    },
  });


  console.log("test-handoff-auth ok");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (peer) {
      peer.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { peer?.kill("SIGKILL"); resolve(); }, 5_000);
        peer!.on("exit", () => { clearTimeout(t); resolve(); });
      });
    }
    await releaseTmpDb();
    // Windows 上句柄释放有滞后(对端进程刚被杀),EBUSY 时重试而不是把真实测试结果盖掉。
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
