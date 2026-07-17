// Global search (⌘K): one query across tasks (title/body), their session
// transcripts on disk (data/runs/<taskId>/*.md|jsonl — run artifacts like
// output directory names only ever appear here), and issues (title/body/
// sourceText/comments). Corpus is small (hundreds of files, ~10MB), so每次
// 全量扫,不建索引;matching is case-insensitive substring.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchHit, SearchField } from "@harness/shared";
import { db } from "./db/index.js";
import { projects, tasks, issues, issueComments } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";

const FIELD_RANK: Record<SearchField, number> = { title: 0, body: 1, comment: 2, conversation: 3 };
const SNIPPET_RADIUS = 60;
const MAX_HITS = 50;

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
  const [projRows, taskRows, issueRows, commentRows] = await Promise.all([
    db.select().from(projects),
    db.select().from(tasks),
    db.select().from(issues),
    db.select().from(issueComments),
  ]);
  const projName = new Map(projRows.map((p) => [p.id, p.name] as const));
  const hits: SearchHit[] = [];

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
      hits.push({
        kind: "task",
        id: t.id,
        title: t.title,
        status: t.status as SearchHit["status"],
        projectId: t.projectId,
        projectName: projName.get(t.projectId) ?? null,
        archived: t.archived,
        field,
        snippet,
        updatedAt: t.updatedAt,
      });
    }),
  );

  const commentsByIssue = new Map<string, string[]>();
  for (const cm of commentRows) {
    const arr = commentsByIssue.get(cm.issueId) ?? [];
    arr.push(cm.body);
    commentsByIssue.set(cm.issueId, arr);
  }
  for (const i of issueRows) {
    let field: SearchField | null = null;
    let snippet = "";
    if (i.title.toLowerCase().includes(q)) {
      field = "title";
    } else {
      // body 初始等于 sourceText 但可被编辑;两边都搜才不漏原文。
      const bodyHit = findSnippet(i.body, q) ?? findSnippet(i.sourceText, q);
      if (bodyHit != null) {
        field = "body";
        snippet = bodyHit;
      } else {
        for (const body of commentsByIssue.get(i.id) ?? []) {
          const s = findSnippet(body, q);
          if (s != null) {
            field = "comment";
            snippet = s;
            break;
          }
        }
      }
    }
    if (!field) continue;
    hits.push({
      kind: "issue",
      id: i.id,
      title: i.title,
      status: i.status as SearchHit["status"],
      projectId: i.projectId,
      projectName: i.projectId ? (projName.get(i.projectId) ?? null) : null,
      archived: false,
      field,
      snippet,
      updatedAt: i.updatedAt,
    });
  }

  hits.sort(
    (a, b) => FIELD_RANK[a.field] - FIELD_RANK[b.field] || b.updatedAt.localeCompare(a.updatedAt),
  );
  return hits.slice(0, MAX_HITS);
}
