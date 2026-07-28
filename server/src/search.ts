// Global search (⌘K): one query across tasks (title/body) and their session
// transcripts on disk (data/runs/<taskId>/*.md|jsonl — run artifacts like
// output directory names only ever appear here). Corpus is small (hundreds of
// files, ~10MB), so每次
// 全量扫,不建索引;matching is case-insensitive substring.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchHit, SearchField, TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { notes, projects, tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";

const FIELD_RANK: Record<SearchField, number> = { title: 0, body: 1, conversation: 2 };
const SNIPPET_RADIUS = 60;
const MAX_HITS = 50;
const TASK_PREVIEW_LIMIT = 2_000;
const NOTE_PREVIEW_LIMIT = 4_000;

// Context slice around the first occurrence of `needle` (already lowercased),
// collapsed to one line. Null when not found.
function findSnippet(text: string, needle: string): string | null {
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return null;
  const start = Math.max(0, i - SNIPPET_RADIUS);
  const end = Math.min(text.length, i + needle.length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

// Scan a task's run directory for the query. Returns the first matching
// snippet, or null (including when the task has no runs yet).
async function scanRunFiles(taskId: string, needle: string): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(join(RUNS_DIR, taskId));
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith(".md") && !f.endsWith(".jsonl")) continue;
    try {
      const text = await readFile(join(RUNS_DIR, taskId, f), "utf8");
      const s = findSnippet(text, needle);
      if (s != null) return s;
    } catch {
      /* file vanished mid-scan */
    }
  }
  return null;
}

export async function searchAll(query: string): Promise<SearchHit[]> {
  const q = query.toLowerCase();
  const [projRows, taskRows, noteRows] = await Promise.all([
    db.select().from(projects),
    db.select().from(tasks),
    db.select().from(notes),
  ]);
  const projName = new Map(projRows.map((p) => [p.id, p.name] as const));
  const taskHits: Extract<SearchHit, { kind: "task" }>[] = [];

  await Promise.all(
    taskRows.map(async (t) => {
      let field: SearchField | null = null;
      let snippet = "";
      if (t.title.toLowerCase().includes(q)) {
        field = "title";
      } else if (t.body.toLowerCase().includes(q)) {
        field = "body";
        snippet = findSnippet(t.body, q) ?? "";
      } else {
        const s = await scanRunFiles(t.id, q);
        if (s != null) {
          field = "conversation";
          snippet = s;
        }
      }
      if (!field) return;
      taskHits.push({
        kind: "task",
        id: t.id,
        title: t.title,
        status: t.status as TaskStatus,
        projectId: t.projectId,
        projectName: projName.get(t.projectId) ?? null,
        archived: t.archived,
        field,
        snippet,
        preview: t.body.slice(0, TASK_PREVIEW_LIMIT),
        updatedAt: t.updatedAt,
      });
    }),
  );

  taskHits.sort(
    (a, b) => FIELD_RANK[a.field] - FIELD_RANK[b.field] || b.updatedAt.localeCompare(a.updatedAt),
  );
  const noteHits: Extract<SearchHit, { kind: "note" }>[] = noteRows
    .filter((note) => note.body.toLowerCase().includes(q))
    .map<Extract<SearchHit, { kind: "note" }>>((note) => ({
      kind: "note",
      id: note.id,
      title: note.body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 40) || "无标题随手记",
      projectId: note.projectId,
      projectName: projName.get(note.projectId) ?? null,
      field: "body",
      snippet: findSnippet(note.body, q) ?? "",
      preview: note.body.slice(0, NOTE_PREVIEW_LIMIT),
      updatedAt: new Date(note.updatedAt).toISOString(),
      taskId: note.taskId,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // Product order is stable and intentional: task results first, quick notes after.
  return [...taskHits, ...noteHits].slice(0, MAX_HITS);
}
