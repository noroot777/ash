import { sign, type KeyObject } from "node:crypto";
import type { Hono } from "hono";
import type { HumanApprovalChallenge, HumanApprovalProof } from "../src/auth/human-approval.js";

export function turnReclaimPost(app: Hono, privateKey: KeyObject) {
  return async (path: string, body?: unknown) => {
    let approval: HumanApprovalProof | undefined;
    if (body === undefined && path.endsWith("/reclaim-turn")) {
      const response = await app.request(`${path}/approval`, { method: "POST" });
      if (response.ok) {
        const challenge = await response.json() as HumanApprovalChallenge;
        approval = {
          challengeId: challenge.challengeId,
          signature: sign(null, Buffer.from(challenge.payload), privateKey).toString("base64url"),
        };
      }
    }
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? (path.endsWith("/reclaim-turn") ? { acknowledgeDuplicateRisk: true, approval } : {})),
    });
  };
}
