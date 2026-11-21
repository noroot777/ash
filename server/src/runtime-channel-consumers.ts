import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type ProcessProof = { pid: number; startedAt: number; command: string };
export function processProof(pid: number): ProcessProof | null | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? null : undefined; }
  try {
    const text = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "stat=", "-o", "command=", "-ww"], {
      encoding: "utf8", timeout: 1_000, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = text.match(/^(.{24})\s+(\S+)\s+([\s\S]+)$/);
    if (!match) return undefined;
    if (match[2].startsWith("Z")) return null;
    const startedAt = Date.parse(match[1]);
    return Number.isFinite(startedAt) ? { pid, startedAt, command: match[3] } : undefined;
  } catch (error) { return (error as { status?: number }).status === 1 ? null : undefined; }
}

function startedTime(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const match = value.match(/^\S+\s+(\d{1,2})月\/?\s*(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  return match ? new Date(Number(match[6]), Number(match[1]) - 1, Number(match[2]),
    Number(match[3]), Number(match[4]), Number(match[5])).getTime() : NaN;
}

export function hasGatewayConsumers(dbFile: string | undefined, id?: string): boolean {
  if (!dbFile) return true;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(dbFile, { readOnly: true });
    const rows = database.prepare("SELECT agent_pid AS pid, agent_started_at AS started, agent_out_path AS out FROM sessions WHERE agent_pid > 0").all();
    const proofs = new Map<number, ProcessProof | null | undefined>();
    for (const row of rows) {
      const pid = Number(row.pid);
      if (!proofs.has(pid)) proofs.set(pid, processProof(pid));
      const proof = proofs.get(pid);
      const started = startedTime(row.started);
      if (proof === null || (proof && Number.isFinite(started) && proof.startedAt !== started)) continue;
      if (typeof row.out !== "string" || !row.out) continue;
      try {
        const record = JSON.parse(readFileSync(row.out + ".runtime-channels.json", "utf8"));
        if (record.unknown || ![1, 2].includes(record.version)) return true;
        if (record.version === 2) {
          if (!Array.isArray(record.stable) || record.stable.some((channel: unknown) =>
            typeof channel !== "string" || !["context-1m", "convert", "monitor"].includes(channel))
            || (record.stable.length && typeof record.gateway !== "string")) return true;
          if (record.stable.length && (id === undefined || record.gateway === id)) return true;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
    }
    return false;
  } catch { return true; }
  finally { database?.close(); }
}
