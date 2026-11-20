import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type RuntimeRecordSnapshot = { current?: string; backup?: string };

function read(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function readRuntimeRecord(endpoint: string): RuntimeRecordSnapshot {
  return { current: read(endpoint), backup: read(endpoint + ".backup") };
}

export function replaceRuntimeRecord(endpoint: string, expected: RuntimeRecordSnapshot, value: object | null): void {
  const lock = new DatabaseSync(endpoint + ".writer.sqlite");
  try {
    lock.exec("PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE");
    const actual = readRuntimeRecord(endpoint);
    if (actual.current !== expected.current || actual.backup !== expected.backup) {
      throw new Error("channel identity record changed concurrently");
    }
    if (value === null) {
      if (actual.current !== undefined) renameSync(endpoint, endpoint + ".previous");
      if (actual.backup !== undefined) renameSync(endpoint + ".backup", endpoint + ".backup.previous");
    } else {
      const text = JSON.stringify(value);
      for (const path of [endpoint, endpoint + ".backup"]) {
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(temporary, text, { mode: 0o600 });
        renameSync(temporary, path);
      }
    }
    lock.exec("COMMIT");
  } finally { lock.close(); }
}
