// 接力身份:本机的一对 ed25519 密钥、由公钥派生的指纹,以及请求签名/验签原语。
//
// 为什么是「一机一对非对称密钥」而不是「一把共享 key」(2026-08-22 与用户讨论后定):
//   1. 共享 key 必须配到每台目标机上,而目标机清单存在 app_settings、`GET /settings`
//      会把它整份吐回前端 —— 一个打开的网页就能拿走全部对端凭据,一台被打穿等于全网
//      被打穿。指纹和公钥不是秘密,存 settings、进应答都无害;私钥永远不出这台机器。
//   2. 共享 key 只能证明「来的人有资格进」,证明不了「我要发的这台还是不是原来那台」。
//      接力推的是整个 git bundle + CLI 会话历史(里面什么都有),IP 漂移、DHCP 换租约
//      或局域网里有人抢地址,就足以把它推给一台陌生主机。所以源机在打包前必须**反向**
//      核对对端指纹 —— 这一半是对称密钥做不到的,见 handoff-peer-client.ts pingPeer。
//   3. 一台一份公钥:吊销 = 删一行,不必全网轮换;谁来过、批没批准也才有得记。
//
// 私钥落在 DB 文件旁边的 `<db>.identity.json`(0600),**不进 DB**:库会被 preview-seed
// 快照、被用户备份来回搬,私钥跟着走就等于身份被复制成两份。挂 DB 路径而不是 DATA_DIR
// 还顺带保证「不同 ASH_DB = 不同机器」,接力回归测试的源机/对端才能在同一台电脑上跑。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync,
  randomBytes, sign, timingSafeEqual, verify, type KeyObject,
} from "node:crypto";
import { resolveAshDbFile } from "./db/path.js";

/** 签名覆盖的协议版本串:换算法/换字段就换它,老签名天然验不过,不会被静默接受。 */
const SIG_V1 = "ash-handoff-v1";

export interface LocalIdentity {
  /** 公钥 SPKI DER 的 sha256,小写 hex 64 位。机器身份的规范形式,比对一律用它。 */
  fingerprint: string;
  /** base64(SPKI DER)。对端拿它验签,不是秘密。 */
  publicKey: string;
}

interface IdentityFile {
  version: 1;
  privateKeyPem: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

function identityFilePath(): string {
  return `${resolveAshDbFile()}.identity.json`;
}

export function fingerprintOf(publicKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex");
}

/**
 * 给人看的短指纹:前 20 个 hex 字符(80 bit)分成 5 组。首次配对时两边设置页各显示一份,
 * 肉眼核一次就够;机器之间的比对永远用完整 fingerprint,不用这个。
 */
export function shortFingerprint(fingerprint: string): string {
  return (fingerprint.slice(0, 20).toUpperCase().match(/.{1,4}/g) ?? []).join("-");
}

let cached: { file: IdentityFile; key: KeyObject } | null = null;

function loadOrCreate(): { file: IdentityFile; key: KeyObject } {
  if (cached) return cached;
  const path = identityFilePath();
  if (existsSync(path)) {
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as IdentityFile;
      if (file?.version === 1 && file.privateKeyPem && file.publicKey) {
        // 指纹按公钥现算,不信文件里那份:手改过的文件不能让本机拿着错指纹到处自我介绍。
        const fingerprint = fingerprintOf(file.publicKey);
        cached = { file: { ...file, fingerprint }, key: createPrivateKey(file.privateKeyPem) };
        return cached;
      }
    } catch {
      // 损坏的身份文件不能静默重建 —— 换指纹等于所有对端的信任记录一起作废,
      // 用户会看到一堆「对端身份变了」却不知道为什么。宁可让它显式炸。
      throw new Error(`接力身份文件损坏或不可读:${path}。修好它,或删掉它让本机重新生成一份新身份(所有对端需要重新批准)。`);
    }
    throw new Error(`接力身份文件格式不认识:${path}`);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const file: IdentityFile = {
    version: 1,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    fingerprint: "",
    createdAt: new Date().toISOString(),
  };
  file.fingerprint = fingerprintOf(file.publicKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  // 已存在的文件 writeFileSync 不会改权限,补一次 chmod(Windows 上是空操作)。
  try { chmodSync(path, 0o600); } catch { /* 文件系统不支持权限位 */ }
  cached = { file, key: privateKey };
  return cached;
}

export function localIdentity(): LocalIdentity {
  const { file } = loadOrCreate();
  return { fingerprint: file.fingerprint, publicKey: file.publicKey };
}

/** 只给测试用:换 ASH_DB 之后强制重读身份(同进程里模拟两台机器)。 */
export function resetIdentityCache(): void {
  cached = null;
}

export function signWithLocalKey(canonical: string): string {
  return sign(null, Buffer.from(canonical, "utf8"), loadOrCreate().key).toString("base64");
}

export function verifyWithPeerKey(publicKeyB64: string, canonical: string, sigB64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(canonical, "utf8"), key, Buffer.from(sigB64, "base64"));
  } catch {
    // 公钥不是合法 SPKI / 签名不是合法 base64:一律按验签失败,不区分原因。
    return false;
  }
}

export const sha256Hex = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("hex");

export const newNonce = (): string => randomBytes(16).toString("hex");

/**
 * 请求签名覆盖的规范串。**body 的哈希也在里面** —— 只签路径不签内容的话,
 * 中间人可以留着签名头把 manifest 换成任意内容(接力的 body 就是整个仓库和会话历史)。
 * method/path 进签名防止把一个 /refs 的签名挪去打 /import。
 */
export function canonicalRequest(input: {
  method: string;
  path: string;
  ts: string;
  nonce: string;
  bodyHash: string;
}): string {
  return [SIG_V1, input.method.toUpperCase(), input.path, input.ts, input.nonce, input.bodyHash].join("\n");
}

/**
 * 探活挑战:源机发一个随机 nonce,对端必须用私钥签它。
 * 少了这一步,任何人都能复读一份抄来的公钥冒充对端 —— 公钥是公开的,持有它不算身份。
 */
export function canonicalPingChallenge(nonce: string): string {
  return [SIG_V1, "ping", nonce].join("\n");
}

/** 指纹比对走定长常量时间比较,顺带把大小写/空白差异归一掉。 */
export function sameFingerprint(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a.trim().toLowerCase(), "utf8");
  const y = Buffer.from(b.trim().toLowerCase(), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
