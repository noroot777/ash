// 「我在对端的账号 key」的回归:**它是接力的第二把钥匙,而且两种实例模式都要有地方填**。
//
// 起因(用户 2026-08-29):自用实例往多人实例接力,预检如实报了「对端不认识你,去补
// key」,可自用模式的设置页里根本没有那个输入框 —— 提示指着一个不存在的地方,用户原话
// 是「这也没有能补的地方啊」。根因是 key 只存在多人模式的 `user_handoff_targets` 上,
// 而**要不要 key 由对端的模式决定,跟本机是不是多人无关**。
//
// 这份测试钉住修法的四块:
//   1. 自用模式的 key 存得下、读得出(`handoff_local_peer_keys`),清单读侧只报 hasKey
//      —— 凭证不进 `app_settings`(`GET /settings` 会把那份整份吐回前端)
//   2. 目标机从设置里删掉时,它那把 key 跟着走(不然删掉再加回同一个地址会诈尸);但
//      只收走**这次被删的那台**,别的行不碰
//   3. 「缺 key」这件事带**机器可读的原因码**一路传到前端:出站预检自己判定的那次,
//      以及对端 401 应答里带回来的那次(前端据此就地给出输入框,而不是再指一次路)
//   4. 配好的 key 必须真的**随请求发到对端** —— 包括为「已不在清单里但任务还挂着」的
//      地址配的那把(重放收口场景)
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-handoff-peer-key-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ASH_DB = join(root, "local.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
requireTmpDb("ash-handoff-peer-key");

try {
  const { ensureSchema } = await import("../src/db/index.js");
  const { SINGLE_ACTOR } = await import("../src/auth/context.js");
  const scope = await import("../src/auth/handoff-scope.js");
  const { patchSettingsFor } = await import("../src/auth/personal-settings.js");
  const { HANDOFF_PEER_KEY_REQUIRED } = await import("@ash/shared/handoff");
  await ensureSchema();

  const url = "http://127.0.0.1:4319";

  // ── 1. 自用模式:清单在设置里,key 在自己的表里 ────────────────────────────
  await scope.addTarget(SINGLE_ACTOR, { name: "多人那台", url });
  assert.equal(await scope.peerKeyForRequest(null, url), "", "还没配过 key 时读回空串");
  assert.equal((await scope.listTargets(SINGLE_ACTOR))[0].hasKey, false);

  await scope.setPeerKey(SINGLE_ACTOR, url, "ash_single_mode_key");
  assert.equal(
    await scope.peerKeyForRequest(null, url), "ash_single_mode_key",
    "自用模式也要能存下「我在对端的账号 key」——要不要它由对端的模式决定",
  );
  // 尾斜杠、大小写都不该影响命中:出站那一侧的 url 来自用户输入和 marker,形态不统一。
  assert.equal(await scope.peerKeyForRequest(null, `${url}/`), "ash_single_mode_key");
  assert.equal(await scope.peerKeyForRequest(null, url.toUpperCase().replace("HTTP", "http")), "ash_single_mode_key");

  const listed = await scope.listTargets(SINGLE_ACTOR);
  assert.equal(listed[0].hasKey, true, "读侧只报 hasKey");
  assert.equal((listed[0] as { peerKey?: string }).peerKey, undefined, "key 绝不回显");
  // 凭证不能混进那份会被 `GET /settings` 整份吐回前端的设置。
  const { getAppSettings } = await import("../src/app-settings.js");
  assert.equal(
    JSON.stringify(await getAppSettings()).includes("ash_single_mode_key"), false,
    "key 不许出现在 app_settings 里",
  );

  // 空串 = 明确清空(对端转回单人实例了)。
  await scope.setPeerKey(SINGLE_ACTOR, url, "");
  assert.equal(await scope.peerKeyForRequest(null, url), "");
  assert.equal((await scope.listTargets(SINGLE_ACTOR))[0].hasKey, false);

  // ── 2. 删掉目标机,key 跟着走 ──────────────────────────────────────────────
  await scope.setPeerKey(SINGLE_ACTOR, url, "ash_second_key");
  await patchSettingsFor(SINGLE_ACTOR, { handoffTargets: [] });
  await scope.addTarget(SINGLE_ACTOR, { name: "同一个地址又加回来", url });
  assert.equal(
    await scope.peerKeyForRequest(null, url), "",
    "删掉目标机时它那把 key 也该没了,不然同一个地址加回来会诈尸",
  );

  // ── 3. 缺 key 的原因码一路传到前端 ────────────────────────────────────────
  const { pingPeer, fetchPeer } = await import("../src/handoff-peer-client.js");
  const { HandoffError } = await import("../src/handoff-types.js");
  const { PEER_USER_KEY_HEADER } = await import("../src/auth/handoff-peer-user.js");

  // 3a. 对端自报多人、又没认出我是谁:出站侧自己判定,不必等对端拒绝。
  const seenKeys: (string | undefined)[] = [];
  const multiPeer = createServer((req, res) => {
    seenKeys.push(req.headers[PEER_USER_KEY_HEADER] as string | undefined);
    if (req.url?.startsWith("/api/handoff/ping")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true, service: "ash", host: "peer", instanceMode: "multi", userCount: 2,
        peerUser: null, projects: [],
      }));
      return;
    }
    // 3b. 别的路径一律按「对端明确拒绝」应答,带上它自己的原因码。
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "这把 key 在对端机器上不认", ash: true, code: HANDOFF_PEER_KEY_REQUIRED }));
  });
  await new Promise<void>((done) => multiPeer.listen(0, "127.0.0.1", done));
  const peerPort = (multiPeer.address() as { port: number }).port;
  const peerUrl = `http://127.0.0.1:${peerPort}`;
  try {
    const rejected = await pingPeer(peerUrl, null, undefined, { requirePeerUser: true })
      .then(() => null, (error: unknown) => error);
    assert.ok(rejected instanceof HandoffError, "对端是多人实例又不认识我,预检必须当场拒绝");
    assert.equal(rejected.status, 401);
    assert.equal(
      rejected.code, HANDOFF_PEER_KEY_REQUIRED,
      "带原因码前端才能就地给出输入框,而不是再指一次路",
    );
    assert.ok(
      rejected.message.includes("直接填"),
      "文案要先说「这儿就能填」——只把人支去设置页的老写法正是本任务的起因",
    );

    // 3b. 对端 401 的原因码要**穿透这一跳**:补 key 的地方在本机,可这件事只有对端知道。
    const relayed = await fetchPeer(`${peerUrl}/api/handoff/projects/x/refs`)
      .then(() => null, (error: unknown) => error);
    assert.ok(relayed instanceof HandoffError);
    assert.equal(relayed.remoteStatus, 401);
    assert.equal(relayed.code, HANDOFF_PEER_KEY_REQUIRED, "对端的原因码应原样挂回本机错误上");

    // ── 4. 配好的 key 必须真的**出门** ─────────────────────────────────────
    // 2026-08-29 之前这一段是断的:出站头按「这条请求的完整 URL」去清单里精确匹配
    // 根地址,永远匹配不上,于是每个请求都不带 key 出门 —— 用户配了 key,对端照样回
    // 「我不认识你」,而提示还在教他去配那把已经配好的 key。断言看的是**对端收到了
    // 什么**,不是本机以为自己发了什么。
    assert.deepEqual(
      seenKeys.filter(Boolean), [],
      "还没给这个地址配 key 时不该凭空发一个出去",
    );
    await scope.addTarget(SINGLE_ACTOR, { name: "假对端", url: peerUrl });
    await scope.setPeerKey(SINGLE_ACTOR, peerUrl, "ash_outbound_key");
    assert.equal(
      await scope.peerKeyForRequest(null, `${peerUrl}/api/handoff/ping?nonce=abc`),
      "ash_outbound_key",
      "带路径和查询串的请求 URL 也要认得出是哪台目标机",
    );
    seenKeys.length = 0;
    await pingPeer(peerUrl, null, undefined, { requirePeerUser: true }).catch(() => undefined);
    assert.equal(seenKeys[0], "ash_outbound_key", "配好的 key 必须真的随请求发到对端");

    // ── 5. 目标机已从设置里删掉时,那个地址上配的 key 照样要出门 ───────────────
    // pending / 移回重放收口时,弹框会为「已经不在清单里、但任务还挂在它身上」的地址
    // 合成一个可选项,并在那儿给出 key 输入框。第 1 轮审查(P2)复现的是:保存回 200、
    // 下一次预检仍旧 401 —— 因为出站读侧是拿清单去 join key 表的,孤儿行谁也看不见。
    // 现在自用模式直接读那张表本身,清单只是设置页上的书签。
    await patchSettingsFor(SINGLE_ACTOR, { handoffTargets: [] });
    await scope.setPeerKey(SINGLE_ACTOR, peerUrl, "ash_orphan_key");
    assert.deepEqual(await scope.listTargets(SINGLE_ACTOR), [], "它确实已经不在清单里了");
    seenKeys.length = 0;
    await pingPeer(peerUrl, null, undefined, { requirePeerUser: true }).catch(() => undefined);
    assert.equal(
      seenKeys[0], "ash_orphan_key",
      "重放收口用的那个地址上填的 key,保存成功就必须真的能用",
    );

    // 而且不能被「改了别的目标机」顺手清掉 —— 只有**这次被删掉的那台**才收走它的 key。
    await patchSettingsFor(SINGLE_ACTOR, { handoffTargets: [{ name: "另一台", url, peerFp: null }] });
    assert.equal(
      await scope.peerKeyForRequest(null, peerUrl), "ash_orphan_key",
      "动了别的目标机不该顺手清掉这一把",
    );
  } finally {
    await new Promise<void>((done) => multiPeer.close(() => done()));
  }

  console.log("test-handoff-peer-key ok");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
