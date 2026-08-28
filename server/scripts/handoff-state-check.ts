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
  // 出站状态这一圈按调用者的可见性收窄(见 handoff-remote.ts outboundByPeer)。这份检查
  // 跑在自用模式的源机进程里,身份就是本机 —— 自用模式下可见性本来就是整条穿透。
  const { SINGLE_ACTOR } = await import("../src/auth/context.js");
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

  const live = await outboundRemoteStates(SINGLE_ACTOR);
  assert.deepEqual(live.offline, [], "对端活着的时候不该有 offline");
  const liveRow = live.rows.find((row) => row.taskId === taskId);
  assert.ok(liveRow, `出站行应问回实时状态,实得 ${JSON.stringify(live.rows)}`);
  assert.equal(liveRow.status, "paused", "状态要以持有机为准");
  assert.equal(liveRow.title, renamed, "标题也一起接回来");

  // pending(送达未知)的不问:那种任务源机还硬拦着不让跑,状态归源机自己说。
  await setMarker({ peerUrl, pending: true });
  assert.deepEqual(await outboundRemoteStates(SINGLE_ACTOR), { rows: [], offline: [] }, "pending 的出站行不该去问对端");
  await setMarker({ peerUrl });

  // 持有机联系不上:整轮不抛错,那台机器进 offline,侧栏据此说明「这几行是旧状态」。
  const deadUrl = "http://127.0.0.1:1";
  await patchAppSettings({ handoffTargets: [{ name: "关着的机器", url: deadUrl, peerFp: peerFingerprint }] });
  await setMarker({ peerUrl: deadUrl });
  const dead = await outboundRemoteStates(SINGLE_ACTOR);
  assert.deepEqual(dead.rows, [], "联系不上就没有实时状态可报");
  assert.equal(dead.offline.length, 1);
  assert.equal(dead.offline[0].name, "关着的机器", "offline 要报出用户认得的机器名");

  // 机器换了地址:用户去接力设置里把 url 改对了,可历史出站行的 marker 还冻着接力那一刻
  // 的旧地址。这时必须按**名字**认回同一台 —— 不认的话按 url 找不到 target,整台机器被
  // 轮询静默跳过:既没有实时状态,也不再说「联系不上」,屏幕上剩一份冻住的旧状态冒充实时,
  // 比直说「联系不上」更糟。判据在 shared 的 outboundHolder。
  await patchAppSettings({ handoffTargets: [{ name: "搬过家的机器", url: peerUrl, peerFp: peerFingerprint }] });
  await setMarker({ peerUrl: deadUrl, peerName: "搬过家的机器" });
  const moved = await outboundRemoteStates(SINGLE_ACTOR);
  assert.deepEqual(moved.offline, [], "地址在设置里已经改对了,不该再报离线");
  assert.ok(
    moved.rows.some((row) => row.taskId === taskId),
    `换过地址的持有机要按名字认回,实得 ${JSON.stringify(moved)}`,
  );

  // 真实的改地址路径还带一件事:设置页改 url 时会把记住的 peerFp **一并清掉**(那串指纹
  // 是对上一个地址背后那台机器的承诺)。于是这台机器只能靠名字认回来 —— 而名字认回来的
  // 地址完全可能是填错的。所以问状态之前先 ping 一次验明正身。
  //
  // 指纹对得上:照常问。
  await patchAppSettings({ handoffTargets: [{ name: "刚改过地址的机器", url: peerUrl }] });
  await setMarker({ peerUrl: deadUrl, peerName: "刚改过地址的机器", peerFp: peerFingerprint });
  const verified = await outboundRemoteStates(SINGLE_ACTOR);
  assert.deepEqual(verified.offline, [], "指纹核对得上就该照常问到状态");
  assert.ok(
    verified.rows.some((row) => row.taskId === taskId),
    `验明正身之后要问得到实时状态,实得 ${JSON.stringify(verified)}`,
  );

  // 指纹对不上(地址填错了、或这个地址后面已经换了别的机器):**任务 id 一个都不发出去**,
  // 如实进 offline。不验的话,一台恰好也批准过本机的 ash 会回 200 + 空 rows —— 侧栏既
  // 没有实时状态、也不说「联系不上」,正是这次要修的那种「不是实时却没有提示」。
  await setMarker({ peerUrl: deadUrl, peerName: "刚改过地址的机器", peerFp: "0".repeat(64) });
  const impostor = await outboundRemoteStates(SINGLE_ACTOR);
  assert.deepEqual(impostor.rows, [], "身份验不过就不该有实时状态");
  assert.equal(impostor.offline.length, 1, "验不过的机器要如实进 offline");
  assert.match(
    impostor.offline[0]!.reason,
    /身份和上次不一样/,
    `offline 的理由要说清是身份对不上,实得 ${impostor.offline[0]?.reason}`,
  );

  // 已经从接力设置里删掉的机器:连签名都发不出去,当它不存在(既不问也不报 offline)。
  // 跟上面那条是两件事 —— 删除是用户自己按的,换地址不是。
  await patchAppSettings({ handoffTargets: [] });
  assert.deepEqual(await outboundRemoteStates(SINGLE_ACTOR), { rows: [], offline: [] }, "设置里没有的机器不该报成离线");
  await patchAppSettings({ handoffTargets: beforeTargets });
  await setMarker({});
}
