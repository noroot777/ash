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
  claudeCompactionPlan,
  cliConfigOverrideEnv,
  cliConfigOverrideHints,
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

// ── ①b 百分比:用户填「占窗口的百分之几」,claude 认的是「占有效窗口的百分之几」 ──
// 有效窗口 = 窗口 − 20k(max_output 预留),触发点还有个 −13k 的下限。这段换算错了
// 不会报错,只会压得比用户以为的晚,所以按算例钉死。
const plan = claudeCompactionPlan({ autoCompactWindow: 200_000, autoCompactPercent: 80 });
assert.ok(plan, "填了窗口就该算得出方案");
assert.ok(
  Math.abs(plan.trigger - 160_000) <= 100,
  `200k 的 80% 应当真的在 ~160k 触发,实际 ${plan.trigger}`,
);
assert.equal(plan.capped, false, "80% 没到 claude 自己的下限,不该标 capped");
assert.equal(
  cliConfigOverrideEnv("claude", { autoCompactWindow: 200_000, autoCompactPercent: 80 })
    .CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
  String(plan.envPercent),
  "注入的百分比要用换算后的值,不是用户填的那个",
);

const late = claudeCompactionPlan({ autoCompactWindow: 200_000, autoCompactPercent: 95 });
assert.ok(late?.capped, "95% 比 claude 的下限(窗口 − 33k)还晚,应如实标 capped");
assert.equal(late.trigger, 167_000, "被顶掉时触发点就是那个下限");

const bare = claudeCompactionPlan({ autoCompactWindow: 200_000 });
assert.equal(bare?.trigger, 167_000, "只填窗口时用 claude 的默认触发点");

// 百分比单独填对 CLI 毫无意义(窗口不配,来源仍是 auto,压缩整段跳过),不能注进去
// 让人以为它在起作用。
assert.deepEqual(
  cliConfigOverrideEnv("claude", { autoCompactPercent: 80 }),
  {},
  "缺依赖项时这一项不该落成环境变量",
);
assert.ok(
  cliConfigOverrideHints("claude", { autoCompactPercent: 80 })[0]?.includes("不起作用"),
  "缺依赖项时要明说它不起作用",
);
assert.ok(
  cliConfigOverrideHints("claude", { autoCompactWindow: 200_000, autoCompactPercent: 80 })[0]?.includes("160k"),
  "填全了要把算出来的触发水位显示出来",
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

// ── ④ harness 自己环境里带着同名变量时,「留空」必须真的是空 ──────────────────
// spawn 传的是 `{ ...process.env, ...补丁 }`。不显式删,这个变量就会穿过去盖掉 CLI 的
// settings.json,而设置页还显示「未覆盖」—— 用户没有任何办法在界面上把它清掉。
process.env[spec.env] = "123456";
assert.equal(
  await probeEnvFor("claude-plain"),
  "<unset>",
  "父进程带着同名变量时,留空的 profile 要把它从子进程里删掉",
);
assert.equal(
  await probeEnvFor("claude-overridden"),
  String(spec.max),
  "配了的 profile 以自己的值为准,不受父进程那份影响",
);
delete process.env[spec.env];

// ── ⑤ 「复制到终端接着聊」那条命令也得带上覆盖项 ────────────────────────────
// 不带的话,用户手跑的那一次退回 settings.json:同一条会话在 harness 里会自动压缩、
// 自己终端里不会 —— 而命令是从会话详情里原样复制走的,他不会想到还差两个变量。
const overridden = await resolveExecutorFor({ executorId: "claude-overridden", type: "claude" });
const hint = overridden.resumeEnvHint ?? "";
assert.ok(hint.includes(`${spec.env}=${spec.max}`), `resumeEnvHint 要带上覆盖项,实际 ${hint || "(空)"}`);
assert.ok(
  overridden.resumeCommand?.(sandbox, "sid-1").includes(`${spec.env}=${spec.max}`),
  "恢复命令本身要带上那截 env 前缀",
);
const plain = await resolveExecutorFor({ executorId: "claude-plain", type: "claude" });
assert.equal(plain.resumeEnvHint, undefined, "没配覆盖项、也没挂供应商时,前缀该是空的");
assert.ok(!plain.resumeCommand?.(sandbox, "sid-1").includes(spec.env), "没配就不该凭空多出变量");

// 会话详情读取时是**重算**这条命令的(resumeCommandFor),前缀从库里那列接回来 ——
// 这条链断了的话上面两条仍然过,但用户在页面上看到的还是不带前缀的命令。
const { resumeCommandFor } = await import("../src/executors/resume.js");
assert.ok(
  resumeCommandFor("claude", "local", sandbox, "sid-1", hint).includes(`${spec.env}=${spec.max}`),
  "重算时要把持久化的前缀接回去",
);

rmSync(sandbox, { recursive: true, force: true });
console.log("test:cli-overrides ok");
process.exit(0);
