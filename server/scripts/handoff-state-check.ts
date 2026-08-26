// test-handoff 第 13 节:出站存档的实时状态。从主文件拆出来只为压体积(根 AGENTS.md 的
// 700 行硬线),断言编排原样搬过来,跟 handoff-test-utils.ts 拆出去的动机一样。
//
// 验的是侧栏那一圈:签名代理批量问持有机、逐个任务鉴权、pending 不问、联系不上如实进
// offline、设置里删掉的机器当不存在。跑在**源机进程内**(测试进程自己就是源机),
// 所以按调用时机动态 import 那些吃 ASH_DB 的模块 —— 主文件早就把环境变量设好了。
import assert from "node:assert/strict";
import { api } from "./handoff-test-utils.js";

export async function checkOutboundStates(opts: {
  /** 真对端的 baseUrl。 */
  peerUrl: string;
  /** 已经确认接力出去的那个任务 id(源机与对端同 id)。 */
  taskId: string;
  /** 该任务当前的 out 标记,验完原样写回去。 */
  marker: Record<string, unknown>;
}): Promise<void> {
  const { peerUrl, taskId, marker } = opts;
  const { db } = await import("../src/db/index.js");
  const { tasks } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { getAppSettings, patchAppSettings } = await import("../src/app-settings.js");
  const { outboundRemoteStates } = await import("../src/handoff-remote.js");
  const setMarker = (patch: Record<string, unknown>) => db.update(tasks)
    .set({ handoff: JSON.stringify({ ...marker, ...patch }) })
    .where(eq(tasks.id, taskId));

  const peerFingerprint = (await api<{ fingerprint: string }>(peerUrl, "/handoff/identity")).fingerprint;
  const beforeTargets = (await getAppSettings()).handoffTargets;
  await patchAppSettings({ handoffTargets: [{ name: "测试机", url: peerUrl, peerFp: peerFingerprint }] });
  // 把 out 标记指回真对端(第 3 节走的是假对端那个地址,同一台机器换个门牌)。
  await setMarker({ peerUrl });
  // 对端把这份任务改个名:标题也要跟着状态一起接回来,否则源机列表里挂的是老名字。
  const renamed = "接力过来的任务(对端改名)";
  const renameRes = await fetch(`${peerUrl}/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: renamed }),
  });
  assert.equal(renameRes.status, 200, `对端改标题应成功:${await renameRes.text()}`);

  const live = await outboundRemoteStates();
  assert.deepEqual(live.offline, [], "对端活着的时候不该有 offline");
  const liveRow = live.rows.find((row) => row.taskId === taskId);
  assert.ok(liveRow, `出站行应问回实时状态,实得 ${JSON.stringify(live.rows)}`);
  assert.equal(liveRow.status, "paused", "状态要以持有机为准");
  assert.equal(liveRow.title, renamed, "标题也一起接回来");

  // pending(送达未知)的不问:那种任务源机还硬拦着不让跑,状态归源机自己说。
  await setMarker({ peerUrl, pending: true });
  assert.deepEqual(await outboundRemoteStates(), { rows: [], offline: [] }, "pending 的出站行不该去问对端");
  await setMarker({ peerUrl });

  // 持有机联系不上:整轮不抛错,那台机器进 offline,侧栏据此说明「这几行是旧状态」。
  const deadUrl = "http://127.0.0.1:1";
  await patchAppSettings({ handoffTargets: [{ name: "关着的机器", url: deadUrl, peerFp: peerFingerprint }] });
  await setMarker({ peerUrl: deadUrl });
  const dead = await outboundRemoteStates();
  assert.deepEqual(dead.rows, [], "联系不上就没有实时状态可报");
  assert.equal(dead.offline.length, 1);
  assert.equal(dead.offline[0].name, "关着的机器", "offline 要报出用户认得的机器名");

  // 已经从接力设置里删掉的机器:连签名都发不出去,当它不存在(既不问也不报 offline)。
  await patchAppSettings({ handoffTargets: [] });
  assert.deepEqual(await outboundRemoteStates(), { rows: [], offline: [] }, "设置里没有的机器不该报成离线");
  await patchAppSettings({ handoffTargets: beforeTargets });
  await setMarker({});
}
