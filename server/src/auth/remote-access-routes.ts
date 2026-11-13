// 自用模式「谁能从别处连进来」的端点。判据在 remote-access.ts,放设备进来的三条路在
// remote-pairing.ts,这里只是把它们接到 HTTP 上。
//
// 两组,闸的位置不同:
//   · `/auth/pair*` —— **设备那一侧**,还没被认成机主的时候打的,所以在免登录名单里
//     (middleware.ts)。它们各自要的凭据在路由里验:申请的 secret、一次性码。
//   · `/remote-access*` —— **机主那一侧**,在闸内。
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { PairClaim, PairCode, PairRequestView, PairTicket, RemoteAccessView, RemoteDeviceView } from "@ash/shared";
import { actorOf } from "./context.js";
import { SESSION_COOKIE } from "./middleware.js";
import { isMultiUser } from "./mode.js";
import {
  connectionOf, deviceByToken, ensureRemoteAccessKey, isLocalDirect, knownHost, listDevices, peerAddress, removeDevice,
  requestOrigin, rotateRemoteAccessKey,
} from "./remote-access.js";
import {
  claimPairRequest, decidePairRequest, deviceName, mintPairCode, openPairRequest, pendingPairRequests, redeemPairCode,
} from "./remote-pairing.js";

const MULTI_REFUSAL = "多人模式下每个人用自己的 key 登录，没有设备配对";

/** 发这次请求的设备(凭 cookie 或 Bearer 进来的那台);本机直连和脚本没有。 */
function currentDevice(c: Context) {
  const bearer = /^Bearer\s+(\S+)$/i.exec((c.req.header("authorization") ?? "").trim())?.[1];
  return deviceByToken(bearer) ?? deviceByToken(getCookie(c, SESSION_COOKIE));
}

function viewFor(c: Context): RemoteAccessView {
  const current = currentDevice(c)?.id ?? null;
  const devices: RemoteDeviceView[] = listDevices().map((d) => ({
    id: d.id, name: d.name, via: d.via, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, address: d.address,
    current: d.id === current,
  }));
  const local = isLocalDirect(c);
  return { local, ...(local ? { key: ensureRemoteAccessKey() } : {}), devices, requests: pendingPairRequests() };
}

/** 已签发的预览凭证是地址里的一串随机数,不认设备:不一起作废,被请出去的那台还能顺着开着的预览页继续用。 */
const revokePreviews = async (): Promise<void> => (await import("../preview-access.js")).revokePreviewGrants();

export function mountRemoteAccessRoutes(api: Hono, issueSessionCookie: (c: Context, token: string) => void): void {
  // ── 设备那一侧 ─────────────────────────────────────────────────────────────
  // 这三条只对「还没进来」的请求有意义。已经进得来的(本机、已配对)来打一律拒:名册里
  // 不该多出一台本来就进得来的设备。
  const outsiderRefusal = async (c: Context): Promise<Response | null> => {
    if (await isMultiUser()) return c.json({ error: MULTI_REFUSAL }, 409);
    if (actorOf(c).kind !== "anonymous") return c.json({ error: "这台设备已经进得来了" }, 409);
    return null;
  };

  api.post("/auth/pair", async (c) => {
    const refused = await outsiderRefusal(c);
    if (refused) return refused;
    // 只收从认得的名字打开的页面递来的申请(缘由见 remote-access.ts `knownHost`)。
    const host = requestOrigin(c).host;
    if (!knownHost(host)) {
      return c.json({
        error: `ash 还不认得「${host ?? ""}」这个地址，从它打开的页面不能直接申请配对。`
          + "改用 IP 地址打开，或者在 ash 那台电脑上「扫码添加」、用访问密钥进来一次 —— 之后这个地址就认得了",
      }, 403);
    }
    const { name } = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
    const ticket: PairTicket | null = openPairRequest({
      name: deviceName(c.req.header("user-agent"), name),
      address: peerAddress(c),
    });
    if (!ticket) return c.json({ error: "等着批准的设备太多了，先在 ash 那台电脑上处理掉几个" }, 429);
    return c.json(ticket);
  });

  api.post("/auth/pair/claim", async (c) => {
    const refused = await outsiderRefusal(c);
    if (refused) return refused;
    const { id, secret } = await c.req.json<{ id?: string; secret?: string }>().catch(() => ({ id: "", secret: "" }));
    const claim: PairClaim = claimPairRequest(String(id ?? ""), String(secret ?? ""), peerAddress(c));
    if (claim.status === "approved") issueSessionCookie(c, claim.token);
    return c.json(claim);
  });

  api.post("/auth/pair/redeem", async (c) => {
    const refused = await outsiderRefusal(c);
    if (refused) return refused;
    const { code, name } = await c.req.json<{ code?: string; name?: unknown }>().catch(() => ({ code: "", name: undefined }));
    const token = redeemPairCode(String(code ?? ""), {
      name: deviceName(c.req.header("user-agent"), name),
      address: peerAddress(c),
    });
    if (!token) return c.json({ error: "这个二维码用过了或者过期了，在 ash 那台电脑上重新出一个" }, 410);
    issueSessionCookie(c, token);
    return c.json({ token });
  });

  // ── 机主那一侧 ─────────────────────────────────────────────────────────────
  // 放设备、请设备出去:任何一处已经进得来的页面都能做(本机,或者一台已配对的设备)——
  // 进得来的设备本来就开得了终端,不让它点「允许」挡不住任何事,只会逼机主为了加一台
  // 平板跑回电脑前。回合凭证(agent)不算:放谁进来得是人点的。
  const ownerRefusal = async (c: Context): Promise<Response | null> => {
    if (await isMultiUser()) return c.json({ error: MULTI_REFUSAL }, 409);
    if (actorOf(c).kind !== "single") return c.json({ error: "放哪台设备进来得由机主本人决定" }, 403);
    return null;
  };

  api.get("/remote-access", async (c) => (await ownerRefusal(c)) ?? c.json(viewFor(c)));

  // 顶条轮询用的轻口:只回等着的申请,不带密钥和名册。
  api.get("/remote-access/requests", async (c) =>
    (await ownerRefusal(c)) ?? c.json({ requests: pendingPairRequests() } satisfies { requests: PairRequestView[] }));

  api.post("/remote-access/requests/:id/:decision{approve|deny}", async (c) => {
    const refused = await ownerRefusal(c);
    if (refused) return refused;
    const decided = decidePairRequest(c.req.param("id"), c.req.param("decision") === "approve");
    if (!decided) return c.json({ error: "这张申请已经过期或处理过了" }, 404);
    return c.json({ ok: true, name: decided.name });
  });

  api.delete("/remote-access/devices/:id", async (c) => {
    const refused = await ownerRefusal(c);
    if (refused) return refused;
    if (!removeDevice(c.req.param("id"), connectionOf(c))) return c.json({ error: "这台设备已经不在了" }, 404);
    await revokePreviews();
    return c.json(viewFor(c));
  });

  api.post("/remote-access/pair-code", async (c) =>
    (await ownerRefusal(c)) ?? c.json(mintPairCode() satisfies PairCode));

  // 访问密钥的查看与更换**只在本机直连时给**:它是给脚本用的长期凭证,连进来的设备不该
  // 能读出来再转交给第三台。没有本机浏览器的机器(无头服务器)在那台机器上
  // `curl http://127.0.0.1:<端口>/api/remote-access` 即可。
  api.post("/remote-access/rotate", async (c) => {
    const refused = await ownerRefusal(c);
    if (refused) return refused;
    if (!isLocalDirect(c)) return c.json({ error: "访问密钥只能在 ash 所在的那台机器上更换" }, 403);
    rotateRemoteAccessKey();
    await revokePreviews();
    return c.json(viewFor(c));
  });
}
