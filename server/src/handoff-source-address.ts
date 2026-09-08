import type { HandoffTarget, TaskHandoff } from "@ash/shared";
import type { HandoffSourceAddress } from "@ash/shared/handoff";
import { desc, inArray, isNotNull } from "drizzle-orm";
import type { Actor } from "./auth/context.js";
import { isAccountHolder } from "./auth/context.js";
import { listTargets, saveVerifiedTargetAddress } from "./auth/handoff-scope.js";
import { visibleProjectIds } from "./auth/visibility.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { sameFingerprint } from "./handoff-identity.js";
import { normalizePeerUrl, probeSignedPeerFingerprint } from "./handoff-peer-client.js";
import { listPeers } from "./handoff-peers.js";
import { HandoffError } from "./handoff-types.js";

export async function listSourceAddresses(actor: Actor): Promise<HandoffSourceAddress[]> {
  const [visible, targets, peers] = await Promise.all([
    visibleProjectIds(actor), listTargets(actor), listPeers(actor),
  ]);
  const rows = visible?.size === 0 ? [] : await db
    .select({ handoff: tasks.handoff }).from(tasks)
    .where(visible ? inArray(tasks.projectId, [...visible]) : isNotNull(tasks.handoff))
    .orderBy(desc(tasks.updatedAt));
  const sources = new Map<string, HandoffSourceAddress>();
  for (const row of rows) {
    if (!row.handoff) continue;
    let marker: TaskHandoff;
    try { marker = JSON.parse(row.handoff) as TaskHandoff; } catch { continue; }
    if (!marker || marker.direction !== "in" || typeof marker.peerFp !== "string" || !marker.peerFp) continue;
    const fingerprint = marker.peerFp.trim().toLowerCase();
    if (!sources.has(fingerprint)) sources.set(fingerprint, {
      fingerprint, name: marker.peerName || "来源机器", url: marker.peerUrl || "",
    });
  }
  for (const peer of peers) {
    if (peer.returnOnly || sources.has(peer.fingerprint)) continue;
    sources.set(peer.fingerprint, {
      fingerprint: peer.fingerprint, name: peer.name || "来源机器", url: "",
    });
  }
  return [...sources.values()].map((source) => {
    const registered = targets.find((target) => target.peerFp
      && sameFingerprint(target.peerFp, source.fingerprint));
    return { ...source, url: registered?.url ?? source.url };
  });
}

export async function updateSourceAddress(
  actor: Actor,
  fingerprint: string,
  rawUrl: string,
): Promise<HandoffTarget[]> {
  if (!isAccountHolder(actor)) throw new HandoffError("来源机器地址只能由账号本人修改", 403);
  const source = (await listSourceAddresses(actor))
    .find((item) => sameFingerprint(item.fingerprint, fingerprint));
  if (!source) throw new HandoffError("没有可修改的来源机器", 404);
  const url = normalizePeerUrl(rawUrl);
  const actual = await probeSignedPeerFingerprint(url, 5_000);
  if (!actual) {
    throw new HandoffError("无法核对新地址的来源机身份。请确认地址、端口和 ash 运行状态后重试；原地址未修改。", 502);
  }
  if (!sameFingerprint(actual, source.fingerprint)) {
    throw new HandoffError("新地址的身份指纹与来源机器不一致，原地址未修改。请填写原来那台机器的新地址。", 409);
  }
  await saveVerifiedTargetAddress(actor, { name: source.name, url, peerFp: source.fingerprint });
  return listTargets(actor);
}
