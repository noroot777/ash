// 接力载荷的传输加密。解决的是**窃听**,而不是冒充或篡改 —— 那两样已经由
// handoff-identity.ts 的逐请求签名解决了。剩下的缺口是:同一个局域网里有人抓包,就能把
// 整个 git bundle 和 CLI 会话历史读走(里面可能有 API key、内部代码、客户数据)。
//
// 为什么不上 HTTPS:那要求自签证书 + 两端装信任链,对局域网单人系统是纯负担。而 ash
// 已经有一套**签过名的**机器身份,直接拿它做密钥协商就够了,证书体系那一层是多余的。
//
// 用的是 libsodium `crypto_box_seal` 那个形状(一次性发件人密钥 → 收件人静态公钥):
//   1. 发件方每次现造一对 X25519 临时密钥,和**收件方的静态 X25519 公钥**做 ECDH;
//   2. 共享秘密过 HKDF-SHA256 派生 AES-256-GCM 密钥,信息串里绑死收件人指纹,
//      同一份密文换台机器解不开;
//   3. 临时公钥明文放进信封,收件方用自己的静态私钥算出同一个共享秘密。
//
// 收件方的静态公钥是从 /handoff/ping 拿的,而 **ping 的身份签名覆盖了它**
// (canonicalPingChallenge),所以裸 DH 那个「中间人各跟一边协商」的经典弱点在这里不成立:
// 中间人没有对端私钥,签不出替换后的公钥。
//
// 临时密钥一次一换,还顺带带来前向保密:事后拿到本机身份文件也解不开抓过的包。
//
// 信封本身就是 HTTP body,所以它的哈希照旧进请求签名 —— 完整性和来源认证不受影响,
// 顺序是**先验签、后解密**(验的是线上真正传的那串字节)。
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { localKxPrivateKey } from "./handoff-identity.js";

/** 换算法/换字段就换它:老信封天然对不上,不会被当成新格式静默接受。 */
const ENC_V1 = "ash-handoff-enc-v1";

interface SealedEnvelope {
  ash: typeof ENC_V1;
  /** base64(SPKI DER):发件方本次现造的 X25519 临时公钥。 */
  epk: string;
  /** base64,12 字节 GCM IV。 */
  iv: string;
  /** base64 密文。 */
  ct: string;
  /** base64,16 字节 GCM 认证标签。 */
  tag: string;
}

function deriveKey(shared: Buffer, epk: string, recipientFp: string): Buffer {
  // info 里绑死临时公钥与收件人指纹:同一个共享秘密不会在别的语境下被复用。
  const info = `${ENC_V1}|${epk}|${recipientFp}`;
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(info, "utf8"), 32));
}

/**
 * 把明文封给某台对端。`peerKxPublicKey` 是它在 ping 里报的 X25519 公钥(已被身份签名覆盖),
 * `peerFingerprint` 只作密钥派生的绑定信息用。
 */
export function sealForPeer(peerKxPublicKey: string, peerFingerprint: string, plaintext: string): string {
  const recipient = createPublicKey({
    key: Buffer.from(peerKxPublicKey, "base64"),
    format: "der",
    type: "spki",
  });
  const eph = generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const key = deriveKey(diffieHellman({ privateKey: eph.privateKey, publicKey: recipient }), epk, peerFingerprint);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: SealedEnvelope = {
    ash: ENC_V1,
    epk,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  return JSON.stringify(envelope);
}

/**
 * 认信封:只看开头一小段,不为了判断类型去 parse 一个可能上百 MB 的 body。
 * 明文 manifest 的第一个字段不可能是 `"ash":"ash-handoff-enc-v1"`,不会误判。
 */
export function looksSealed(raw: string): boolean {
  return raw.slice(0, 64).includes(`"${ENC_V1}"`);
}

/**
 * 拆信封。解不开就抛 —— 密文对不上只有两种可能:发件方封给了别的机器,或者路上被改过,
 * 两种都不该退回「当明文试试」(那等于给降级攻击留门)。
 */
export function openSealed(raw: string, recipientFingerprint: string): string {
  let envelope: SealedEnvelope;
  try {
    envelope = JSON.parse(raw) as SealedEnvelope;
  } catch {
    throw new Error("加密信封不是合法 JSON");
  }
  if (envelope?.ash !== ENC_V1) throw new Error(`不认识的加密信封版本:${String(envelope?.ash)}`);
  const eph = createPublicKey({ key: Buffer.from(envelope.epk, "base64"), format: "der", type: "spki" });
  const key = deriveKey(diffieHellman({ privateKey: localKxPrivateKey(), publicKey: eph }), envelope.epk, recipientFingerprint);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
