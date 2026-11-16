import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

// 对端 ash 刚重启时，本机连接池里还留着通往旧进程的长连接：第一次探测写进一条对面已经关掉的
// 连接，拿到「other side closed」而不是应答，界面上就报「无法核对目标机的签名身份」，再点一次
// 才好。两个只读探测遇到这类连接层错误要换条新连接再试一次；验签不过、连接层错误一直不消，
// 都不能因为重试被放过去。
//
// 假对端用裸 TCP 写：它把每条连接上的第二个请求当场掐断（不回一个字节），跟「连接池里那条
// 连接其实早断了」在客户端看来是同一件事，而且每次都撞得上，不赌时序。
const stage = mkdtempSync(join(tmpdir(), "ash-probe-retry-"));
process.env.ASH_DB = join(stage, "local.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
requireTmpDb("ash-probe-retry");

const machine = generateKeyPairSync("ed25519");
const publicKey = machine.publicKey.export({ type: "spki", format: "der" }).toString("base64");
let server: Server | undefined;
const sockets = new Set<Socket>();

try {
  const { canonicalPingChallenge, fingerprintOf } = await import("../src/handoff-identity.js");
  const { probePeerIdentity, probeSignedPeerFingerprint } = await import("../src/handoff-peer-client.js");
  const fingerprint = fingerprintOf(publicKey);

  // dropReused：同一条连接上第二个请求起一律掐断；dropAll：所有请求都掐断；wrongSignature：照常应答，但签错 nonce。
  const mode = { dropReused: false, dropAll: false, wrongSignature: false };
  let requests = 0;
  let dropped = 0;
  const respond = (socket: Socket, path: string) => {
    const url = new URL(path, "http://peer");
    const nonce = url.searchParams.get("nonce") ?? "";
    const body = url.pathname.endsWith("/identity")
      ? JSON.stringify({ fingerprint, host: "fixture" })
      : JSON.stringify({
          ok: true, service: "ash", host: "fixture", projects: [], peerStatus: "approved",
          identity: {
            publicKey,
            sig: sign(null, Buffer.from(canonicalPingChallenge(mode.wrongSignature ? "wrong-nonce" : nonce)), machine.privateKey).toString("base64"),
          },
        });
    socket.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n`
      + `connection: keep-alive\r\n\r\n${body}`);
  };
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let served = 0;
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("latin1");
      for (let end = pending.indexOf("\r\n\r\n"); end >= 0; end = pending.indexOf("\r\n\r\n")) {
        const head = pending.slice(0, end);
        pending = pending.slice(end + 4);
        requests += 1;
        if (mode.dropAll || (mode.dropReused && served > 0)) {
          dropped += 1;
          socket.destroy();
          return;
        }
        served += 1;
        respond(socket, head.split(" ")[1]);
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // 上一个应答读完之后，连接要过一拍才回到连接池；紧接着发的下一个请求会另开一条，那就撞不上
  // 「复用一条已断的连接」了。真实场景里两次探测隔着用户的一次点击，这里让出 50ms。
  const idle = () => new Promise((resolve) => setTimeout(resolve, 50));
  // 换档前把上一档留下的连接都掐掉，并等客户端看见：不然这一档的第一个请求就会先撞上它们。
  const reset = async (next: Partial<typeof mode>) => {
    for (const socket of sockets) socket.destroy();
    await idle();
    Object.assign(mode, { dropReused: false, dropAll: false, wrongSignature: false }, next);
    requests = 0;
    dropped = 0;
  };

  // ① 签名探测撞上已断的长连接：换条新连接再问一次，拿到对端的签名身份。
  await reset({ dropReused: true });
  assert.equal(await probeSignedPeerFingerprint(base), fingerprint, "第一次探测本来就该通");
  await idle();
  assert.equal(await probeSignedPeerFingerprint(base), fingerprint, "撞上已断的长连接后应换条新连接重试，而不是报核对不过");
  assert.equal(dropped, 1, "那条已断的长连接确实被撞上了一次（不然这一档什么都没测到）");
  assert.equal(requests, 3, "只重试一次");

  // ② 公开身份探测同样只读，同样重试。
  await reset({ dropReused: true });
  assert.equal((await probePeerIdentity(base)).fingerprint, fingerprint);
  await idle();
  assert.equal((await probePeerIdentity(base)).fingerprint, fingerprint, "公开身份探测撞上已断的长连接也应重试");
  assert.equal(dropped, 1);

  // ③ 验签不过是对端真的答了：照旧报核对不过，不重试。
  await reset({ wrongSignature: true });
  assert.equal(await probeSignedPeerFingerprint(base), null, "签名对不上不能因为重试被放过去");
  assert.equal(requests, 1, "拿到了应答就不重试");

  // ④ 连接层错误一直不消（对端每个请求都掐）：试两次就停，照旧报核对不过 / 连不上。
  await reset({ dropAll: true });
  assert.equal(await probeSignedPeerFingerprint(base), null);
  assert.equal(requests, 2, "签名探测最多试两次");
  await reset({ dropAll: true });
  await assert.rejects(probePeerIdentity(base), /连不上对端 ash/);
  assert.equal(requests, 2, "公开身份探测最多试两次");

  // ⑤ 根本连不上（端口没人听）不是「旧连接已断」：不重试，照旧报。
  const closedPort = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
  assert.equal(await probeSignedPeerFingerprint(`http://127.0.0.1:${closedPort}`), null);
  await assert.rejects(probePeerIdentity(`http://127.0.0.1:${closedPort}`), /连不上对端 ash/);

  console.log("handoff probe retry: 撞上已断的长连接重试一次、验签不过与一直断开照旧报错 —— 全部通过");
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
