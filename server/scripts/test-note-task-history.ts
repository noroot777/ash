import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Note, NoteSearchHit } from "@harness/shared";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "harness-note-history-"));
const dbFile = join(root, "harness.db");
process.env.HARNESS_DB = dbFile;

// Start from the old single-link shape so this test also pins the startup migration.
const legacy = createClient({ url: `file:${dbFile}` });
await legacy.executeMultiple(`
  CREATE TABLE notes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL,
    attachments TEXT, task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  INSERT INTO notes (id, project_id, body, attachments, task_id, created_at, updated_at)
  VALUES ('note', 'project', 'legacy note body', NULL, 'task-one', 100, 200);
`);
legacy.close();

const [{ db, ensureSchema }, schema, { mountNoteRoutes }, { mountTaskRoutes }, { searchAll }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/notes.js"),
  import("../src/task-routes.js"),
  import("../src/search.js"),
]);
const { noteTasks, projects, tasks } = schema;

await ensureSchema();
const at = new Date().toISOString();

try {
  await db.insert(projects).values({ id: "project", name: "notes", repoPath: root, createdAt: at });
  await db.insert(tasks).values([
    { id: "task-one", projectId: "project", title: "first task", createdAt: at, updatedAt: at },
    { id: "task-two", projectId: "project", title: "second task", createdAt: at, updatedAt: at },
  ]);

  const api = new Hono();
  mountNoteRoutes(api);
  mountTaskRoutes(api);

  let response = await api.request("/notes?projectId=project");
  assert.equal(response.status, 200);
  let note = (await response.json() as Note[])[0];
  assert.deepEqual(note.taskLinks.map((link) => link.taskId), ["task-one"], "legacy task_id must migrate");

  response = await api.request("/notes/note", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "task-two" }),
  });
  assert.equal(response.status, 200);
  note = await response.json() as Note;
  assert.deepEqual(note.taskLinks.map((link) => link.taskId), ["task-two", "task-one"]);
  assert.equal(note.taskLinks[0].title, "second task", "history should expose task titles for the note page");

  // Repeating the same conversion is idempotent, while a different task remains in history.
  response = await api.request("/notes/note", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "task-two" }),
  });
  note = await response.json() as Note;
  assert.equal(note.taskLinks.length, 2);
  assert.equal((await db.select().from(noteTasks).where(eq(noteTasks.noteId, "note"))).length, 2);

  const hit = (await searchAll("legacy")).find((item): item is NoteSearchHit => item.kind === "note");
  assert.equal(hit?.taskCount, 2, "global search badge should show the complete conversion count");

  response = await api.request("/tasks/task-one", { method: "DELETE" });
  assert.equal(response.status, 200);
  response = await api.request("/notes?projectId=project");
  note = (await response.json() as Note[])[0];
  assert.deepEqual(note.taskLinks.map((link) => link.taskId), ["task-two"], "deleting a task must remove its backlink");

  response = await api.request("/notes/note", { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal((await db.select().from(noteTasks).where(eq(noteTasks.noteId, "note"))).length, 0);

  console.log("note task history tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
