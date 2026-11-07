import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSearchQueryReady, searchMatchQuality } from "@ash/shared/search";
import { SearchCorpus } from "../src/search-corpus.js";

const root = mkdtempSync(join(tmpdir(), "ash-search-experience-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const [{ db, ensureSchema }, { projects, tasks, notes }, { searchAll }, { SINGLE_ACTOR }] = await Promise.all([
  import("../src/db/index.js"), import("../src/db/schema.js"), import("../src/search.js"), import("../src/auth/context.js"),
]);
const query = (value: string, options?: Parameters<typeof searchAll>[2]) => searchAll(value, SINGLE_ACTOR, options);
const iso = (second: number) => new Date(Date.parse("2026-11-07T00:00:00Z") + second * 1000).toISOString();
const row = (id: string, title: string, body = "", projectId = "local", second = 0) => ({
  id, title, body, projectId, status: "done", createdAt: iso(0), updatedAt: iso(second),
});

try {
  await ensureSchema();
  await db.insert(projects).values(["local", "remote"].map((id) => ({ id, name: id, repoPath: root, createdAt: iso(0) })));
  await db.insert(tasks).values([
    ...Array.from({ length: 60 }, (_, index) => row(`nearby${String(index).padStart(6, "0")}`, `提到 lookuptarget 的记录 ${index}`, "", "local", index + 10)),
    row("lookuptarget", "真正要找的任务", "", "remote"),
    row("exact-title", "链接修复", "", "local", 1),
    row("loose-title", "讨论链接修复方案", "", "local", 900),
    row("deep-body", "旧文件排查", `${"无关开头".repeat(800)}深处标记${"间隔".repeat(500)}尾部路径/src.ts`),
    row("image-task", "图片整理"),
    row("cross-fields", "跨字段标记", "正文另一词"),
    row("conversation", "历史对话"),
  ]);
  const directory = join(root, "runs", "conversation");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "session.md"), `会话第一词${"背景".repeat(800)}会话第二词`);
  await db.insert(notes).values({
    id: "deep-note", projectId: "local", body: `${"开始".repeat(2500)}笔记深处标记`, createdAt: Date.parse(iso(0)), updatedAt: Date.parse(iso(1)),
  });

  const identity = await query("lookuptarget", { preferProjectId: "local" });
  assert.equal(identity.length, 50);
  assert.equal(identity[0]?.id, "lookuptarget", "an exact id in another project must survive the local 50-hit cutoff");
  assert.equal(new Set(identity.map((hit) => `${hit.kind}:${hit.id}`)).size, identity.length);
  assert.ok(!(await query("lookuptarget", { projectId: "local" })).some((hit) => hit.id === "lookuptarget"));
  const streamed: string[] = [];
  await query("lookuptarget", { onHit: (hit) => streamed.push(hit.id) });
  assert.equal(streamed.filter((id) => id === "lookuptarget").length, 1);
  assert.deepEqual((await query("链接修复")).map((hit) => hit.id), ["exact-title", "loose-title"]);
  assert.deepEqual((await query("链接修复", { sort: "recent" })).map((hit) => hit.id), ["loose-title", "exact-title"]);

  const deep = (await query("深处标记 尾部路径"))[0];
  assert.equal(deep?.id, "deep-body");
  assert.ok(deep?.excerpts?.some((text) => text.includes("深处标记")));
  assert.ok(deep?.excerpts?.some((text) => text.includes("尾部路径/src.ts")));
  assert.ok(deep?.excerpts?.every((text) => text.length < 400));
  const conversation = (await query("会话第一词 会话第二词"))[0];
  assert.equal(conversation?.field, "conversation");
  assert.equal(conversation?.excerpts?.length, 2);
  assert.ok(conversation?.excerpts?.some((text) => text.includes("会话第二词")));
  const note = (await query("笔记深处标记", { type: "notes" }))[0];
  assert.ok(note?.excerpts?.[0]?.includes("笔记深处标记"));
  assert.equal((await query("跨字段标记 正文另一词"))[0]?.id, "cross-fields");
  assert.equal((await query("会话第一词 -会话第二词")).length, 0);
  assert.equal((await query("图"))[0]?.id, "image-task");
  assert.equal(isSearchQueryReady("图"), true);
  assert.equal(isSearchQueryReady(" a "), false);
  assert.equal(isSearchQueryReady(" "), false);
  assert.ok(searchMatchQuality("alpha beta", [["alpha", "beta"]]) > searchMatchQuality("beta alpha extra", [["alpha", "beta"]]));
  const corpus = new SearchCorpus(["alpha", "omega"], "", 180);
  for (const chunk of ["alpha", "x".repeat(3000), "omega"]) corpus.append(chunk);
  assert.equal(corpus.snippets(["alpha", "omega"]).length, 2);
  console.log("search experience passed: cross-project exact id, cutoff, ranking, deep/multiple excerpts, notes, Han queries, exclusions");
} finally {
  rmSync(root, { recursive: true, force: true });
}
