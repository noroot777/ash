import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveAshDbFile } from "../db/path.js";

export type HumanApprovalScope = {
  action: "reclaim-turn";
  taskId: string;
  turnSeq: number;
  claimedAt: number;
  userId: string | null;
};

export type HumanApprovalChallenge = {
  challengeId: string;
  payload: string;
  expiresAt: number;
};

export type HumanApprovalProof = { challengeId: string; signature: string };

export const HUMAN_APPROVAL_UNAVAILABLE =
  "放开回合占位需要离机人工授权；实例尚未配置有效公钥。可将离机公钥写入服务的 .human-approval.pub 文件后重试，无需重启；也支持启动配置 ASH_HUMAN_APPROVAL_PUBLIC_KEY。当前不会放开互斥";

const bucketOf = (scope: HumanApprovalScope) => JSON.stringify([scope.userId, scope.action, scope.taskId]);
const sameScope = (left: HumanApprovalScope, right: HumanApprovalScope) => bucketOf(left) === bucketOf(right)
  && left.turnSeq === right.turnSeq && left.claimedAt === right.claimedAt;

export class HumanApprovalAuthority {
  private key: KeyObject | null = null;
  private encodedKey: string | undefined;
  private keyFingerprint: string | null = null;
  private readonly instance = randomUUID();
  private readonly pending = new Map<string, HumanApprovalChallenge & { scope: HumanApprovalScope }>();

  constructor(private readonly publicKey: string | undefined | (() => string | undefined), private readonly now = Date.now) {
    this.refresh();
  }

  get fingerprint(): string | null {
    this.refresh();
    return this.keyFingerprint;
  }

  private refresh(): void {
    let publicKey: string | undefined;
    try { publicKey = typeof this.publicKey === "function" ? this.publicKey() : this.publicKey; } catch {}
    if (publicKey === this.encodedKey) return;
    this.encodedKey = publicKey;
    this.pending.clear();
    let key: KeyObject | null = null;
    try {
      if (publicKey) {
        const parsed = createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" });
        if (parsed.asymmetricKeyType === "ed25519") key = parsed;
      }
    } catch {}
    this.key = key;
    this.keyFingerprint = key
      ? createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex")
      : null;
  }

  issue(scope: HumanApprovalScope, taskTitle: string): HumanApprovalChallenge | null {
    this.refresh();
    if (!this.key) return null;
    const now = this.now();
    for (const [bucket, challenge] of this.pending) {
      if (challenge.expiresAt <= now) this.pending.delete(bucket);
    }
    const bucket = bucketOf(scope);
    const existing = this.pending.get(bucket);
    if (existing && sameScope(existing.scope, scope)) {
      return { challengeId: existing.challengeId, payload: existing.payload, expiresAt: existing.expiresAt };
    }
    const challengeId = randomUUID();
    const expiresAt = now + 5 * 60_000;
    const payload = JSON.stringify({
      purpose: "ash-human-approval-v1",
      instance: this.instance,
      keyFingerprint: this.keyFingerprint,
      challengeId,
      ...scope,
      taskTitle,
      risk: "允许解除回合互斥；原持有者可能仍存活，两个回合可能并行修改同一个工作区",
      issuedAt: now,
      expiresAt,
    });
    this.pending.set(bucket, { challengeId, payload, scope: { ...scope }, expiresAt });
    return { challengeId, payload, expiresAt };
  }

  consume(proof: unknown, scope: HumanApprovalScope): { keyFingerprint: string } | null {
    this.refresh();
    if (!this.key || !proof || typeof proof !== "object") return null;
    const { challengeId, signature } = proof as Partial<HumanApprovalProof>;
    if (typeof challengeId !== "string" || typeof signature !== "string"
      || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
    const bucket = bucketOf(scope);
    const challenge = this.pending.get(bucket);
    if (!challenge || challenge.challengeId !== challengeId) return null;
    if (challenge.expiresAt <= this.now()) {
      this.pending.delete(bucket);
      return null;
    }
    if (!sameScope(challenge.scope, scope)) return null;
    if (!verify(null, Buffer.from(challenge.payload), this.key, Buffer.from(signature, "base64url"))) return null;
    this.pending.delete(bucket);
    return { keyFingerprint: this.keyFingerprint! };
  }
}

export function humanApprovalPublicKeyFile(): string {
  return process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY_FILE || `${resolveAshDbFile()}.human-approval.pub`;
}

export const humanApproval = new HumanApprovalAuthority(() => {
  if (process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY) return process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY;
  try { return readFileSync(humanApprovalPublicKeyFile(), "utf8").trim(); } catch { return undefined; }
});
