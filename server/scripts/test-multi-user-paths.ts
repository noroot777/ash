// 路径钳制的**判据层**回归(§七)。从 test-multi-user.ts 的 ③ 组搬出来单开一份:
// 那个文件是十几组横切判据的合集,而路径钳制自己已经长成一整块 —— 一份三态判据
// (`auth/path-scope.ts`)喂着六个入口(建项目 / 按路径找回 / 改路径 / 路径体检 /
// 建目录 / 目录浏览)。
//
// 钉的是三件事:
//   ① 不受钳制的是**自用模式和实例管理员**,一个不多(§七 刻意如此)。
//   ② 普通用户只能用自己目录**之内、且不是目录根**的路径;软链指出去也不行。
//   ③ **「算不出这个人的目录」必须落 deny,不能跟「不用钳」共用一个答案。**
//      二态时它们共用一个 null,于是权限最小的那种身份 —— `ownerUserId` 为空的存量
//      任务的回合凭证(`agentActor` 明确不给它管理员权限)—— 反而拿到了不受钳制的
//      路径能力(第 1 轮审查 P1)。HTTP 那一侧的复现在 test-multi-user-agent.ts ⑦。
//
// 跑法(不设 ASH_DB 时自己开一个临时库):
//   npm -w server run test:multi-user-paths
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-multi-user-paths-"));
process.env.ASH_DB ||= join(stage, "multi-user-paths.db");
requireTmpDb("test-multi-user-paths");

const { ensureSchema } = await import("../src/db/index.js");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const pathScope = await import("../src/auth/path-scope.js");
const { ANONYMOUS_ACTOR, SINGLE_ACTOR } = await import("../src/auth/context.js");

await ensureSchema();

const root = join(stage, "root");
mkdirSync(root, { recursive: true });

// ── ① 自用模式:一条路径都不钳 ─────────────────────────────────────────────
{
  assert.deepEqual(await pathScope.pathScopeOf(SINGLE_ACTOR), { clamp: "none" }, "自用模式不钳路径");
  assert.equal(await pathScope.projectPathRejection(SINGLE_ACTOR, "/anywhere/at/all"), null);
}

await mode.setInstanceMode("multi", root);

const admin = await store.createUser({
  name: "admin", role: "admin", dirName: "admin", gitName: "A", gitEmail: "a@x", createdBy: null,
});
const alice = await store.createUser({
  name: "alice", role: "member", dirName: "alice", gitName: "Al", gitEmail: "al@x", createdBy: admin.id,
});
await mode.ensureUserHomeDir("admin");
await mode.ensureUserHomeDir("alice");
mkdirSync(join(root, "bob"), { recursive: true });

const actorOf = (user: store.UserRow) => ({
  kind: "user" as const,
  userId: user.id,
  role: user.role,
  name: user.name,
});
const adminActor = actorOf(admin);
const aliceActor = actorOf(alice);
const aliceHome = join(root, "alice");

// ── ② 管理员豁免 / 普通用户钳到自己目录 ───────────────────────────────────
{
  assert.deepEqual(await pathScope.pathScopeOf(adminActor), { clamp: "none" }, "实例管理员不受钳制");
  assert.equal(await pathScope.projectPathRejection(adminActor, join(root, "bob", "x")), null);

  assert.deepEqual(
    await pathScope.pathScopeOf(aliceActor),
    { clamp: "home", home: aliceHome },
    "普通用户钳到自己目录",
  );
  assert.equal(await pathScope.projectPathRejection(aliceActor, join(aliceHome, "proj")), null);
  assert.ok(
    await pathScope.projectPathRejection(aliceActor, aliceHome),
    "用户目录根本身不许注册成项目(§七 D10)",
  );
  assert.ok(
    await pathScope.projectPathRejection(aliceActor, join(root, "bob", "proj")),
    "不许把项目建到别人目录里",
  );
  assert.ok(
    await pathScope.projectPathRejection(aliceActor, join(stage, "outside")),
    "不许跑到根目录外面",
  );
  // 一条指向外面的软链就是现成的越狱通道 —— 所以钳制走 realpath。
  const escape = join(aliceHome, "escape");
  mkdirSync(join(stage, "elsewhere"), { recursive: true });
  symlinkSync(join(stage, "elsewhere"), escape);
  assert.ok(
    await pathScope.projectPathRejection(aliceActor, join(escape, "proj")),
    "软链指到根目录外面同样要拦",
  );
  // 空路径放行:「先建项目、回头补路径」是既有正常用法。
  assert.equal(await pathScope.projectPathRejection(aliceActor, ""), null);
}

// ── ③ 算不出目录 = deny,不是「不用钳」 ────────────────────────────────────
{
  const legacyAgent = { kind: "agent" as const, userId: null, taskId: "t-legacy", role: "member" as const, name: "存量任务" };
  const ghostUser = { kind: "user" as const, userId: "deleted-user", role: "member" as const, name: "查无此人" };
  const cases = [
    ["存量任务回合凭证", legacyAgent],
    ["匿名", ANONYMOUS_ACTOR],
    ["账号已删", ghostUser],
  ] as const;
  for (const [label, actor] of cases) {
    const scope = await pathScope.pathScopeOf(actor);
    assert.equal(scope.clamp, "deny", `${label}:算不出目录就得拒绝,不是放行`);
    assert.ok(
      await pathScope.projectPathRejection(actor, join(stage, "outside")),
      `${label}:不许在根目录外面建项目`,
    );
    assert.ok(
      await pathScope.projectPathRejection(actor, join(aliceHome, "proj")),
      `${label}:别人目录里也不行`,
    );
    // 空路径仍旧放行 —— 拒的是「用一条本机路径」,不是「建项目」这件事本身。
    assert.equal(await pathScope.projectPathRejection(actor, ""), null, `${label}:空路径照常放行`);
  }
}

console.log("test-multi-user-paths ok");
await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
