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
  UNKNOWN_CLI_HOST_ENV,
  claudeCompactionPlan,
  cliConfigOverrideEnv,
  cliConfigOverrideErrors,
  cliConfigOverrideHints,
  cliConfigOverridesFor,
  ineffectiveCliConfigOverrides,
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
  // 同一份覆盖项,一个跑本机、一个跑 ssh 远端 —— 用来钉「远端不拿本机环境换算」。
  {
    id: "claude-pct-local",
    name: "claude@pct-local",
    type: "claude",
    target: JSON.stringify({ kind: "local" }),
    extraArgs: "[]",
    configOverrides: JSON.stringify({ autoCompactWindow: 200_000, autoCompactPercent: 80 }),
    isDefault: false,
  },
  {
    id: "claude-pct-ssh",
    name: "claude@pct-ssh",
    type: "claude",
    target: JSON.stringify({ kind: "ssh", host: "build.example" }),
    extraArgs: "[]",
    configOverrides: JSON.stringify({ autoCompactWindow: 200_000, autoCompactPercent: 80 }),
    isDefault: false,
  },
  // 1.5x 加速档 + 覆盖项:两件事都只能从 `--settings` 进,而 claude 只认最后一个
  // `--settings` —— 各推一个的话先推的那份连同它的 env 会被静默丢掉。
  {
    id: "claude-fast-overridden",
    name: "claude@fast",
    type: "claude",
    target: JSON.stringify({ kind: "local" }),
    extraArgs: "[]",
    speed: "fast",
    configOverrides: JSON.stringify({ autoCompactWindow: 200_000, autoCompactPercent: 80 }),
    isDefault: false,
  },
  // 库里躺着一份坏 JSON(手工改过 / 早期写入):读端不能因此整个炸掉。
  {
    id: "claude-broken",
    name: "claude@broken",
    type: "claude",
    target: JSON.stringify({ kind: "local" }),
    extraArgs: "[]",
    configOverrides: "{不是 JSON",
    isDefault: false,
  },
]);

let lastCommandLine = "";
async function probeEnvFor(executorId: string): Promise<string> {
  rmSync(probe, { force: true });
  const executor = await resolveExecutorFor({ executorId, type: "claude" });
  const handle = executor.run({ cwd: sandbox, prompt: "noop" });
  lastCommandLine = handle.commandLine;
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
const { resumeCommandFor, sessionTargetKey } = await import("../src/executors/resume.js");
assert.ok(
  resumeCommandFor("claude", "local", sandbox, "sid-1", hint).includes(`${spec.env}=${spec.max}`),
  "重算时要把持久化的前缀接回去",
);

// ── ⑥ 依赖项没配上的组合,存不进去 ──────────────────────────────────────────
// 只在前端拦是拦不住的:旧客户端、直接打 API、历史坏数据都能绕过去。判据必须是共用的
// 那一份,否则两边措辞和口径迟早各说各话。
assert.deepEqual(
  ineffectiveCliConfigOverrides("claude", { autoCompactPercent: 80 }),
  ["autoCompactPercent"],
  "只填百分比 = 这一项空转,要能被点名",
);
assert.deepEqual(
  ineffectiveCliConfigOverrides("claude", { autoCompactWindow: 200_000, autoCompactPercent: 80 }),
  [],
  "两项都填了就没有空转项",
);
assert.equal(cliConfigOverrideErrors("claude", { autoCompactPercent: 80 }).length, 1, "空转项要给出一句人话");
assert.deepEqual(cliConfigOverrideErrors("claude", { autoCompactWindow: 200_000 }), [], "只填窗口是合法的");

// 判据共用还不够,**权威那道闸得真的在服务端**:走真实路由打一遍。
const { api } = await import("../src/routes.js");
const postAgent = (body: unknown) =>
  api.request("/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const rejected = await postAgent({
  name: "claude@percent-only",
  type: "claude",
  configOverrides: { autoCompactPercent: 80 },
});
assert.equal(rejected.status, 400, "只有百分比的覆盖必须被服务端拒掉,不能存成「显示已覆盖、实际不生效」");
const accepted = await postAgent({
  name: "claude@percent-ok",
  type: "claude",
  configOverrides: { autoCompactWindow: 200_000, autoCompactPercent: 80 },
});
assert.equal(accepted.status, 201, "配全了要能正常存下");
const createdId = ((await accepted.json()) as { id: string }).id;
const patched = await api.request(`/agents/${createdId}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ configOverrides: { autoCompactPercent: 80 } }),
});
assert.equal(patched.status, 400, "PATCH 是另一条口子,同样得拦(对称端点只改一个是老毛病)");

// ── ⑦ ssh profile:换算不许拿本机环境凑数 ────────────────────────────────────
// 远端 CLI 读的是远端那份环境。本机设了 10k 预留就按 10k 算的话,注给远端的百分比会
// 直接偏几个百分点,而页面上还写得像个准数。
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "10000";
const localPct = (await resolveExecutorFor({ executorId: "claude-pct-local", type: "claude" })).resumeEnvHint ?? "";
const remotePct = (await resolveExecutorFor({ executorId: "claude-pct-ssh", type: "claude" })).resumeEnvHint ?? "";
const pctOf = (prefix: string) => prefix.match(/CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=([\d.]+)/)?.[1];
assert.equal(
  pctOf(localPct),
  String(claudeCompactionPlan({ autoCompactWindow: 200_000, autoCompactPercent: 80 }, { maxOutputTokens: 10_000 })!.envPercent),
  "本机 profile 要按真读到的预留量换算",
);
assert.equal(
  pctOf(remotePct),
  String(claudeCompactionPlan({ autoCompactWindow: 200_000, autoCompactPercent: 80 })!.envPercent),
  "ssh profile 要按默认预留估算,不能沿用本机那个值",
);
assert.notEqual(pctOf(localPct), pctOf(remotePct), "两者本就该不同,相等说明 target 没传到换算里");
delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;

assert.ok(
  cliConfigOverrideHints("claude", { autoCompactWindow: 200_000, autoCompactPercent: 80 }, UNKNOWN_CLI_HOST_ENV)
    .some((line) => line.includes("估算")),
  "读不到远端环境时要明说这个触发点是估的",
);

// ssh 会话存进库的 target 必须带上主机名 —— 恢复命令每次按它重算,存 "local" 就会给出
// 一条在本机执行、cwd 还指向远端路径的命令。
assert.equal(sessionTargetKey({ kind: "ssh", host: "build.example" }), "ssh:build.example");
assert.equal(sessionTargetKey({ kind: "local" }), "local");
assert.ok(
  resumeCommandFor("claude", "ssh:build.example", sandbox, "sid-1", "").startsWith("ssh "),
  "库里记着 ssh:<host> 时,重算出来的命令要真的走 ssh",
);

// ── ⑧ 光有环境变量赢不了:必须同时走 claude 的 `--settings` ──────────────────
// claude 启动时会把各层 settings 的 `env` 写回自己的进程环境,用户 settings.json 里的
// 同名变量于是反过来盖掉我们注进去的那份(第 1 轮审查 finding 1)。`--settings` 是优先级
// 最高的一档,这一档配置对外承诺的正是「覆盖 settings.json」,所以命令行里必须有它。
const settingsOf = (commandLine: string): Record<string, any> => {
  const m = commandLine.match(/--settings (\{.*?\})(?: |$)/);
  assert.ok(m, `命令行里应有 --settings,实际:${commandLine}`);
  return JSON.parse(m![1]!);
};
await probeEnvFor("claude-pct-local");
const injected = settingsOf(lastCommandLine);
assert.equal(
  injected.env?.[spec.env],
  "200000",
  "覆盖项要以 --settings 的 env 形式进命令行(只靠进程环境会被 settings.json 盖回去)",
);
assert.ok(injected.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "换算后的百分比同样要走这一档");

await probeEnvFor("claude-plain");
assert.ok(!lastCommandLine.includes("--settings"), "没配覆盖项、也没开加速档时不该凭空多一个 --settings");

// 加速档和覆盖项必须在**同一个** --settings 里:claude 只认最后一个,分开推等于二选一。
await probeEnvFor("claude-fast-overridden");
assert.equal(
  lastCommandLine.match(/--settings /g)?.length,
  1,
  `--settings 只能出现一次,实际:${lastCommandLine}`,
);
const merged = settingsOf(lastCommandLine);
assert.equal(merged.fastMode, true, "加速档不能因为合并而丢");
assert.equal(merged.env?.[spec.env], "200000", "覆盖项也不能因为合并而丢");

// 用户自己在额外参数里写了 --settings 时,我们这份会被整份顶掉 —— 设置页得说出来,
// 不然界面上写着「已覆盖」而 CLI 那边一个字没收到。
const { cliConfigOverrideConflict } = await import("@harness/shared/cli-overrides");
assert.ok(cliConfigOverrideConflict("claude", ["--settings", "{}"]), "自带 --settings 要给出警告");
assert.ok(cliConfigOverrideConflict("claude", ["--settings={}"]), "= 形式的写法同样要认出来");
assert.equal(cliConfigOverrideConflict("claude", ["--model", "opus"]), null, "无关参数不该报警");
assert.equal(cliConfigOverrideConflict("codex", ["--settings"]), null, "别的 CLI 没有这一档,不适用");

// ── ⑨ 库里的坏数据:读端一律按「没配」算,别把整页/整次执行拖下水 ───────────────
const { readCliConfigOverrides } = await import("@harness/shared/cli-overrides");
assert.deepEqual(readCliConfigOverrides("claude", "{不是 JSON"), {}, "坏 JSON 按没配算");
assert.deepEqual(readCliConfigOverrides("claude", null), {}, "空值按没配算");
assert.deepEqual(
  readCliConfigOverrides("claude", JSON.stringify({ [spec.key]: spec.max * 2 })),
  { [spec.key]: spec.max },
  "越界的老值要夹回去 —— 显示的和真跑的必须是同一个数",
);
const listed = await api.request("/agents");
assert.equal(listed.status, 200, "库里有坏 JSON 时 GET /agents 仍要能返回(以前整条 500)");
const rows = (await listed.json()) as Array<{ id: string; configOverrides?: Record<string, number> }>;
assert.deepEqual(
  rows.find((r) => r.id === "claude-broken")?.configOverrides,
  {},
  "坏数据的 profile 在设置页显示成「未覆盖」",
);
assert.deepEqual(
  rows.find((r) => r.id === "claude-overridden")?.configOverrides,
  { [spec.key]: spec.max },
  "页面读到的值要跟执行器真正注入的那份一致(都夹过范围)",
);
assert.equal(await probeEnvFor("claude-broken"), "<unset>", "坏数据的 profile 照样能派任务,只是不注入");

rmSync(sandbox, { recursive: true, force: true });
console.log("test:cli-overrides ok");
process.exit(0);
