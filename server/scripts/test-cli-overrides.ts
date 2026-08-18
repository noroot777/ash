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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb } from "./tmp-db.js";

requireTmpDb("test-cli-overrides");

const {
  UNKNOWN_CLI_HOST_ENV,
  claudeCompactionPlan,
  cliConfigOverrideEnv,
  cliConfigOverrideErrors,
  cliConfigOverrideHints,
  cliConfigOverrideSettings,
  cliConfigOverridesFor,
  cliSpeedOverrideConflict,
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
  { [spec.env]: "160000", DISABLE_COMPACT: "", DISABLE_AUTO_COMPACT: "" },
  "配了就该落成声明里的那个环境变量,并连自动压缩的两把总开关一起摁住",
);

// ── ①a 总开关:配了窗口就得把用户那**三**把 kill switch 一起摁住 ────────────────
// claude 的 JI() 顺着查三条:`DISABLE_COMPACT` → `DISABLE_AUTO_COMPACT` → 设置项
// `autoCompactEnabled`。任意一条成立,窗口和百分比全都还在、自动压缩却一次都不会被叫起来
// (第 2 轮 finding 1 只摁住了后两条,第 3 轮 finding 1 补上第一条)。
// 2.1.220 真机实测:`DISABLE_COMPACT=1` 时 slash_commands 里连手动 `/compact` 都消失,
// 而只置空 `DISABLE_AUTO_COMPACT` 救不回来 —— 两个变量不是别名。
const forced = cliConfigOverrideSettings("claude", { autoCompactWindow: 200_000, autoCompactPercent: 80 });
assert.equal(forced?.autoCompactEnabled, true, "配了窗口就要在 --settings 里显式打开自动压缩");
for (const key of ["DISABLE_COMPACT", "DISABLE_AUTO_COMPACT"]) {
  assert.equal(
    (forced?.env as Record<string, string>)[key],
    "",
    `${key} 这把 kill switch 要被空串盖掉(各层 env 按 key 合并)`,
  );
}
// 反向:没配窗口就一个字都不许碰用户的开关。
assert.equal(cliConfigOverrideSettings("claude", {}), null, "没配覆盖项时不该凭空生成 settings");
for (const key of ["DISABLE_COMPACT", "DISABLE_AUTO_COMPACT"]) {
  assert.equal(
    cliConfigOverrideEnv("claude", { autoCompactPercent: 80 })[key],
    undefined,
    `窗口没配(这一档整体不生效)时不该去摁用户的 ${key}`,
  );
}
assert.ok(
  cliConfigOverrideHints("claude", { autoCompactWindow: 200_000, autoCompactPercent: 80 })
    .some((line) => line.includes("强制打开自动压缩")),
  "摁住别人的开关必须在界面上说出来",
);
assert.ok(
  cliConfigOverridesFor("claude").find((s) => s.key === "autoCompactWindow")!.help.includes("总开关"),
  "窗口那一项的说明要讲明白它会连总开关一起摁住",
);

// ── ①c 换算分母也得钉住,否则算完还能被 settings.env 改掉 ────────────────────
// 触发点 = f(窗口, 百分比, min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, 20000))。harness 按自己读到的
// 值算完百分比,用户 settings.env 再把这个变量改小,有效窗口就变大、真实触发点比页面写的
// 晚几个百分点(第 2 轮审查 finding 3)。所以把「我们读到的那个赢家值」原样钉进 settings。
const pinned = cliConfigOverrideEnv(
  "claude",
  { autoCompactWindow: 200_000, autoCompactPercent: 80 },
  { maxOutputTokens: 10_000 },
);
assert.equal(pinned.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "10000", "读到多少就钉多少(对用户是原地不动)");
assert.equal(
  cliConfigOverrideEnv("claude", { autoCompactWindow: 200_000 }, UNKNOWN_CLI_HOST_ENV)
    .CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  undefined,
  "读不到(ssh 远端)就不钉 —— 编一个数比不钉更糟",
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
async function probeEnvFor(executorId: string, cwd = sandbox): Promise<string> {
  rmSync(probe, { force: true });
  const executor = await resolveExecutorFor({ executorId, type: "claude" });
  const handle = executor.run({ cwd, prompt: "noop" });
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
// 自己终端里不会 —— 而命令是从会话详情里原样复制走的,他不会想到还差一截参数。
// **必须是 `--settings` 而不是 env 前缀**:CLI 会把各层 settings 的 env 写回自己的进程
// 环境,命令行上的 env 前缀反而输给用户的 settings.json(第 2 轮审查 finding 2)。
const overridden = await resolveExecutorFor({ executorId: "claude-overridden", type: "claude" });
// 三件套一次算齐:落库的两列跟粘贴用的那条命令同源同一次算出来(第 2 轮 finding 6 /
// 第 3 轮 finding 2 —— 先前 resumeArgs 是构造器里冻好的,不带本轮 cwd)。
const overriddenFields = overridden.resumeFields(sandbox, "sid-1");
const args = overriddenFields.resumeArgs ?? "";
assert.ok(args.includes("--settings"), `resumeArgs 要带上 --settings,实际 ${args || "(空)"}`);
assert.ok(args.includes(`${spec.env}`), `--settings 里要有覆盖项本身,实际 ${args}`);
const overriddenResume = overriddenFields.resumeCommand;
assert.equal(overriddenResume, overridden.resumeCommand(sandbox, "sid-1"), "两个入口必须给出同一条命令");
assert.ok(overriddenResume.includes(args), "落库的那截参数必须就是命令里的那截(读取端按它重算)");
assert.ok(overriddenResume.includes("--settings"), "恢复命令本身要带上那截参数");
assert.ok(
  overriddenResume.includes(`${spec.env}`) && overriddenResume.includes(String(spec.max)),
  `恢复命令里要能看到真正生效的那个值,实际 ${overriddenResume}`,
);
const plain = await resolveExecutorFor({ executorId: "claude-plain", type: "claude" });
const plainFields = plain.resumeFields(sandbox, "sid-1");
assert.equal(plainFields.resumeEnv, null, "没配覆盖项、也没挂供应商时,前缀该是空的");
assert.equal(plainFields.resumeArgs, null, "没配覆盖项、也没开加速档时不该多出一截参数");
assert.ok(!plainFields.resumeCommand.includes("--settings"), "没配就不该凭空多出参数");

// 会话详情读取时是**重算**这条命令的(resumeCommandFor),那截参数从库里那列接回来 ——
// 这条链断了的话上面两条仍然过,但用户在页面上看到的还是不带 --settings 的命令。
const { resumeCommandFor, sessionTargetKey } = await import("../src/executors/resume.js");
assert.ok(
  resumeCommandFor("claude", "local", sandbox, "sid-1", null, args).includes("--settings"),
  "重算时要把持久化的那截参数接回去",
);
// ssh 目标下整条命令被裹进一层双引号,而 --settings 的 JSON 自带双引号 —— 不转义的话
// 引号在这里断开,复制出去的命令直接是语法错的。
const sshResume = resumeCommandFor("claude", "ssh:build.example", sandbox, "sid-1", null, args);
assert.ok(sshResume.startsWith("ssh "), "ssh 目标要走 ssh");
assert.ok(sshResume.includes('\\"'), `JSON 里的双引号要转义,实际 ${sshResume}`);
assert.equal(
  (sshResume.match(/(?<!\\)"/g) ?? []).length,
  2,
  `未转义的双引号只该是最外层那对,实际 ${sshResume}`,
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
//
// HOME 先支到一个空沙箱:分母的解析优先读 `~/.claude/settings.json`(那才是 CLI 的
// 真实优先级),开发机上恰好写过这一项的话,下面这个 process.env 就赢不了,断言会变成
// 「看谁的机器」。分层本身另有 ⑦b 直测。
const realHome = process.env.HOME;
process.env.HOME = join(sandbox, "empty-home");
mkdirSync(process.env.HOME, { recursive: true });
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "10000";
const localPct = (await resolveExecutorFor({ executorId: "claude-pct-local", type: "claude" })).resumeFields(sandbox, "sid-1").resumeArgs ?? "";
const remotePct = (await resolveExecutorFor({ executorId: "claude-pct-ssh", type: "claude" })).resumeFields(sandbox, "sid-1").resumeArgs ?? "";
const pctOf = (hint: string) => hint.match(/CLAUDE_AUTOCOMPACT_PCT_OVERRIDE\\?"[:=]\\?"?([\d.]+)/)?.[1];
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

// ── ⑦b 分母按 claude 自己的分层解:文件层压过继承来的环境变量 ──────────────────
// 用户在 `~/.claude/settings.json` 里写了 10000,CLI 启动时会把它写回自己的进程环境 ——
// harness 只看 process.env 就会按 32000 默认值算,填 80% 实际约 84% 才压(第 2 轮 finding 3)。
const { claudeMaxOutputTokens } = await import("../src/executors/claude-settings.js");
// 开发机 / CI 要是带着 CLAUDE_CONFIG_DIR,用户层就指到别处去了,下面每一条都会误红误绿。
// 先摘掉,要测它的场景自己往上设(第 4 轮审查建议 3)。
const realConfigDir = process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_CONFIG_DIR;
const fakeHome = join(sandbox, "home");
const fakeProject = join(sandbox, "proj");
mkdirSync(join(fakeHome, ".claude"), { recursive: true });
mkdirSync(join(fakeProject, ".claude"), { recursive: true });
writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "12000" } }));
process.env.HOME = fakeHome;
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "30000";
assert.equal(claudeMaxOutputTokens(), 12000, "~/.claude/settings.json 的 env 压过继承来的环境变量");
writeFileSync(join(fakeProject, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: 9000 } }));
assert.equal(claudeMaxOutputTokens(fakeProject), 9000, "项目层压过用户层(数字写法也要认)");
writeFileSync(join(fakeProject, ".claude", "settings.local.json"), JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000" } }));
assert.equal(claudeMaxOutputTokens(fakeProject), 8000, "settings.local.json 又压过 settings.json");
rmSync(join(fakeHome, ".claude", "settings.json"));
rmSync(join(fakeProject, ".claude"), { recursive: true, force: true });
assert.equal(claudeMaxOutputTokens(fakeProject), 30000, "哪一层都没写过时才回落到进程环境");
delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
assert.equal(claudeMaxOutputTokens(fakeProject), null, "全都没有 = 读不到(按默认预留估算)");

// ── ⑦c 两条反直觉的实测事实,离线也得覆盖 ────────────────────────────────────
// 这两条只在 test:claude-settings-live 里对过真 CLI,而那条本机没装 claude 就整条跳过 ——
// 于是「没装 claude 的机器」等于完全没测(第 4 轮审查建议 3)。这里按同样的场景钉住
// harness 这一侧的解析:live 那条负责「假设还对不对」,这条负责「代码有没有照假设做」。
const layer = (dir: string, file: "settings.json" | "settings.local.json", value: number | null) => {
  const path = join(dir, ".claude", file);
  if (value === null) return rmSync(path, { force: true });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(path, JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(value) } }));
};

// ① CLAUDE_CONFIG_DIR 整个取代 ~/.claude,不回落;settings.json 直接躺在它下面。
const altConfig = join(sandbox, "alt-config");
mkdirSync(altConfig, { recursive: true });
writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "12000" } }));
assert.equal(claudeMaxOutputTokens(), 12000, "没设 CLAUDE_CONFIG_DIR 时读 ~/.claude");
process.env.CLAUDE_CONFIG_DIR = altConfig;
assert.equal(claudeMaxOutputTokens(), null, "指到空目录 = 读不到,不许退回 HOME 的那份(退回的话这里是 12000)");
writeFileSync(join(altConfig, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "7000" } }));
assert.equal(claudeMaxOutputTokens(), 7000, "settings.json 直接在 CLAUDE_CONFIG_DIR 下,不是再套一层 .claude");
delete process.env.CLAUDE_CONFIG_DIR;

// ② linked worktree 不是独立项目:local 档认主仓、shared 档认当前目录。
// harness 默认就在 worktree 里干活,读漏主仓那份 settings.local.json = 分母整个错掉。
const mainRepo = join(sandbox, "wt-main");
const linkedWt = join(sandbox, "wt-linked"); // 跟主仓平级:目录树上互不包含,才测得出「按 git 关系找主仓」
mkdirSync(join(mainRepo, ".git", "worktrees", "probe"), { recursive: true });
mkdirSync(linkedWt, { recursive: true });
writeFileSync(join(linkedWt, ".git"), `gitdir: ${join(mainRepo, ".git", "worktrees", "probe")}\n`);
layer(mainRepo, "settings.local.json", 8000);
layer(linkedWt, "settings.local.json", 5000);
assert.equal(claudeMaxOutputTokens(linkedWt), 8000, "两边都有 local 档时主仓赢");
layer(linkedWt, "settings.local.json", null);
assert.equal(claudeMaxOutputTokens(linkedWt), 8000, "worktree 里看不见主仓那份 = 等于没配,不该漏读");
layer(mainRepo, "settings.local.json", null);
layer(linkedWt, "settings.local.json", 5000);
assert.equal(claudeMaxOutputTokens(linkedWt), 5000, "主仓没写才轮到 worktree 自己那份");
layer(linkedWt, "settings.local.json", null);
layer(mainRepo, "settings.json", 8888);
layer(linkedWt, "settings.json", 5000);
assert.equal(claudeMaxOutputTokens(linkedWt), 5000, "shared 档反过来:就近赢");
layer(mainRepo, "settings.local.json", 8000);
assert.equal(claudeMaxOutputTokens(linkedWt), 8000, "local 档整体高于 shared 档");

if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
else process.env.CLAUDE_CONFIG_DIR = realConfigDir;
if (realHome === undefined) delete process.env.HOME;
else process.env.HOME = realHome;

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
// 合并 token(整段粘贴、老配置里常见):执行器那边会拆词后再拼进命令行,所以判定也必须
// 先拆 —— 只比对原始 token 的话页面看不出冲突、跑起来却真的被顶掉(第 2 轮 finding 4)。
assert.ok(cliConfigOverrideConflict("claude", ["--settings {}"]), "合并成一个 token 的写法也要认出来");
assert.ok(
  cliConfigOverrideConflict("claude", ['--model opus --settings {"env":{}}']),
  "混在一长串里的 --settings 同样要认出来",
);
assert.equal(
  cliConfigOverrideConflict("claude", ["--append-system-prompt", "别把 --settings 当参数"]),
  null,
  "引号里的字面量不是参数,不该误报",
);

// 加速档共用同一个 `--settings`,所以它自己也会被顶掉 —— 速度那一列得单独说一句。
assert.ok(
  cliSpeedOverrideConflict("claude", ["--settings", "{}"], "fast"),
  "选了 1.5x 又自带 --settings 时要提示加速档失效",
);
assert.ok(cliSpeedOverrideConflict("claude", ["--settings {}"], "fast"), "合并 token 同样适用于加速档");
assert.equal(cliSpeedOverrideConflict("claude", ["--settings", "{}"], "standard"), null, "没开加速档就没这回事");
assert.equal(cliSpeedOverrideConflict("claude", ["--model", "opus"], "fast"), null, "无关参数不该报警");
assert.equal(cliSpeedOverrideConflict("codex", ["--settings"], "fast"), null, "别的 CLI 不走这一档");

// ── ⑧b 粘贴出去的那条命令 = harness 自己真跑的那条 ─────────────────────────────
// 触发点是按「CLI 最终会看到的 max output tokens」换算的,而那个值要读**项目层**的
// settings —— 于是同一个 profile 在不同 cwd 下算出来的百分比本就不同。先前恢复参数是
// 建执行器时冻好的(没有 cwd),harness 按 pct=84.21 跑、复制出来的命令写着 pct=88.89,
// 同一条会话两边压缩水位差了几千 token(第 3 轮审查 finding 2)。
const pctProject = join(sandbox, "pct-proj");
mkdirSync(join(pctProject, ".claude"), { recursive: true });
writeFileSync(
  join(pctProject, ".claude", "settings.json"),
  JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "10000" } }),
);
await probeEnvFor("claude-pct-local", pctProject);
const ranWith = settingsOf(lastCommandLine);
const pctExecutor = await resolveExecutorFor({ executorId: "claude-pct-local", type: "claude" });
const pasted = pctExecutor.resumeFields(pctProject, "sid-1");
assert.deepEqual(
  JSON.parse(pasted.resumeArgs!.match(/--settings '(.*)'$/)![1]!.replace(/'\\''/g, "'")),
  ranWith,
  "恢复参数必须跟本轮真跑的 --settings 一模一样(否则用户手跑的那次压缩水位不同)",
);
// 负向钉子:换个没写过项目层的目录,同一个 profile 算出来的百分比就该变 —— 相等说明
// cwd 根本没参与换算,上面那条也就只是「两边一起错」。
const pctElsewhere = pctExecutor.resumeFields(join(sandbox, "no-proj"), "sid-1");
const pctIn = (args: string | null) => args?.match(/CLAUDE_AUTOCOMPACT_PCT_OVERRIDE\\?"?[:=]\\?"?([\d.]+)/)?.[1];
assert.equal(pctIn(pasted.resumeArgs), String(ranWith.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE));
assert.notEqual(
  pctIn(pasted.resumeArgs),
  pctIn(pctElsewhere.resumeArgs),
  "项目层写了预留量的目录 vs 没写的目录,换算结果本就该不同",
);

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
