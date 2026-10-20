// 「同一类型至多一个默认执行器」里的 **类型** 这一维。
//
// 现场:界面上 claude 那一栏明明有 4 个 profile,默认却显示「内置本地执行器」—— 上一次
// 操作是去 codex 那一栏点了设为默认。清标记那条兜底 UPDATE 只按归属收窄、漏了类型,
// 于是自用模式(归属全是 null)下设任何一个默认,会把**所有类型**的默认一起抹掉。
// 看上去像「不同智能体之间有竞态」,实际是一条确定性的越界清除。
//
// 这里钉三件事:
//   ① 设 A 类型的默认,不碰 B 类型的默认(越界清除的回归);
//   ② 同类型内仍然互斥(别为了修①把本职丢了);
//   ③ 多人模式下按人收窄仍然成立,且同样不越类型。
//
// 跑法:
//   ASH_DB=/tmp/test-executor-default-scope-$RANDOM.db npx tsx server/scripts/test-executor-default-scope.ts
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-executor-default-scope-"));
process.env.ASH_DB ||= join(stage, "default-scope.db");
requireTmpDb("test-executor-default-scope");

const { db, ensureSchema } = await import("../src/db/index.js");
const { agents } = await import("../src/db/schema.js");
const { api } = await import("../src/routes.js");
const { clearDefaultFor } = await import("../src/auth/dispatch-gate.js");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");

await ensureSchema();
await db.delete(agents);

const createProfile = async (name: string, type: string, isDefault: boolean): Promise<string> => {
  const res = await api.request("/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, isDefault }),
  });
  assert.equal(res.status, 201, `建 ${name} 应成功: ${await res.clone().text()}`);
  return (await res.json() as { id: string }).id;
};

const defaultsByType = async (): Promise<Record<string, string[]>> => {
  const rows = await db.select().from(agents);
  const out: Record<string, string[]> = {};
  for (const row of rows.filter((r) => r.isDefault)) (out[row.type] ??= []).push(row.name);
  for (const names of Object.values(out)) names.sort();
  return out;
};

// ── ① 跨类型:设 codex 的默认不该动 claude 的 ────────────────────────────
const claudeA = await createProfile("claude@a", "claude", true);
await createProfile("codex@x", "codex", true);
assert.deepEqual(
  await defaultsByType(),
  { claude: ["claude@a"], codex: ["codex@x"] },
  "建 codex 默认把 claude 的默认抹掉了(清标记漏了类型过滤)",
);

// ── ② 同类型内仍然互斥 ──────────────────────────────────────────────────
const claudeB = await createProfile("claude@b", "claude", true);
assert.deepEqual(
  await defaultsByType(),
  { claude: ["claude@b"], codex: ["codex@x"] },
  "同类型内应只剩一个默认,且 codex 不受影响",
);

// PATCH 这条路同样两件事都要成立。
const patched = await api.request(`/agents/${claudeA}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ isDefault: true }),
});
assert.equal(patched.status, 200, "改默认应成功");
assert.deepEqual(
  await defaultsByType(),
  { claude: ["claude@a"], codex: ["codex@x"] },
  "PATCH 设默认同样不该越过类型",
);
assert.ok(claudeB, "claude@b 建过");

// ── ③ 设默认撞上删除:要么都成,要么库里一个字没动 ───────────────────────
// 开头那句「这个 profile 还在」是在批外读的,删除可以恰好落在它和这一批之间;而 SQLite
// 对不存在的行做 UPDATE 是零行成功,不报错也不回滚 —— 没有「目标还在」这个条件的话,
// 清旧默认照常提交、设新默认一行没中,净效果是**设置失败却把另一个仍在的默认抹掉了**
// (第 1 轮审查 20/20 复现,报的是 500)。
await db.delete(agents);
const keeper = await createProfile("claude@keeper", "claude", true);
const doomed = await createProfile("claude@doomed", "claude", false);
for (let round = 0; round < 20; round++) {
  const [patchRes, deleteRes] = await Promise.all([
    api.request(`/agents/${doomed}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isDefault: true }),
    }),
    api.request(`/agents/${doomed}`, { method: "DELETE" }),
  ]);
  assert.equal(deleteRes.status, 200, "删除那边应照常成功");
  assert.ok([200, 404].includes(patchRes.status), `设默认撞上删除不该 500: ${patchRes.status}`);
  const keeperRow = (await db.select().from(agents).where(eq(agents.id, keeper))).at(0);
  if (patchRes.status !== 200) {
    assert.equal(keeperRow?.isDefault, true, "设默认没成,就不许动另一个仍在的默认");
  }
  // 下一轮重新摆好现场(doomed 已被删,keeper 的默认可能被合法地让了出去)。
  await db.update(agents).set({ isDefault: true }).where(eq(agents.id, keeper));
  await db.insert(agents).values({
    id: doomed, name: "claude@doomed", type: "claude", extraArgs: "[]", configOverrides: "{}", isDefault: false,
  });
}
await db.delete(agents);

// ── ④ 多人模式:按人收窄,且仍不越类型 ───────────────────────────────────
const root = join(stage, "root");
mkdirSync(join(root, "alice"), { recursive: true });
mkdirSync(join(root, "bob"), { recursive: true });
await mode.setInstanceMode("multi", root);
const alice = await store.createUser({
  name: "alice", role: "member", dirName: "alice", gitName: "Alice", gitEmail: "a@x", createdBy: null,
});
const bob = await store.createUser({
  name: "bob", role: "member", dirName: "bob", gitName: "Bob", gitEmail: "b@x", createdBy: null,
});

await db.delete(agents);
const seed = (id: string, name: string, type: string, ownerUserId: string | null) => ({
  id, name, type, ownerUserId, extraArgs: "[]", configOverrides: "{}", isDefault: true,
});
await db.insert(agents).values([
  seed("a-claude", "claude@alice", "claude", alice.id),
  seed("a-codex", "codex@alice", "codex", alice.id),
  seed("b-claude", "claude@bob", "claude", bob.id),
  seed("legacy-claude", "claude@legacy", "claude", null),
]);

await clearDefaultFor("claude", alice.id);
const after = Object.fromEntries((await db.select().from(agents)).map((r) => [r.id, r.isDefault]));
assert.equal(after["a-claude"], false, "本人同类型的默认应被清掉");
assert.equal(after["a-codex"], true, "本人**别的类型**的默认不该被清掉");
assert.equal(after["b-claude"], true, "别人的默认不该被清掉");
assert.equal(after["legacy-claude"], true, "归属为 null 的存量行不属于 alice,不该被清掉");

await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
console.log("✓ 设默认只在「同类型 + 同归属」这一格内清标记,不越类型、不越人");
