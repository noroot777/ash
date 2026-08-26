// Global search (⌘K): one query across tasks (title/body) and their session
// transcripts on disk (data/runs/<taskId>/*.md|jsonl — run artifacts like
// output directory names only ever appear here).
//
// **语料早就不小了**：2026-08-26 实测 1269 个任务目录 / 4500 个文件 / 2.2 GB，其中
// .jsonl（事件轨迹）占 1.33 GB，单个任务目录最大 586 MB。这个文件原本写着「corpus is
// small (~10MB), 每次全量扫」并用 `Promise.all` 把 1123 个任务的全文一次性读进内存 ——
// 于是 ⌘K 里每敲几个字就把 1.3 GB 读成 JS 字符串、再 toLowerCase 好几遍。实测一次
// `?q=harness` 要 20 秒，**而且把整个事件循环占死**：同一时刻本该 33 ms 的
// `/projects/:id/health` 被拖到 9.2 s，用户看到的是「切完项目打开任务要等十几秒」。
//
// 所以扫描按三条规矩来：
//   1. **先用库里的字段判**（id / 标题 / 正文），一个文件都不读。命中够了就根本不下盘。
//   2. 真要下盘时**有界并发 + 每批让出事件循环**，并按最终排序的顺序扫、够 MAX_HITS
//      就停 —— 结果集与全量扫一字不差（见 scanGroup 那段的推导），只是不再把
//      整个进程钉在 I/O 和 GC 上。
//   3. **先扫当前项目，再扫别的项目**，命中一条吐一条（`onHit`）。⌘K 多半在找手头这个
//      项目的东西，而 compareSearchHits 里「当前项目在前」这把钥匙排在字段之前 ——
//      于是本项目的命中铁定全部排在别的项目之前，分两段扫既不会中途重排，本项目自己
//      就收满 50 条时别的项目还能整个跳过。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchHit, SearchField, TaskStatus } from "@ash/shared";
import { SEARCH_MAX_HITS, compareSearchHits } from "@ash/shared/search";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { notes, noteTasks, projects, tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";

const SNIPPET_RADIUS = 60;
const MAX_HITS = SEARCH_MAX_HITS;
const TASK_PREVIEW_LIMIT = 2_000;
const NOTE_PREVIEW_LIMIT = 4_000;
// 同时读几个任务目录。这个数决定「一次最多有多少份会话全文同时待在内存里」——
// 原先是全部 1123 份，几个 GB 的字符串一起进老生代，GC 和 swap 都得跟着遭殃。
const SCAN_CONCURRENCY = 6;

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
  // 硬过滤：只在这个项目里搜（⌘K 的「限定项目」筛子）。
  projectId?: string;
  type?: "tasks" | "notes";
  // 排序偏好 + **扫描顺序**：先把这个项目扫完，再扫别的项目。跟 projectId 是两回事 ——
  // 后者把别的项目排除掉，这个只是让它们排后面、晚一点到。
  preferProjectId?: string | null;
  // 命中一条回调一条。给了就是流式（`GET /search/stream`）；不给就只在最后整份返回。
  // 回调里的顺序不是最终顺序（同一档里按 updatedAt 扫，档位是逐条算出来的），
  // 消费方得拿 compareSearchHits 插进去 —— 那正是它跟服务端共用同一份判据的原因。
  onHit?: (hit: SearchHit) => void;
  // 本项目那一段扫完了。界面拿它说「本项目已列完，正在搜其他项目…」，不然用户看到的是
  // 一个停在半路、不知道还有没有下文的列表。
  onLocalDone?: () => void;
  // 用户又敲了一个字 / 关掉了 ⌘K。搜索是全盘扫，不中断就会几十个查询叠在一起把
  // 事件循环占死 —— 那正是这轮要修的现象本身。
  signal?: AbortSignal;
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
  return matchesLowered(text.toLowerCase(), query);
}

// 下面三个 `*Lowered` 收的是**已经压过小写**的文本。语料上了 GB 之后，
// 「每个判据自己 toLowerCase 一遍」就是每次搜索多几份 GB 级垃圾。
function matchesLowered(lower: string, query: ParsedSearchQuery): boolean {
  if (hasExcluded(lower, query)) return false;
  if (!query.groups.length) return query.excluded.length > 0;
  return query.groups.some((group) => group.every((term) => lower.includes(term.value)));
}

function hasExcluded(lower: string, query: ParsedSearchQuery): boolean {
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
  return matchingTermsLowered(text.toLowerCase(), query);
}

function matchingTermsLowered(lower: string, query: ParsedSearchQuery): SearchTerm[] {
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
  const idCandidates = taskIdCandidates(parsed);

  type TaskRow = (typeof taskRows)[number];
  type TaskHit = Extract<SearchHit, { kind: "task" }>;
  const hitOf = (task: TaskRow, conversation: string): TaskHit | null => {
    const corpus = `${task.title}\n${task.body}\n${conversation}`;
    // 大字符串只压一次小写。原先 matchesSearchQuery / isExcluded / matchingTerms /
    // findSnippet 各压一遍，语料上了 GB 之后这四遍就是四份垃圾。
    const lower = corpus.toLowerCase();
    // 按 id 命中的那条要能凭空冒出来:任务自己的 id 不在自己的标题/正文里,
    // 还没跑过的任务连会话都没有,靠 corpus 匹配永远搜不到它自己。排除词
    // 仍然有效——用户显式说了别看这条,就别钉它。
    const byId = idCandidates.some((candidate) => isTaskIdMatch(task.id, candidate))
      && !hasExcluded(lower, parsed);
    if (!byId && !matchesLowered(lower, parsed)) return null;

    let field: SearchField = "id";
    let snippet = "";
    if (!byId) {
      const terms = matchingTermsLowered(lower, parsed);
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
    return {
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
    };
  };

  const prefer = options.preferProjectId || null;
  const hits: SearchHit[] = [];
  // 收进来就按最终顺序插好，**只有还能挤进前 MAX_HITS 的那些才往外吐**。
  // 集合只增不减，所以插进来时就排在 50 名开外的，以后只会更靠后 —— 吐了也是白吐。
  // （实测：`?q=harness` 有 301 条命中，全吐是 643 KB，只吐进得了前 50 的是 ~50 行。）
  const emit = (hit: SearchHit) => {
    const at = hits.findIndex((existing) => compareSearchHits(hit, existing, prefer) < 0);
    const index = at < 0 ? hits.length : at;
    hits.splice(index, 0, hit);
    if (index < MAX_HITS) options.onHit?.(hit);
  };

  // 随手记只在库里，判定不下盘、几乎不要钱 —— 先出，⌘K 就不会有「敲完字空着一片」的
  // 那一秒。排序上它们本来就在所有任务之后（compareSearchHits 第一把钥匙），先到后到
  // 不影响最终顺序。
  for (const note of noteRows) {
    if (!matchesSearchQuery(note.body, parsed)) continue;
    emit({
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
    });
  }

  // ── 谁必须下盘 ─────────────────────────────────────────────────────────
  //
  // 一个任务的命中能落在哪一档，光看库里的字段（标题 / 正文 / id）就能分成三类：
  //
  //   settled  某个 OR 分组的词**全都**在标题/正文里（或按 id 命中）→ 判定和档位都定了，
  //            不用读会话。带排除词时例外：排除词可能只出现在会话里，得读了才敢留。
  //   partial  某个分组只命中了一部分词 → 补上会话才可能成立，而且成立时档位可能是
  //            标题/正文（跨字段 AND）。这类必须全扫，不能因为「已经够 50 条」就跳过。
  //   none     标题/正文里一个词都没有 → 真命中的话所有词都在会话里，档位必然是
  //            conversation（SEARCH_FIELD_RANK 最末一档）。
  //
  // 于是：settled + partial 扫完之后，如果**能排在会话档之前的**命中已经够 MAX_HITS，
  // none 那一堆整个可以不读；否则按 updatedAt 倒序补，够数就停 —— 剩下没读的都比已收的
  // 更旧、且同为最末档，不可能挤进前 50。结果集与全量扫一字不差。
  const classify = (rows: TaskRow[]) => {
    const ordered = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const settled: TaskRow[] = [];
    const partial: TaskRow[] = [];
    const none: TaskRow[] = [];
    for (const task of ordered) {
      const lower = `${task.title}\n${task.body}`.toLowerCase();
      const byIdCandidate = idCandidates.some((candidate) => isTaskIdMatch(task.id, candidate));
      const groupsHere = parsed.groups.map((group) => group.filter((term) => lower.includes(term.value)).length / group.length);
      // 纯排除查询（只写了 `-foo`）没有正向词可分类：它命中的是「所有没被排除的任务」，
      // 档位算标题档，不是会话档，早停那套推导对它不成立 —— 整批当 partial 全扫。
      if (!parsed.groups.length) partial.push(task);
      else if (byIdCandidate || groupsHere.some((ratio) => ratio === 1)) settled.push(task);
      else if (groupsHere.some((ratio) => ratio > 0)) partial.push(task);
      else none.push(task);
    }
    return { settled, partial, none };
  };

  // 有界并发 + 每批之间让出事件循环：搜索是个「顺手敲几个字」的动作，不该让同时在飞的
  // 会话请求、健康检查跟着一起卡住（那正是这次要修的现象）。
  // `ahead` 给的是「已经收了多少条铁定排在会话档之前的命中」，给了就够数即停。
  const scan = async (rows: TaskRow[], sink: TaskHit[], ahead: number | null): Promise<void> => {
    let found = 0;
    for (let at = 0; at < rows.length; at += SCAN_CONCURRENCY) {
      if (options.signal?.aborted) return;
      const batch = rows.slice(at, at + SCAN_CONCURRENCY);
      const batchHits = await Promise.all(batch.map(async (task) => hitOf(task, await readRunText(task.id))));
      for (const hit of batchHits) if (hit) { sink.push(hit); emit(hit); found += 1; }
      if (ahead !== null && ahead + found >= MAX_HITS) return;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  };

  // 扫一批任务（一个项目组）。`ahead0` = 已经收下的、**铁定排在这一组任何命中之前**的
  // 条数：本项目那一组是 0，别的项目那一组是本项目的全部命中（「当前项目在前」这把钥匙
  // 排在字段之前，所以本项目连会话档命中都压得住别的项目的标题档）。
  const scanGroup = async (rows: TaskRow[], ahead0: number): Promise<TaskHit[]> => {
    const { settled, partial, none } = classify(rows);
    const sink: TaskHit[] = [];
    if (parsed.excluded.length) {
      // 排除词只在会话里出现也算数，所以 settled 这批同样得读一遍才敢留。
      await scan(settled, sink, null);
    } else {
      for (const task of settled) {
        const hit = hitOf(task, "");
        if (hit) { sink.push(hit); emit(hit); }
      }
    }
    await scan(partial, sink, null);
    // none 这批命中必然是会话档（标题/正文里一个词都没有），所以只有「铁定排在会话档
    // 之前的那些命中」才算数 —— settled/partial 里那些会话档命中不能拿来抵，它们可能比
    // 还没扫到的 none 更旧，本就该被挤下去。
    const ahead = ahead0 + sink.filter((hit) => hit.field !== "conversation").length;
    if (ahead < MAX_HITS) await scan(none, sink, ahead);
    return sink;
  };

  // ── 分两段扫：先本项目，再别的项目 ─────────────────────────────────────
  // 排序判据里「当前项目在前」排在字段之前，所以本项目的命中整体压过别的项目 ——
  // 分段扫不会中途重排，本项目自己就收满 MAX_HITS 时别的项目整个不用碰。
  const localRows = prefer ? taskRows.filter((task) => task.projectId === prefer) : taskRows;
  const otherRows = prefer ? taskRows.filter((task) => task.projectId !== prefer) : [];
  const localHits = await scanGroup(localRows, 0);
  options.onLocalDone?.();
  if (otherRows.length && localHits.length < MAX_HITS && !options.signal?.aborted) {
    await scanGroup(otherRows, localHits.length);
  }

  // `hits` 在 emit 里就按 compareSearchHits 插好了（排序判据只此一处：服务端拿它定扫描
  // 顺序、前端拿它插流式结果）。Product order is stable: task results first, quick notes after.
  return hits.slice(0, MAX_HITS);
}
