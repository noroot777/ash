// 能力握手的**端到端**回归:真起一台对端 ash,走真 HTTP。
//
// 判定逻辑本身在 test-handoff-capability.ts 里已经钉死了,这里专管**接线** —— 那部分
// 纯函数测试一个都抓不到,而它恰恰是最容易错的:
//   · 对端得真的把 capabilities 放进 ping 应答(且是在「已批准」这一档才报);
//   · 源机得真的把它读出来并放进 preflight 结果;
//   · 闸得真的在 exportHandoff 里拦住,而不是只在界面上画个红字;
//   · 勾了「仍然接力」得真的过得去 —— 一道推不开的闸等于把功能做成了死路。
//
// 缺哪个 CLI 不写死:测试机装了什么不归这个测试管。从对端自己报的清单里挑一个它
// available=false 的类型来当「缺失」样本,挑不出来就跳过那几节(如实说明),绝不为了
// 让断言好写去假设某台机器上没装某个 CLI。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { api, makeRepo, pairWithPeer, startPeer } from "./handoff-test-utils.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-handoff-cap-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ASH_DB = join(root, "source.db");
process.env.ASH_RUNS_DIR = join(root, "runs-src");
process.env.ASH_UPLOADS_DIR = join(root, "uploads-src");
assert.ok(
  process.env.ASH_ALLOW_REAL_AGENT !== "1",
  "本测试靠 guardAgentSpawn 兜底拦真 CLI;拦截器一失效就会烧用户的真额度",
);

let peer: ChildProcess | null = null;
process.on("exit", () => {
  try { peer?.kill("SIGKILL"); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { exportHandoff, preflightHandoff } = await import("../src/handoff.js");
  const { HandoffError } = await import("../src/handoff-types.js");
  const { createTasks } = await import("../src/task-store.js");
  const { now } = await import("../src/util.js");
  await ensureSchema();

  const srcRepo = makeRepo(join(root, "repo-src"));
  const dstRepo = makeRepo(join(root, "repo-dst"));
  const projectId = "cap-proj";
  await db.insert(projects).values({
    id: projectId, name: "acme", repoPath: srcRepo, createdAt: now(),
  });
  const taskId = "cap-task-0001";
  await createTasks([{
    id: taskId, projectId, title: "握手用例", body: "正文",
    mode: "single", status: "paused", agentType: "claude",
    useWorktree: false, workflowMode: "free",
    createdAt: "2026-09-02T08:00:00.000Z", updatedAt: "2026-09-02T08:00:00.000Z",
  }]);

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
  await pairWithPeer(peerUrl);

  // ── 1. 对端未获批准时不报能力 ──────────────────────────────────────────
  // 装了哪些 CLI 也是本机布局的一部分,与项目清单同档。不带签名的裸 ping 拿不到批准,
  // 所以这一发应当**没有** capabilities 字段。
  const anonymous = await fetch(`${peerUrl}/api/handoff/ping?nonce=probe-anon`)
    .then((res) => res.json()) as { capabilities?: unknown; projects: unknown[] };
  assert.equal(anonymous.capabilities, undefined, "未获批准的来路不该拿到对端的能力清单");

  // ── 2. 已批准:preflight 真的读到了对端能力 ────────────────────────────
  const probe = await preflightHandoff(taskId, peerUrl);
  assert.notEqual(
    probe.capability.status, "unknown",
    "对端是同版本 ash,应当报得出能力 —— 这里是 unknown 说明 ping 那一环没接上",
  );
  assert.equal(probe.capability.blocking, false, "任务用的是默认 claude,本机跑得起来对端就该跑得起来");

  // 从对端自报的清单里挑一个它没装的 CLI(见文件头:不写死)。
  const ping = await import("../src/handoff-peer-client.js")
    .then((m) => m.pingPeer(peerUrl, null, undefined, {}));
  const caps = ping.ping.capabilities;
  assert.ok(caps, "已批准的 ping 必须带 capabilities");
  const missing = caps.agents.find((agent) => !agent.available);

  if (!missing) {
    console.log("handoff capability e2e: 对端把所有 CLI 都装齐了,跳过「缺智能体」几节(未写死机型)");
  } else {
    // ── 3. 缺智能体:导出被拦在打包之前 ──────────────────────────────────
    await db.update(tasks).set({ agentType: missing.type }).where(eq(tasks.id, taskId));
      const blocked = await preflightHandoff(taskId, peerUrl);
    assert.equal(blocked.capability.status, "gaps");
    assert.equal(blocked.capability.blocking, true, `对端没装 ${missing.type},预检就该报拦`);
    assert.ok(
      blocked.capability.gaps.some((gap) => gap.kind === "agent-missing" && gap.agentType === missing.type),
      "落差里要指名道姓说清缺的是哪个",
    );

      const refused = await exportHandoff(taskId, {
      targetUrl: peerUrl, targetProjectId: peerProject.id, autoResume: false,
    }).then(() => null, (error: unknown) => error);
    assert.ok(refused instanceof HandoffError, "缺智能体时导出必须抛 HandoffError");
    assert.equal(refused.status, 409);
    assert.match(refused.message, /ENOENT/, "拒绝理由要说到后果,不能只报一个类型名");
    // 拦下来的必须是**真的没搬**:任务还在本机、没落接力标记。
    const after = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    assert.equal(after?.handoff ?? null, null, "被闸拦下的任务不该留下任何接力标记");

    // ── 4. 勾了「仍然接力」就真的过得去 ─────────────────────────────────
    // 这一节和第 3 节同等重要:推不开的闸不是闸,是死路。
      const forced = await exportHandoff(taskId, {
      targetUrl: peerUrl, targetProjectId: peerProject.id, autoResume: false,
      ignoreCapabilityGaps: true,
    });
    assert.equal(forced.ok, true, "明确放行后应当照常接力");
    assert.equal(forced.remoteTaskId, taskId);
  }

  console.log("handoff capability e2e: ok");
} finally {
  // 断言跑完不等于进程能退出:对端子进程和本机 DB 句柄都还挂在 event loop 上,
  // 不显式收掉的话 `npm run test:handoff` 那条 && 链会停在这里一直等 —— 表现成
  // 「测试卡死」,而其实每一条断言都已经过了(本用例第一版就是这么挂住的)。
  if (peer) {
    peer.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { peer?.kill("SIGKILL"); resolve(); }, 5_000);
      peer!.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
