import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";

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
  "放开回合占位需要离机人工授权；实例尚未配置有效的 ASH_HUMAN_APPROVAL_PUBLIC_KEY，当前不会放开互斥";

export class HumanApprovalAuthority {
  private readonly key: KeyObject | null;
  private readonly instance = randomUUID();
  private readonly pending = new Map<string, { payload: string; scope: HumanApprovalScope; expiresAt: number }>();
  readonly fingerprint: string | null;

  constructor(publicKey: string | undefined, private readonly now = Date.now) {
    let key: KeyObject | null = null;
    try {
      if (publicKey) {
        const parsed = createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" });
        if (parsed.asymmetricKeyType === "ed25519") key = parsed;
      }
    } catch {}
    this.key = key;
    this.fingerprint = key
      ? createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex")
      : null;
  }

  issue(scope: HumanApprovalScope, taskTitle: string): HumanApprovalChallenge | null {
    if (!this.key) return null;
    const now = this.now();
    for (const [challengeId, challenge] of this.pending) {
      if (challenge.expiresAt <= now) this.pending.delete(challengeId);
    }
    if (this.pending.size >= 1024) return null;
    const challengeId = randomUUID();
    const expiresAt = now + 5 * 60_000;
    const payload = JSON.stringify({
      purpose: "ash-human-approval-v1",
      instance: this.instance,
      keyFingerprint: this.fingerprint,
      challengeId,
      ...scope,
      taskTitle,
      risk: "允许解除回合互斥；原持有者可能仍存活，两个回合可能并行修改同一个工作区",
      expiresAt,
    });
    this.pending.set(challengeId, { payload, scope: { ...scope }, expiresAt });
    return { challengeId, payload, expiresAt };
  }

  consume(proof: unknown, scope: HumanApprovalScope): { keyFingerprint: string } | null {
    if (!this.key || !proof || typeof proof !== "object") return null;
    const { challengeId, signature } = proof as Partial<HumanApprovalProof>;
    if (typeof challengeId !== "string" || typeof signature !== "string"
      || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
    const challenge = this.pending.get(challengeId);
    if (!challenge) return null;
    if (challenge.expiresAt <= this.now()) {
      this.pending.delete(challengeId);
      return null;
    }
    if (challenge.scope.action !== scope.action || challenge.scope.taskId !== scope.taskId
      || challenge.scope.turnSeq !== scope.turnSeq || challenge.scope.claimedAt !== scope.claimedAt
      || challenge.scope.userId !== scope.userId) return null;
    if (!verify(null, Buffer.from(challenge.payload), this.key, Buffer.from(signature, "base64url"))) return null;
    this.pending.delete(challengeId);
    return { keyFingerprint: this.fingerprint! };
  }
}

export const humanApproval = new HumanApprovalAuthority(process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY);
