import type { Note } from "@harness/shared";
import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { notes, projects, tasks } from "./db/schema.js";
import { id } from "./util.js";

type NoteBody = {
  projectId?: unknown;
  body?: unknown;
  attachments?: unknown;
  taskId?: unknown;
};

function attachments(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function toNote(row: typeof notes.$inferSelect): Note {
  let parsed: string[] = [];
  try {
    const value = row.attachments ? JSON.parse(row.attachments) : [];
    if (Array.isArray(value)) parsed = value.filter((item): item is string => typeof item === "string");
  } catch {
    /* malformed legacy value: expose an empty list instead of breaking the modal */
  }
  return { ...row, attachments: parsed };
}

export function mountNoteRoutes(api: Hono) {
  api.get("/notes", async (c) => {
    const projectId = c.req.query("projectId");
    const rows = projectId
      ? await db.select().from(notes).where(eq(notes.projectId, projectId)).orderBy(desc(notes.updatedAt))
      : await db.select().from(notes).orderBy(desc(notes.updatedAt));
    return c.json(rows.map(toNote));
  });

  api.post("/notes", async (c) => {
    const body = await c.req.json<NoteBody>();
    if (typeof body.projectId !== "string" || !body.projectId.trim()) {
      return c.json({ error: "projectId required" }, 400);
    }
    if (typeof body.body !== "string" || !body.body.trim()) {
      return c.json({ error: "body required" }, 400);
    }
    const project = (await db.select().from(projects).where(eq(projects.id, body.projectId))).at(0);
    if (!project) return c.json({ error: "project not found" }, 404);
    const files = attachments(body.attachments);
    if (body.attachments !== undefined && files === null) {
      return c.json({ error: "attachments must be a string array" }, 400);
    }
    const timestamp = Date.now();
    const row: typeof notes.$inferInsert = {
      id: id(),
      projectId: project.id,
      body: body.body,
      attachments: files?.length ? JSON.stringify(files) : null,
      taskId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db.insert(notes).values(row);
    return c.json(toNote(row as typeof notes.$inferSelect), 201);
  });

  api.patch("/notes/:id", async (c) => {
    const noteId = c.req.param("id");
    const existing = (await db.select().from(notes).where(eq(notes.id, noteId))).at(0);
    if (!existing) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<NoteBody>();
    const patch: Partial<typeof notes.$inferInsert> = {};
    if (body.body !== undefined) {
      if (typeof body.body !== "string" || !body.body.trim()) return c.json({ error: "body required" }, 400);
      patch.body = body.body;
    }
    if (body.attachments !== undefined) {
      const files = attachments(body.attachments);
      if (files === null) return c.json({ error: "attachments must be a string array" }, 400);
      patch.attachments = files.length ? JSON.stringify(files) : null;
    }
    if (body.taskId !== undefined) {
      if (body.taskId !== null && typeof body.taskId !== "string") {
        return c.json({ error: "taskId must be a string or null" }, 400);
      }
      if (typeof body.taskId === "string") {
        const task = (await db.select().from(tasks).where(eq(tasks.id, body.taskId))).at(0);
        if (!task) return c.json({ error: "task not found" }, 404);
        if (task.projectId !== existing.projectId) return c.json({ error: "task belongs to another project" }, 400);
      }
      patch.taskId = body.taskId;
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = Date.now();
      await db.update(notes).set(patch).where(eq(notes.id, noteId));
    }
    const updated = (await db.select().from(notes).where(eq(notes.id, noteId))).at(0)!;
    return c.json(toNote(updated));
  });

  api.delete("/notes/:id", async (c) => {
    const noteId = c.req.param("id");
    const existing = (await db.select({ id: notes.id }).from(notes).where(eq(notes.id, noteId))).at(0);
    if (!existing) return c.json({ error: "not found" }, 404);
    await db.delete(notes).where(eq(notes.id, noteId));
    return c.json({ deleted: true });
  });
}
