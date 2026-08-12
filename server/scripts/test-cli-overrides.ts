// 「覆盖 CLI 自己的配置」回归测试。钉住三件事:
//   ① 声明表之外的 key 不落库、超范围的值被夹进 CLI 真认得的区间
//   ② profile 上配的值,真的以环境变量的形式出现在**子进程**里
//   ③ 没配的 profile 不注入(不是注入空串 —— 空串对 claude 是「配过但为空」)
//
// ② 是这条测试的重点:纯函数好写也好对,容易漂的是「执行器有没有真把它接上」。
// 所以这里往 PATH 前面塞一个假的 `claude`,让它把自己看到的环境变量写进探针文件,
// 再走完整的 resolveExecutorFor → 执行器 → spawn 链路去读那个文件。
//
// 跑法:
//   HARNESS_DB=/tmp/test-cli-overrides-$RANDOM.db npx tsx server/scripts/test-cli-overrides.ts
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.HARNESS_DB) {
  console.error("先设 HARNESS_DB=/tmp/test-cli-overrides-<rand>.db 再跑");
  process.exit(1);
}
if (!process.env.HARNESS_DB.startsWith("/tmp/")) {
  console.error("HARNESS_DB 必须在 /tmp/ 下(防止误改真实数据)");
  process.exit(1);
}

const {
  cliConfigOverrideEnv,
  cliConfigOverridesFor,
  normalizeCliConfigOverrides,
} = await import("@harness/shared/cli-overrides");

// ── ① 归一化 ──────────────────────────────────────────────────────────────
const spec = cliConfigOverridesFor("claude")[0];
assert.ok(spec, "claude 应至少声明一项可覆盖配置");

assert.deepEqual(
  normalizeCliConfigOverrides("claude", { [spec.key]: 160000 }),
  { [spec.key]: 160000 },
  "范围内的值应原样保留",
);
assert.deepEqual(
  normalizeCliConfigOverrides("claude", { [spec.key]: spec.min - 1 }),
  { [spec.key]: spec.min },
  "低于下限应夹到下限(CLI 会静默忽略越界值)",
);
assert.deepEqual(
  normalizeCliConfigOverrides("claude", { [spec.key]: spec.max + 1 }),
  { [spec.key]: spec.max },
  "高于上限应夹到上限",
);
assert.deepEqual(
  normalizeCliConfigOverrides("claude", { nopeNotDeclared: 1, [spec.key]: "" }),
  {},
  "没声明过的 key 与空值都不该落库",
);
assert.deepEqual(
  normalizeCliConfigOverrides("gemini", { [spec.key]: 160000 }),
  {},
  "没声明覆盖项的 CLI 一律返回空",
);

assert.deepEqual(cliConfigOverrideEnv("claude", {}), {}, "没配就不该有任何环境变量");
assert.deepEqual(
  cliConfigOverrideEnv("claude", { [spec.key]: 160000 }),
  { [spec.env]: "160000" },
  "配了就该落成声明里的那个环境变量",
);

// ── ②③ 真的进到子进程了吗 ──────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "harness-cli-overrides-"));
const probe = join(sandbox, "probe.txt");
const fakeBin = join(sandbox, "claude");
writeFileSync(
  fakeBin,
  `#!/bin/sh\nprintf '%s' "\${${spec.env}-<unset>}" > "$HARNESS_TEST_PROBE"\nexit 0\n`,
);
chmodSync(fakeBin, 0o755);
process.env.PATH = `${sandbox}:${process.env.PATH ?? ""}`;
process.env.HARNESS_TEST_PROBE = probe;

const { db, ensureSchema } = await import("../src/db/index.js");
const { agents } = await import("../src/db/schema.js");
const { resolveExecutorFor } = await import("../src/executors/index.js");

await ensureSchema();
await db.delete(agents);
await db.insert(agents).values([
  {
    id: "claude-overridden",
    name: "claude@overridden",
    type: "claude",
    target: JSON.stringify({ kind: "local" }),
    extraArgs: "[]",
    // 故意存一个超范围的值:老 profile / 后来改过范围的声明都可能留下这种,
    // 解析时必须夹回去,而不是把一个 CLI 会忽略的数原样注进去。
    configOverrides: JSON.stringify({ [spec.key]: spec.max * 2 }),
    isDefault: true,
  },
  {
    id: "claude-plain",
    name: "claude@plain",
    type: "claude",
    target: JSON.stringify({ kind: "local" }),
    extraArgs: "[]",
    configOverrides: "{}",
    isDefault: false,
  },
]);

async function probeEnvFor(executorId: string): Promise<string> {
  rmSync(probe, { force: true });
  const executor = await resolveExecutorFor({ executorId, type: "claude" });
  const handle = executor.run({ cwd: sandbox, prompt: "noop" });
  for (let i = 0; i < 100 && !existsSync(probe); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  handle.kill();
  assert.ok(existsSync(probe), `假 claude 没被起起来(executorId=${executorId})`);
  return readFileSync(probe, "utf8");
}

assert.equal(
  await probeEnvFor("claude-overridden"),
  String(spec.max),
  "profile 上配的覆盖项应夹到上限后出现在子进程环境里",
);
assert.equal(
  await probeEnvFor("claude-plain"),
  "<unset>",
  "没配的 profile 不该注入这个变量(注入空串会被 CLI 当成配过)",
);

rmSync(sandbox, { recursive: true, force: true });
console.log("test:cli-overrides ok");
process.exit(0);
