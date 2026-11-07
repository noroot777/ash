import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SearchLogText } from "./search-log-text.js";

const SNIPPET_RADIUS = 60;
const READ_CHUNK_BYTES = 64 * 1024;

type Match = {
  position: number;
  start: number;
  end: number;
  text: string;
};

export class SearchCorpus {
  private readonly terms: string[];
  private readonly overlap: number;
  private readonly radius: number;
  private readonly matches = new Map<string, Match>();
  private tail = "";
  private length = 0;

  constructor(terms: string[], initial = "", radius = SNIPPET_RADIUS) {
    this.radius = radius;
    this.terms = [...new Set(terms)];
    this.overlap = Math.max(0, ...this.terms.map((term) => term.length)) + radius * 2 + 4;
    this.append(initial);
  }

  append(chunk: string): void {
    if (!chunk) return;
    const text = this.tail + chunk;
    const offset = this.length - this.tail.length;
    const lower = text.toLowerCase();
    this.length += chunk.length;
    for (const term of this.terms) {
      const previous = this.matches.get(term);
      if (previous && previous.end >= previous.position + term.length + this.radius) continue;
      const index = lower.indexOf(term);
      if (index < 0 || (previous && offset + index > previous.position)) continue;
      const start = Math.max(0, index - this.radius);
      const end = Math.min(text.length, index + term.length + this.radius);
      this.matches.set(term, {
        position: offset + index,
        start: offset + start,
        end: offset + end,
        text: text.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }
    this.tail = text.slice(-this.overlap);
  }

  includes(term: string): boolean {
    return this.matches.has(term);
  }

  snippet(terms: string[]): string {
    let earliest: Match | undefined;
    for (const term of terms) {
      const match = this.matches.get(term);
      if (match && (!earliest || match.position < earliest.position)) earliest = match;
    }
    if (!earliest) return "";
    return `${earliest.start > 0 ? "…" : ""}${earliest.text}${earliest.end < this.length ? "…" : ""}`;
  }

  snippets(terms: string[], limit = 3): string[] {
    const ordered = [...new Set(terms)].flatMap((term) => {
      const match = this.matches.get(term);
      return match ? [{ term, match }] : [];
    }).sort((left, right) => left.match.position - right.match.position);
    const selected: typeof ordered = [];
    for (const entry of ordered) {
      if (selected.some((previous) => entry.match.position + entry.term.length <= previous.match.end)) continue;
      selected.push(entry);
      if (selected.length >= limit) break;
    }
    return selected.map(({ term }) => this.snippet([term]));
  }
}

export type RunSearchCorpus = {
  corpus: SearchCorpus;
  conversation: Pick<SearchCorpus, "includes" | "snippet" | "snippets">;
};

export async function readRunCorpus(
  directory: string,
  terms: string[],
  prefix: string,
  signal?: AbortSignal,
  radius = SNIPPET_RADIUS,
): Promise<RunSearchCorpus> {
  const corpus = new SearchCorpus(terms, prefix, radius);
  const raw = new SearchCorpus(terms, "", radius);
  const markdown = new SearchCorpus(terms, "", radius);
  const logs = new SearchCorpus(terms, "", radius);
  const conversation = {
    includes: (term: string) => raw.includes(term),
    snippet: (values: string[]) => markdown.snippet(values) || logs.snippet(values),
    snippets: (values: string[], limit = 3) => [
      ...markdown.snippets(values, limit),
      ...logs.snippets(values.filter((term) => !markdown.includes(term)), limit),
    ].slice(0, limit),
  };
  const result = { corpus, conversation };
  if (signal?.aborted) return result;
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return result;
  }
  let hasConversation = false;
  for (const file of files) {
    if (signal?.aborted) break;
    if (!file.endsWith(".md") && !file.endsWith(".jsonl")) continue;
    const readable = file.endsWith(".md") ? markdown : logs;
    readable.append("\n");
    const decoder = file.endsWith(".jsonl") ? new SearchLogText((text) => logs.append(text)) : null;
    let started = false;
    try {
      const stream = createReadStream(join(directory, file), {
        encoding: "utf8", highWaterMark: READ_CHUNK_BYTES, signal,
      });
      for await (const chunk of stream) {
        if (signal?.aborted) break;
        const text = String(chunk);
        if (!text) continue;
        if (!started && hasConversation) {
          corpus.append("\n");
          raw.append("\n");
        }
        started = true;
        hasConversation = true;
        corpus.append(text);
        raw.append(text);
        if (decoder) decoder.append(text);
        else markdown.append(text);
      }
    } catch {
      if (signal?.aborted) break;
    }
  }
  return result;
}
