import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";

const [command, keyPath, requestPath] = process.argv.slice(2);
try {
  if (command === "generate" && keyPath && !requestPath) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    stdout.write(`ASH_HUMAN_APPROVAL_PUBLIC_KEY=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}\n`);
  } else if (command === "sign" && keyPath && requestPath) {
    const key = createPrivateKey(readFileSync(keyPath));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("授权私钥不是 Ed25519");
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    if (typeof request.payload !== "string") throw new Error("申请缺少 payload");
    const payload = JSON.parse(request.payload);
    const fingerprint = createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex");
    if (payload.purpose !== "ash-human-approval-v1" || payload.action !== "reclaim-turn"
      || payload.keyFingerprint !== fingerprint || payload.challengeId !== request.challengeId
      || typeof payload.taskId !== "string" || !payload.taskId || !Number.isSafeInteger(payload.turnSeq)
      || !Number.isFinite(payload.claimedAt) || !Number.isFinite(payload.expiresAt)
      || payload.expiresAt <= Date.now() || payload.expiresAt > Date.now() + 5 * 60_000) {
      throw new Error("申请无效、已过期或授权公钥不匹配");
    }
    stderr.write(`将解除回合互斥，原持有者可能仍存活，两个回合可能并行修改工作区。\n${JSON.stringify(payload, null, 2)}\n`);
    const terminal = createInterface({ input: stdin, output: stderr });
    const cancellation = new AbortController();
    terminal.once("close", () => cancellation.abort());
    let confirmed;
    try { confirmed = await terminal.question("确认目标和风险后，输入任务 ID 授权：", { signal: cancellation.signal }); }
    finally { terminal.close(); }
    if (confirmed !== payload.taskId) throw new Error("未确认任务，未签名");
    if (payload.expiresAt <= Date.now()) throw new Error("申请已过期，未签名");
    stdout.write(JSON.stringify({ challengeId: request.challengeId, signature: sign(null, Buffer.from(request.payload), key).toString("base64url") }) + "\n");
  } else {
    throw new Error("用法：node scripts/human-approval.mjs generate <离机私钥.pem> | sign <离机私钥.pem> <授权申请.json>");
  }
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
