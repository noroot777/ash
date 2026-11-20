import { get } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnv } from "@navi/shared/env-names";
import { releaseCodeLockForExec } from "@navi/shared/code-lock";
import { managedRuntime, publishMcpRuntime } from "./runtime-store.js";

function desktopData(): string {
  const explicit = readEnv(process.env, "NAVI_DATA_DIR");
  if (explicit) return explicit;
  for (const domain of ["dev.navi.mac", "dev.ash.mac"]) {
    try {
      const setting = execFileSync("/usr/bin/defaults", ["read", domain, "NaviDataDir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (setting) return setting;
    } catch {}
  }
  const support = join(homedir(), "Library/Application Support");
  let pinned = false;
  try { pinned = execFileSync("/usr/bin/defaults", ["read", "dev.navi.mac", "DataRootFromAsh"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "1"; } catch {}
  const legacy = existsSync(join(support, "dev.ash.mac"));
  return join(support, legacy && (pinned || !existsSync(join(support, "dev.navi.mac"))) ? "dev.ash.mac" : "dev.navi.mac");
}

export async function redirectPackagedMcp(): Promise<void> {
  if (process.platform !== "darwin") return;
  const source = fileURLToPath(new URL("../..", import.meta.url));
  if (!source.includes(".app/Contents/") || !existsSync(join(source, "runtime-manifest.json"))) return;
  const url = new URL(readEnv(process.env, "NAVI_URL") ?? "http://127.0.0.1:4317");
  let health: Record<string, any> | null = null;
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/health`;
    health = await new Promise((done) => {
      const request = get(url, { timeout: 750 }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; if (body.length > 64_000) request.destroy(); });
        response.on("end", () => { try { done(response.statusCode === 200 ? JSON.parse(body) : null); } catch { done(null); } });
        response.on("error", () => done(null));
      });
      request.on("timeout", () => request.destroy());
      request.on("error", () => done(null));
    });
  }
  const instance = health?.ok === true && health.instance?.desktop === true ? health.instance : null;
  const explicit = readEnv(process.env, "NAVI_DATA_DIR");
  const data = explicit ?? (typeof instance?.dataDir === "string" ? instance.dataDir : desktopData());
  const serving = typeof instance?.codeDir === "string" && managedRuntime(instance.codeDir, data) ? instance.codeDir : undefined;
  const runtime = publishMcpRuntime(source, data, serving);
  const node = join(runtime.root, "node/bin/node");
  releaseCodeLockForExec();
  try {
    process.execve!(node, [node, join(runtime.root, "mcp/dist/index.js")], process.env as Record<string, string>);
    throw new Error("运行时 exec 未替换进程");
  } finally { runtime.close(); }
}
