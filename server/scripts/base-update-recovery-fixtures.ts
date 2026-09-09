import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, dbClient } from "../src/db/index.js";
import { tasks } from "../src/db/schema.js";
import { acceptTask } from "../src/task-accept.js";
import { updateTaskBase } from "../src/task-base-update.js";

type Fixture = { repo: string; parent: { id: string }; child: { id: string }; childWs: { path: string } };
type Mode = "missing" | "advanced" | "before-reset" | "amended" | "broken-json" | "legacy-gc" | "reset-target";
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export async function seedPendingRecovery(setup: () => Promise<Fixture>, mode: Mode) {
  const pending = await setup();
  await acceptTask(pending.parent.id);
  writeFileSync(join(pending.repo, "unrelated-main.txt"), "another task's change\n");
  git(pending.repo, "add", "unrelated-main.txt"); git(pending.repo, "commit", "-m", "unrelated main change");
  const oldHead = git(pending.childWs.path, "rev-parse", "HEAD");
  await dbClient.execute(`CREATE TRIGGER fixture_base_interrupt BEFORE UPDATE ON tasks WHEN OLD.id='${pending.child.id}' AND OLD.base_update_intent IS NOT NULL AND NEW.base_update_intent IS NULL BEGIN SELECT RAISE(ABORT, 'fixture base interrupt'); END`);
  await assert.rejects(() => updateTaskBase(pending.child.id, oldHead), /fixture base interrupt/);
  await dbClient.execute("DROP TRIGGER fixture_base_interrupt");
  const row = (await db.select().from(tasks).where(eq(tasks.id, pending.child.id)))[0];
  const intent = JSON.parse(row.baseUpdateIntent!);
  if (mode === "missing") rmSync(pending.childWs.path, { recursive: true });
  if (mode === "advanced") {
    writeFileSync(join(pending.childWs.path, "newer.txt"), "work after interruption\n");
    git(pending.childWs.path, "add", "newer.txt"); git(pending.childWs.path, "commit", "-m", "newer work");
  }
  if (mode === "before-reset") git(pending.childWs.path, "reset", "--hard", oldHead);
  if (mode === "amended" || mode === "legacy-gc") {
    writeFileSync(join(pending.childWs.path, "child.txt"), "amended child work\n");
    git(pending.childWs.path, "add", "child.txt"); git(pending.childWs.path, "commit", "--amend", "-m", "amended child");
  }
  if (mode === "broken-json") await db.update(tasks).set({ baseUpdateIntent: "{not json" }).where(eq(tasks.id, pending.child.id));
  if (mode === "reset-target") git(pending.childWs.path, "reset", "--hard", intent.target);
  if (mode === "legacy-gc") git(pending.repo, "update-ref", "-d", `refs/ash/base-update-backups/${pending.child.id}/prepared-${intent.rebased}`);
  if (["amended", "broken-json", "legacy-gc", "reset-target"].includes(mode)) {
    git(pending.repo, "reflog", "expire", "--expire=now", "--all"); git(pending.repo, "gc", "--prune=now");
    writeFileSync(join(pending.childWs.path, "WIP.txt"), "preserve fixture WIP\n");
  }
}
