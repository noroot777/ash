import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { canonicalPingChallenge, fingerprintOf } from "../src/handoff-identity.js";

export async function startSignedHandoffPeer() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  let mode: "valid" | "invalid" | "missing" = "valid";
  let held: { received(): void; released: Promise<void> } | undefined;
  const credentials: (string | undefined)[] = [];
  const server = createServer(async (req, res) => {
    credentials.push(req.headers["x-ash-peer-user-key"] as string | undefined);
    const gate = held;
    held = undefined;
    if (gate) { gate.received(); await gate.released; }
    const nonce = new URL(req.url!, "http://localhost").searchParams.get("nonce") ?? "";
    const sig = sign(null, Buffer.from(canonicalPingChallenge(mode === "invalid" ? "wrong-nonce" : nonce)), keys.privateKey).toString("base64");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true, service: "ash", host: "fixture", projects: [], peerStatus: "approved",
      ...(mode === "missing" ? {} : { identity: { publicKey, sig } }),
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    fingerprint: fingerprintOf(publicKey),
    credentials,
    setMode(next: typeof mode) { mode = next; },
    holdNextProbe() {
      const received = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      held = { received: received.resolve, released: released.promise };
      return { received: received.promise, release: released.resolve };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
