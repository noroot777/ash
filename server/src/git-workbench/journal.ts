import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitJournalEntry } from "@navi/shared/git-workbench";
import { FROZEN_GIT_BACKUP_REF_NAMESPACE, LEGACY_GIT_WORKBENCH_DIR } from "@navi/shared/legacy-names";
import { git } from "./core.js";

const active = new Set<string>();
export async function journalDirectory(repo: string): Promise<string> {
  const common = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
  const root = resolve(repo, common);
  // 改名之前的操作日志在 `ash-workbench` 里：那个目录在就接着用它，日志不断档。
  const legacy = join(root, LEGACY_GIT_WORKBENCH_DIR);
  if (await stat(legacy).then((info) => info.isDirectory(), () => false)) return legacy;
  return join(root, "navi-workbench");
}
export async function appendEntry(
  repo: string,
  entry: GitJournalEntry,
): Promise<void> {
  const directory = await journalDirectory(repo);
  await mkdir(directory, { recursive: true });
  await appendFile(
    join(directory, "operations.jsonl"),
    JSON.stringify(entry) + "\n",
    { mode: 0o600 },
  );
}
export async function readJournal(repo: string): Promise<GitJournalEntry[]> {
  const file = await open(
    join(await journalDirectory(repo), "operations.jsonl"),
    "r",
  ).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let content = "";
  if (file) {
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - 2 * 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      content = buffer.subarray(0, bytesRead).toString("utf8");
      if (start) content = content.slice(content.indexOf("\n") + 1);
    } finally {
      await file.close();
    }
  }
  const entries = new Map<string, GitJournalEntry>();
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as GitJournalEntry;
      entries.set(entry.id, entry);
    } catch {
      /* incomplete append */
    }
  }
  return [...entries.values()]
    .reverse()
    .slice(0, 200)
    .map((entry) =>
      ["queued", "running"].includes(entry.state) && !active.has(entry.id)
        ? {
            ...entry,
            state: "interrupted",
            message:
              "服务曾中断，操作结果尚未确认。请检查当前 Git 状态和 reflog 后再决定下一步。",
          }
        : entry,
    );
}
export function startEntry(
  root: string,
  action: string,
  actor: string,
): GitJournalEntry {
  const entry: GitJournalEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actor,
    root,
    action,
    state: "queued",
    message: "等待仓库锁，前面的操作结束后继续",
  };
  active.add(entry.id);
  return entry;
}
export const finishEntry = (id: string) => active.delete(id);
export async function backupHead(
  repo: string,
  entry: GitJournalEntry,
): Promise<void> {
  if (!entry.before) return;
  entry.backup = `${FROZEN_GIT_BACKUP_REF_NAMESPACE}${entry.id}`;
  entry.recovery = "head";
  await git(repo, ["update-ref", entry.backup, entry.before, ""]);
}
