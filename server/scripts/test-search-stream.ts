import assert from "node:assert/strict";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { readRunCorpus, SearchCorpus } from "../src/search-corpus.js";
import { SearchLogText } from "../src/search-log-text.js";

const root = mkdtempSync(join(tmpdir(), "ash-search-stream-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const expectedSnippet = (text: string, terms: string[]) => {
  const lower = text.toLowerCase();
  let position = -1;
  let length = 0;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (position < 0 || index < position)) {
      position = index;
      length = term.length;
    }
  }
  if (position < 0) return "";
  const start = Math.max(0, position - 60);
  const end = Math.min(text.length, position + length + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
};

try {
  const text = `开头🧪${"中文 ".repeat(80)}BoundaryNEEDLE ${"右侧 ".repeat(80)}最后的 needle`;
  const terms = ["boundaryneedle", "needle", "中文", "最后的 needle", "不存在"];
  for (const width of [1, 2, 7, 59, 64, 127, 1024]) {
    const corpus = new SearchCorpus(terms);
    for (let offset = 0; offset < text.length; offset += width) corpus.append(text.slice(offset, offset + width));
    for (const term of terms) {
      assert.equal(corpus.includes(term), text.toLowerCase().includes(term), `${width}: ${term}`);
      assert.equal(corpus.snippet([term]), expectedSnippet(text, [term]), `${width}: snippet ${term}`);
    }
    assert.equal(corpus.snippet(terms), expectedSnippet(text, terms));
    assert.equal(corpus.snippet([...terms].reverse()), expectedSnippet(text, [...terms].reverse()));
  }

  const escaped = '{"type":"tool_result","tool_use_id":"hidden-metadata","content":"\\u4f60\\u597d\\nquoted \\"text\\" C:\\\\work \\ud83e\\uddea"}\n';
  const trace = JSON.stringify({ event: { kind: "text", text: "会话正文" }, session_id: "hidden-session" });
  const agent = JSON.stringify({ message: { content: [{ type: "text", text: "agent 正文" }] } });
  const codex = JSON.stringify({ item: { type: "command_execution", command: ["npm", "run build"], aggregated_output: "构建输出" } });
  for (const width of [1, 2, 7, 64, 1024]) {
    let decoded = "";
    const decoder = new SearchLogText((value) => { decoded += value; });
    const input = `${escaped}${trace}\n${agent}\n${codex}\nplain fallback\n`;
    for (let offset = 0; offset < input.length; offset += width) decoder.append(input.slice(offset, offset + width));
    assert.ok(decoded.includes('你好\nquoted "text" C:\\work 🧪'), `${width}: decode escapes across chunks`);
    for (const value of ["会话正文", "agent 正文", "npm", "run build", "构建输出", "plain fallback"]) assert.ok(decoded.includes(value));
    for (const value of ["hidden-metadata", "hidden-session", "tool_use_id", "command_execution"]) assert.ok(!decoded.includes(value));
  }

  const runs = join(root, "runs");
  const largeDirectory = join(runs, "stream000001");
  mkdirSync(largeDirectory, { recursive: true });
  const largePath = join(largeDirectory, "00.jsonl");
  const boundary = Buffer.from("跨块关键词🧪MIXEDcase");
  writeFileSync(largePath, '{"type":"tool_result","tool_use_id":"hidden-large-metadata","content":"');
  appendFileSync(largePath, Buffer.alloc(64 * 1024 - statSync(largePath).size - 2, 120));
  appendFileSync(largePath, boundary);
  const megabyte = Buffer.alloc(1024 * 1024, 120);
  for (let count = 0; count < 256; count += 1) appendFileSync(largePath, megabyte);
  appendFileSync(largePath, '尾部 STREAM_END"}\nfirst-file-end');
  writeFileSync(join(largeDirectory, "01.md"), "second-file-start\nFORBIDDEN");
  writeFileSync(join(largeDirectory, "02.md"), "");
  writeFileSync(join(largeDirectory, "ignored.txt"), "ignored-only");
  mkdirSync(join(largeDirectory, "vanished.md"));
  const heapLimit = getHeapStatistics().heap_size_limit;
  assert.ok(statSync(largePath).size > heapLimit, "fixture must exceed the configured JS heap");

  const scanTerms = ["跨块关键词🧪mixedcase", "stream_end", "first-file-end\nsecond-file-start", "forbidden", "ignored-only"];
  const scanned = await readRunCorpus(largeDirectory, scanTerms, "title\nbody\n");
  for (const term of scanTerms.slice(0, -1)) assert.ok(scanned.corpus.includes(term), term);
  assert.equal(scanned.corpus.includes("ignored-only"), false);
  assert.ok(scanned.conversation.snippet([scanTerms[0]!]).includes("跨块关键词🧪MIXEDcase"));
  assert.ok(!scanned.conversation.snippet([scanTerms[0]!]).includes("tool_use_id"));
  assert.ok(scanned.conversation.snippet(["stream_end"]).includes("STREAM_END"));
  assert.ok(scanned.conversation.snippet(scanTerms).length < 200);

  const before = new AbortController();
  before.abort();
  assert.equal((await readRunCorpus(largeDirectory, scanTerms, "", before.signal)).corpus.includes("stream_end"), false);
  const during = new AbortController();
  const cancelled = readRunCorpus(largeDirectory, scanTerms, "", during.signal);
  const abortTimer = setTimeout(() => during.abort(), 10);
  try {
    assert.equal((await cancelled).corpus.includes("stream_end"), false);
  } finally {
    clearTimeout(abortTimer);
  }
  assert.equal((await readRunCorpus(join(root, "missing"), ["body"], "body")).corpus.includes("body"), true);

  const [{ db, ensureSchema }, { projects, tasks }, { searchAll }, { SINGLE_ACTOR }] = await Promise.all([
    import("../src/db/index.js"), import("../src/db/schema.js"), import("../src/search.js"), import("../src/auth/context.js"),
  ]);
  await ensureSchema();
  const createdAt = "2026-11-07T00:00:00.000Z";
  await db.insert(projects).values({ id: "stream-project", name: "stream search", repoPath: root, createdAt });
  const identifiers = Array.from({ length: 6 }, (_, index) => `stream00000${index + 1}`);
  for (const [index, identifier] of identifiers.entries()) {
    if (index > 0) {
      const directory = join(runs, identifier);
      mkdirSync(directory);
      linkSync(largePath, join(directory, "00.jsonl"));
      writeFileSync(join(directory, "01.md"), "FORBIDDEN");
    }
    await db.insert(tasks).values({
      id: identifier, projectId: "stream-project", title: "Alpha 标题", body: "Beta 正文", status: "done",
      createdAt, updatedAt: new Date(Date.parse(createdAt) + index * 1000).toISOString(),
    });
  }
  const query = (value: string, options?: Parameters<typeof searchAll>[2]) => searchAll(value, SINGLE_ACTOR, options);
  const conversation = await query('"跨块关键词🧪mixedcase" stream_end');
  assert.equal(conversation.length, 6);
  assert.ok(conversation.every((hit) => hit.field === "conversation" && hit.snippet.includes("跨块关键词")));
  for (const identifier of identifiers) {
    const path = join(runs, identifier, "00.jsonl");
    unlinkSync(path);
    writeFileSync(path, "跨块关键词🧪MIXEDcase 尾部 STREAM_END");
  }
  assert.equal((await query("alpha stream_end"))[0]?.field, "title");
  assert.equal((await query("beta stream_end"))[0]?.field, "body");
  assert.equal((await query("stream000001 stream_end"))[0]?.field, "id");
  assert.equal((await query("alpha -forbidden")).length, 0);
  assert.equal((await query("-forbidden")).length, 0);
  assert.equal((await query("nonexistent | stream_end", { sort: "recent" }))[0]?.id, identifiers[5]);
  const emitted: string[] = [];
  const stopped = new AbortController();
  await query("stream_end", { signal: stopped.signal, onHit: (hit) => { emitted.push(hit.id); stopped.abort(); } });
  assert.equal(emitted.length, 1);
  console.log(`search stream passed: 256 MiB single-line logs, six concurrent tasks, heap limit ${Math.round(heapLimit / 1024 / 1024)} MiB`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
