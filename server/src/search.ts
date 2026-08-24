// Global search (⌘K): one query across tasks (title/body) and their session
// transcripts on disk (data/runs/<taskId>/*.md|jsonl — run artifacts like
// output directory names only ever appear here). Corpus is small (hundreds of
// files, ~10MB), so每次全量扫,不建索引.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchHit, SearchField, TaskStatus } from "@ash/shared";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { notes, noteTasks, projects, tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";

const FIELD_RANK: Record<SearchField, number> = { id: 0, title: 1, body: 2, conversation: 3 };
const SNIPPET_RADIUS = 60;
const MAX_HITS = 50;
const TASK_PREVIEW_LIMIT = 2_000;
const NOTE_PREVIEW_LIMIT = 4_000;

// 任务 id 是 nanoid(12),字母表 [A-Za-z0-9_-];ash 分支只带前 8 位
// (`ash/<id8>`),所以 8 位以上的前缀同样算「就是这个任务」。
const TASK_ID_PATTERN = /^[a-z0-9_-]{8,12}$/;

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

export function visibleLocalSearchTask(handoff: string | null): boolean {
  if (!handoff) return true;
  try {
    const marker = JSON.parse(handoff) as { direction?: string; pending?: boolean };
    return marker.direction !== "out" || Boolean(marker.pending);
  } catch {
    return true;
  }
}

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
  if (isExcluded(text, query)) return false;
  if (!query.groups.length) return query.excluded.length > 0;
  const lower = text.toLowerCase();
  return query.groups.some((group) => group.every((term) => lower.includes(term.value)));
}

function isExcluded(text: string, query: ParsedSearchQuery): boolean {
  const lower = text.toLowerCase();
  return query.excluded.some((term) => lower.includes(term.value));
}

// 查询里长得像任务 id 的片段。只看正向词:`-<id>` 是「别给我看这个」,把它
// 钉到第一位正好相反。term.value 已经被 tokenize 小写化,匹配也按小写比,
// 8 位以上的前缀在两种大小写下撞车不是现实风险。
export function taskIdCandidates(query: ParsedSearchQuery): string[] {
  const candidates = new Set<string>();
  for (const term of query.groups.flat()) {
    // 按「id 里不可能出现的字符」切一刀,于是直接粘 `ash/<id8>`、
    // `/tasks/<id>` 这类 URL 或 `taskId=<id>` 也能把 id 本体露出来。
    for (const part of term.value.split(/[^a-z0-9_-]+/)) {
      if (TASK_ID_PATTERN.test(part)) candidates.add(part);
    }
  }
  return [...candidates];
}

// 整串 id 或 8 位以上的前缀都算「就是这个任务」。两边都压小写:候选来自
// tokenize 时已小写化的词,但导出的函数不该指望调用方记得这件事。
export function isTaskIdMatch(taskId: string, candidate: string): boolean {
  return taskId.toLowerCase().startsWith(candidate.toLowerCase());
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
  const taskRows = options.type === "notes" ? [] : allTaskRows.filter((task) => projectMatches(task.projectId) && visibleLocalSearchTask(task.handoff));
  const noteRows = options.type === "tasks" ? [] : allNoteRows.filter((note) => projectMatches(note.projectId));
  const projName = new Map(projRows.map((project) => [project.id, project.name] as const));
  const noteTaskCounts = new Map<string, number>();
  for (const link of allNoteTaskRows) noteTaskCounts.set(link.noteId, (noteTaskCounts.get(link.noteId) ?? 0) + 1);
  const taskHits: Extract<SearchHit, { kind: "task" }>[] = [];
  const idCandidates = taskIdCandidates(parsed);

  await Promise.all(
    taskRows.map(async (task) => {
      const conversation = await readRunText(task.id);
      const corpus = `${task.title}\n${task.body}\n${conversation}`;
      // 按 id 命中的那条要能凭空冒出来:任务自己的 id 不在自己的标题/正文里,
      // 还没跑过的任务连会话都没有,靠 corpus 匹配永远搜不到它自己。排除词
      // 仍然有效——用户显式说了别看这条,就别钉它。
      const byId = idCandidates.some((candidate) => isTaskIdMatch(task.id, candidate))
        && !isExcluded(corpus, parsed);
      if (!byId && !matchesSearchQuery(corpus, parsed)) return;

      let field: SearchField = "id";
      let snippet = "";
      if (!byId) {
        const terms = matchingTerms(corpus, parsed);
        const bodyTerms = terms.filter((term) => task.body.toLowerCase().includes(term.value));
        const conversationTerms = terms.filter((term) => conversation.toLowerCase().includes(term.value));
        field = "title";
        if (!terms.some((term) => task.title.toLowerCase().includes(term.value))) {
          if (bodyTerms.length) {
            field = "body";
            snippet = findSnippet(task.body, bodyTerms) ?? "";
          } else if (conversationTerms.length) {
            field = "conversation";
            snippet = findSnippet(conversation, conversationTerms) ?? "";
          }
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
        createdAt: task.createdAt,
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
      createdAt: new Date(note.createdAt).toISOString(),
      updatedAt: new Date(note.updatedAt).toISOString(),
      taskCount: noteTaskCounts.get(note.id) ?? 0,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // Product order is stable and intentional: task results first, quick notes after.
  return [...taskHits, ...noteHits].slice(0, MAX_HITS);
}
