// Global search (⌘K): one query across tasks (title/body) and their session
// transcripts on disk (data/runs/<taskId>/*.md|jsonl — run artifacts like
// output directory names only ever appear here). Corpus is small (hundreds of
// files, ~10MB), so每次全量扫,不建索引.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchHit, SearchField, TaskStatus } from "@harness/shared";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { notes, noteTasks, projects, tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";

const FIELD_RANK: Record<SearchField, number> = { title: 0, body: 1, conversation: 2 };
const SNIPPET_RADIUS = 60;
const MAX_HITS = 50;
const TASK_PREVIEW_LIMIT = 2_000;
const NOTE_PREVIEW_LIMIT = 4_000;

export type SearchTerm = {
  value: string;
  exact: boolean;
};

export type ParsedSearchQuery = {
  // Each inner array is AND; the outer array is OR.
  groups: SearchTerm[][];
  // Exclusions apply to every OR group.
  excluded: SearchTerm[];
};

export type SearchOptions = {
  projectId?: string;
  type?: "tasks" | "notes";
};

type Token =
  | { type: "or" }
  | { type: "term"; term: SearchTerm; excluded: boolean };

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let value = "";
  let quoted = false;
  let exact = false;
  let excluded = false;
  let started = false;

  const flush = () => {
    const normalized = value.trim().toLowerCase();
    if (normalized) tokens.push({ type: "term", term: { value: normalized, exact }, excluded });
    value = "";
    exact = false;
    excluded = false;
    started = false;
  };

  for (let i = 0; i < query.length; i += 1) {
    const char = query[i];
    if (quoted) {
      if (char === '"') quoted = false;
      else value += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      exact = true;
      started = true;
      continue;
    }
    if (char === "|") {
      flush();
      tokens.push({ type: "or" });
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    // A minus is syntax only at the beginning of a whitespace-delimited token.
    // This preserves literals such as `claude-3` while supporting `foo -bar`.
    if (!started && char === "-" && (i === 0 || /\s/.test(query[i - 1]))) {
      excluded = true;
      started = true;
      continue;
    }
    value += char;
    started = true;
  }
  flush();
  return tokens;
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const groups: SearchTerm[][] = [];
  const excluded: SearchTerm[] = [];
  let current: SearchTerm[] = [];

  for (const token of tokenize(query)) {
    if (token.type === "or") {
      if (current.length) groups.push(current);
      current = [];
    } else if (token.excluded) {
      excluded.push(token.term);
    } else {
      current.push(token.term);
    }
  }
  if (current.length) groups.push(current);
  return { groups, excluded };
}

export function matchesSearchQuery(text: string, query: ParsedSearchQuery): boolean {
  const lower = text.toLowerCase();
  if (query.excluded.some((term) => lower.includes(term.value))) return false;
  if (!query.groups.length) return query.excluded.length > 0;
  return query.groups.some((group) => group.every((term) => lower.includes(term.value)));
}

function matchingTerms(text: string, query: ParsedSearchQuery): SearchTerm[] {
  const lower = text.toLowerCase();
  const matches = query.groups
    .filter((group) => group.every((term) => lower.includes(term.value)))
    .flat();
  return matches.filter((term, index) => matches.findIndex((candidate) => candidate.value === term.value) === index);
}

// Context slice around the earliest positive match, collapsed to one line.
function findSnippet(text: string, terms: SearchTerm[]): string | null {
  const lower = text.toLowerCase();
  let index = -1;
  let length = 0;
  for (const term of terms) {
    const candidate = lower.indexOf(term.value);
    if (candidate >= 0 && (index < 0 || candidate < index)) {
      index = candidate;
      length = term.value.length;
    }
  }
  if (index < 0) return null;
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

// Read a task's searchable run files as one logical conversation corpus.
async function readRunText(taskId: string): Promise<string> {
  let files: string[];
  try {
    files = await readdir(join(RUNS_DIR, taskId));
  } catch {
    return "";
  }
  const chunks = await Promise.all(
    files
      .filter((file) => file.endsWith(".md") || file.endsWith(".jsonl"))
      .map(async (file) => {
        try {
          return await readFile(join(RUNS_DIR, taskId, file), "utf8");
        } catch {
          return ""; // file vanished mid-scan
        }
      }),
  );
  return chunks.filter(Boolean).join("\n");
}

export async function searchAll(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const parsed = parseSearchQuery(query);
  if (!parsed.groups.length && !parsed.excluded.length) return [];

  const [projRows, allTaskRows, allNoteRows, allNoteTaskRows] = await Promise.all([
    db.select().from(projects),
    db.select().from(tasks),
    db.select().from(notes),
    db.select({ noteId: noteTasks.noteId }).from(noteTasks).innerJoin(tasks, eq(noteTasks.taskId, tasks.id)),
  ]);
  const projectMatches = (projectId: string) => !options.projectId || projectId === options.projectId;
  const taskRows = options.type === "notes" ? [] : allTaskRows.filter((task) => projectMatches(task.projectId));
  const noteRows = options.type === "tasks" ? [] : allNoteRows.filter((note) => projectMatches(note.projectId));
  const projName = new Map(projRows.map((project) => [project.id, project.name] as const));
  const noteTaskCounts = new Map<string, number>();
  for (const link of allNoteTaskRows) noteTaskCounts.set(link.noteId, (noteTaskCounts.get(link.noteId) ?? 0) + 1);
  const taskHits: Extract<SearchHit, { kind: "task" }>[] = [];

  await Promise.all(
    taskRows.map(async (task) => {
      const conversation = await readRunText(task.id);
      const corpus = `${task.title}\n${task.body}\n${conversation}`;
      if (!matchesSearchQuery(corpus, parsed)) return;

      const terms = matchingTerms(corpus, parsed);
      let field: SearchField = "title";
      let snippet = "";
      const bodyTerms = terms.filter((term) => task.body.toLowerCase().includes(term.value));
      const conversationTerms = terms.filter((term) => conversation.toLowerCase().includes(term.value));
      if (!terms.some((term) => task.title.toLowerCase().includes(term.value))) {
        if (bodyTerms.length) {
          field = "body";
          snippet = findSnippet(task.body, bodyTerms) ?? "";
        } else if (conversationTerms.length) {
          field = "conversation";
          snippet = findSnippet(conversation, conversationTerms) ?? "";
        }
      }
      taskHits.push({
        kind: "task",
        id: task.id,
        title: task.title,
        status: task.status as TaskStatus,
        projectId: task.projectId,
        projectName: projName.get(task.projectId) ?? null,
        archived: task.archived,
        field,
        snippet,
        preview: task.body.slice(0, TASK_PREVIEW_LIMIT),
        updatedAt: task.updatedAt,
      });
    }),
  );

  taskHits.sort(
    (a, b) => FIELD_RANK[a.field] - FIELD_RANK[b.field] || b.updatedAt.localeCompare(a.updatedAt),
  );
  const noteHits: Extract<SearchHit, { kind: "note" }>[] = noteRows
    .filter((note) => matchesSearchQuery(note.body, parsed))
    .map<Extract<SearchHit, { kind: "note" }>>((note) => ({
      kind: "note",
      id: note.id,
      title: note.body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 40) || "无标题随手记",
      projectId: note.projectId,
      projectName: projName.get(note.projectId) ?? null,
      field: "body",
      snippet: findSnippet(note.body, matchingTerms(note.body, parsed)) ?? "",
      preview: note.body.slice(0, NOTE_PREVIEW_LIMIT),
      updatedAt: new Date(note.updatedAt).toISOString(),
      taskCount: noteTaskCounts.get(note.id) ?? 0,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // Product order is stable and intentional: task results first, quick notes after.
  return [...taskHits, ...noteHits].slice(0, MAX_HITS);
}
