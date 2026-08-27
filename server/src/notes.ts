import type { Note, NoteTaskLink, TaskStatus } from "@ash/shared";
import { desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { notes, noteTasks, projects, tasks } from "./db/schema.js";
import { id } from "./util.js";
import { actorOf } from "./auth/context.js";
import { canUseOwned, filterOwned, ownerStamp } from "./auth/owned.js";

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

function toNote(row: typeof notes.$inferSelect, taskLinks: NoteTaskLink[] = []): Note {
  let parsed: string[] = [];
  try {
    const value = row.attachments ? JSON.parse(row.attachments) : [];
    if (Array.isArray(value)) parsed = value.filter((item): item is string => typeof item === "string");
  } catch {
    /* malformed legacy value: expose an empty list instead of breaking the modal */
  }
  return { ...row, attachments: parsed, taskLinks };
}

async function withTaskLinks(rows: (typeof notes.$inferSelect)[]): Promise<Note[]> {
  if (!rows.length) return [];
  const links = await db
    .select({
      noteId: noteTasks.noteId,
      taskId: tasks.id,
      title: tasks.title,
      status: tasks.status,
      archived: tasks.archived,
      linkedAt: noteTasks.createdAt,
    })
    .from(noteTasks)
    .innerJoin(tasks, eq(noteTasks.taskId, tasks.id))
    .where(inArray(noteTasks.noteId, rows.map((row) => row.id)))
    .orderBy(desc(noteTasks.createdAt));
  const byNote = new Map<string, NoteTaskLink[]>();
  for (const link of links) {
    const current = byNote.get(link.noteId) ?? [];
    current.push({ ...link, status: link.status as TaskStatus });
    byNote.set(link.noteId, current);
  }
  return rows.map((row) => toNote(row, byNote.get(row.id) ?? []));
}

export function mountNoteRoutes(api: Hono) {
  // 随手记在多人模式下**转私有**(§八):同一个共享项目里,各人的随手记互不可见。
  // 所以这里过的是归属(ownerUserId),不是项目成员表 —— 两条轴叠加。
  api.get("/notes", async (c) => {
    const projectId = c.req.query("projectId");
    const rows = projectId
      ? await db.select().from(notes).where(eq(notes.projectId, projectId)).orderBy(desc(notes.updatedAt))
      : await db.select().from(notes).orderBy(desc(notes.updatedAt));
    return c.json(await withTaskLinks(await filterOwned(rows, actorOf(c))));
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
      ...ownerStamp(actorOf(c)),
      body: body.body,
      attachments: files?.length ? JSON.stringify(files) : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db.insert(notes).values(row);
    return c.json(toNote(row as typeof notes.$inferSelect), 201);
  });

  api.patch("/notes/:id", async (c) => {
    const noteId = c.req.param("id");
    const existing = (await db.select().from(notes).where(eq(notes.id, noteId))).at(0);
    if (!existing || !(await canUseOwned(existing, actorOf(c)))) return c.json({ error: "not found" }, 404);
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
    let linksChanged = false;
    if (body.taskId !== undefined) {
      if (body.taskId !== null && typeof body.taskId !== "string") {
        return c.json({ error: "taskId must be a string or null" }, 400);
      }
      if (typeof body.taskId === "string") {
        const task = (await db.select().from(tasks).where(eq(tasks.id, body.taskId))).at(0);
        if (!task) return c.json({ error: "task not found" }, 404);
        if (task.projectId !== existing.projectId) return c.json({ error: "task belongs to another project" }, 400);
        await db.insert(noteTasks).values({ noteId, taskId: task.id, createdAt: Date.now() }).onConflictDoNothing();
      } else {
        await db.delete(noteTasks).where(eq(noteTasks.noteId, noteId));
      }
      linksChanged = true;
    }
    if (Object.keys(patch).length || linksChanged) {
      patch.updatedAt = Date.now();
      await db.update(notes).set(patch).where(eq(notes.id, noteId));
    }
    const updated = (await db.select().from(notes).where(eq(notes.id, noteId))).at(0)!;
    return c.json((await withTaskLinks([updated]))[0]);
  });

  api.delete("/notes/:id", async (c) => {
    const noteId = c.req.param("id");
    const existing = (await db.select().from(notes).where(eq(notes.id, noteId))).at(0);
    if (!(await canUseOwned(existing, actorOf(c)))) return c.json({ error: "not found" }, 404);
    await db.delete(noteTasks).where(eq(noteTasks.noteId, noteId));
    await db.delete(notes).where(eq(notes.id, noteId));
    return c.json({ deleted: true });
  });
}
