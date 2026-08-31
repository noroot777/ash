// 接力鉴权回归的后两节:**载荷**这一面(线上传的是不是密文、超大 body 会不会把内存吃光)。
// 从 test-handoff-auth.ts 拆出来只为守住 700 行上限,顺序和编号仍接着那边:
//  12. 传输加密:架一个中间人抄下线上字节,断言密文里读不到任务正文;关掉开关就是明文
//  13. body 上限:验签只能排在读完之后,所以这道闸必须自己站在最前面且是流式的
//
// 所有依赖都从调用方传进来 —— 那边把对端 server、临时库和签名工具都架好了,这里再架
// 一套等于跑两遍环境。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { api } from "./handoff-test-utils.js";

export interface PayloadCheckContext {
  peerUrl: string;
  peerProjectId: string;
  /** 打对端 /api 的原始 fetch(默认不签名)。 */
  raw: (path: string, init: RequestInit & { sign?: false }) => Promise<Response>;
  /** 造一条本地任务,返回它的 id。 */
  mkTask: (id: string) => Promise<string>;
  /** 改本机接力设置(目标机清单、加密开关)。 */
  patchAppSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  preflightHandoff: (taskId: string, url: string) => Promise<{
    peer?: { encrypted?: boolean; canEncrypt?: boolean } | null;
    local: { notes: string[] };
  }>;
  exportHandoff: (taskId: string, opts: {
    targetUrl: string; targetProjectId: string; autoResume: boolean;
  }) => Promise<{ ok: boolean }>;
  /** 造一份指向对端的 manifest JSON。 */
  manifest: (taskId: string) => string;
  /** 带 git 段的 /handoff/import(第 11 节建的,这里只借来验上限不误伤)。 */
  postGit: (taskId: string, branch: string, head: string) => Promise<Response>;
  /** 直接改任务正文(验密文里读不到它)。 */
  setTaskBody: (taskId: string, body: string) => Promise<void>;
}

export async function checkPayloadGuards(ctx: PayloadCheckContext): Promise<void> {
  const {
    peerUrl, peerProjectId, raw, mkTask, patchAppSettings,
    preflightHandoff, exportHandoff, manifest, postGit, setTaskBody,
  } = ctx;
  // ── 12. 传输加密:线上到底传的是不是密文 ──────────────────────────────────
  // 签名管冒充和篡改,加密管的是**窃听** —— 载荷是整个 git bundle 加完整会话历史,同网段
  // 抓一次包就全拿走。所以这里不验「代码调了加密函数」,而是真架一个中间人把线上那串
  // 字节抄下来,断言它不含明文。
  // 抄下来的必须按**字节**留着:信封是二进制帧,转成 utf8 会把不可解码的字节替换掉,
  // 那样「密文里读不到明文」就变成了一个被编码顺手弄出来的假阳性。
  const sniffed: Buffer[] = [];
  const sniffer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.url?.includes("/handoff/import")) sniffed.push(raw);
      const forwarded: Record<string, string> = { "content-type": "application/json" };
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.startsWith("x-ash-peer-") && typeof v === "string") forwarded[k] = v;
      }
      void fetch(`${peerUrl}${req.url}`, {
        method: req.method ?? "GET",
        headers: forwarded,
        ...(raw.length ? { body: raw } : {}),
      }).then(async (upstream) => {
        res.statusCode = upstream.status;
        res.setHeader("content-type", "application/json");
        res.end(Buffer.from(await upstream.arrayBuffer()));
      }).catch(() => req.socket.destroy());
    });
  });
  await new Promise<void>((r) => sniffer.listen(0, "127.0.0.1", r));
  const snifferUrl = `http://127.0.0.1:${(sniffer.address() as { port: number }).port}`;
  try {
    // 中间人转发不影响身份核对:签名和 ping 挑战认的都是密钥,不是地址。
    await patchAppSettings({ handoffTargets: [{ name: "嗅探", url: snifferUrl }], handoffEncrypt: true });
    const secret = "SECRET-PAYLOAD-不该出现在线上";
    const encTask = await mkTask("handoff-auth-enc");
    await setTaskBody(encTask, secret);
    const encProbe = await preflightHandoff(encTask, snifferUrl);
    assert.equal(encProbe.peer?.encrypted, true, "对端支持且开关开着时,预检就该告诉用户这次会加密");
    assert.equal(encProbe.peer?.canEncrypt, true);
    assert.equal(
      (await exportHandoff(encTask, { targetUrl: snifferUrl, targetProjectId: peerProjectId, autoResume: false })).ok,
      true,
      "加密之后照样要能被对端解开并导入 —— 不然就是把功能换成了故障",
    );
    const encBody = sniffed.at(-1) ?? Buffer.alloc(0);
    assert.ok(encBody.subarray(0, 8).equals(Buffer.from("ash-enc1")), "线上传的应该是加密信封");
    assert.ok(!encBody.includes(Buffer.from(secret)), "任务正文绝不能明文出现在线上");
    assert.ok(!encBody.includes(Buffer.from(encTask)), "连任务 id 都不该露");

    // 关掉开关 = 调试模式:明文上路,功能不变。
    await patchAppSettings({ handoffEncrypt: false });
    const plainTask = await mkTask("handoff-auth-plain");
    await setTaskBody(plainTask, secret);
    const plainProbe = await preflightHandoff(plainTask, snifferUrl);
    assert.equal(plainProbe.peer?.encrypted, false, "关掉之后预检要如实说这次是明文");
    assert.equal(plainProbe.peer?.canEncrypt, true, "对端仍然有能力收加密载荷,原因是本机关了");
    assert.ok(
      plainProbe.local.notes.some((n) => n.includes("明文传输")),
      "明文这件事必须写进预检结果,不能只在设置页里静悄悄生效",
    );
    assert.equal(
      (await exportHandoff(plainTask, { targetUrl: snifferUrl, targetProjectId: peerProjectId, autoResume: false })).ok,
      true,
    );
    const plainBody = sniffed.at(-1) ?? Buffer.alloc(0);
    assert.ok(plainBody.includes(Buffer.from(secret)), "关掉加密就该是明文——调试时看得见才是这个开关的全部意义");

    // **加密不该让能搬的东西变小**。信封曾经是 JSON+base64,密文再套一层 base64,
    // 明文 400 MiB 的 manifest 会膨胀成 533 MiB 顶穿 Node 的字符串上限,等于把
    // 「几百 MB 的大任务能接力」这个既有能力弄没了。二进制帧之后只多几十字节帧头。
    const overhead = encBody.length - plainBody.length;
    assert.ok(
      overhead >= 0 && overhead < 512,
      `加密信封相对明文只该多一个小帧头,实测多了 ${overhead} 字节——又套上 base64 了`,
    );

    // 封给别的机器的信封,本机解不开。密钥派生绑死了收件人指纹,所以换台机器必然失败。
    const { sealForPeer } = await import("../src/handoff-crypto.js");
    const strangerKx = generateKeyPairSync("x25519").publicKey
      .export({ type: "spki", format: "der" }).toString("base64");
    const sealedToStranger = sealForPeer(strangerKx, "f".repeat(64), manifest("auth-enc-wrong"));
    const wrongRes = await raw("/handoff/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sealedToStranger,
    });
    assert.equal(wrongRes.status, 400, "封给别的机器的信封必须解不开,而不是退回「当明文试试」");
  } finally {
    sniffer.closeAllConnections();
    await new Promise<void>((r) => sniffer.close(() => r()));
    await patchAppSettings({ handoffEncrypt: true });
  }

  // ── 13. body 上限:鉴权排在缓冲之后,所以这道闸必须自己站在最前面 ──────────
  // 验签要覆盖 body 哈希,只能等读完才验 —— 没有上限的话,一个不带任何签名的巨大请求
  // 就能把内存吃光。所以验的是「有没有在读的过程中掐断」,不是「读完之后拒不拒」。
  const setLimit = (mb: number) => api(peerUrl, "/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handoffMaxBodyMb: mb }),
  });
  await setLimit(1);
  try {
    // 带 content-length 的快路径:自报就超了,一个字节都不该收。
    const declared = await raw("/handoff/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(declared.status, 413, "content-length 自报超限就该当场拒,不用把它收完");

    // chunked(不带 content-length)的真闸:必须靠流式计数,否则快路径一绕就形同虚设。
    let pushed = 0;
    const streamed = await raw("/handoff/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          // 上限 1 MB,这里最多推 8 MB:服务端及时掐断的话,推不到一半就该被 cancel。
          if (pushed >= 8 * 1024 * 1024) { controller.close(); return; }
          pushed += 64 * 1024;
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x78));
        },
      }),
      // undici 要求带流的请求显式声明半双工
      duplex: "half",
    } as RequestInit & { duplex: string });
    assert.equal(streamed.status, 413, "不带 content-length 的流式请求同样要被上限拦住");
    assert.ok(
      pushed < 8 * 1024 * 1024,
      `超限后必须掐断连接,而不是收完再拒(实际推了 ${pushed} 字节,说明服务端一直在收)`,
    );

    // 上限之内的照常往下走(会栽在别的校验上,但不该是 413)。
    const small = await postGit("auth-limit-ok", "main", "a".repeat(40));
    assert.notEqual(small.status, 413, "上限之内的请求不该被这道闸误伤");
  } finally {
    await setLimit(512);
  }
  // 上限之内的真接力(几十 MB 的 bundle)照常能跑通 —— 上面第 12 节已经整轮验过。
}
