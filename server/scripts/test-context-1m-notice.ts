// 「执行器配了大压缩窗口、模型却没开 1M」这件事的判定与一键开启。
//
// 原形(任务 DsPlsJ9f7ABY):执行器配 600k · 80%,任务选的 claude-fable-5-2 没在供应商的
// 1M 列表里。CLI 把窗口截到 200k,触发点从 ~480k 掉到 ~149k,三轮里压了 17 次;界面上的
// 水位胶囊却照旧按 600k 算「还剩多少」,设置页也照旧写「480k 时压缩」。钉住四件事:
//  ① 判定:哪些组合 CLI 按 1M 算、哪些按 200k 算、能不能一键开;
//  ② 触发点按截过的窗口算(注入的百分比不变,那是 env 里真写的数);
//  ③ 水位胶囊的分母取「压缩窗口」与 CLI 自报窗口里小的那个;
//  ④ 一键开启的端点:原子追加、幂等、去后缀、非 anthropic 拒绝。
//
// 第 1、2 轮审查补的:
//  F1 「报出这份水位的那一轮在怎么跑」只看那个进程的启动快照(压缩窗口/百分比/输出预留),
//     执行器配置后来改了也不影响。快照由**产出水位的那一层**带上:普通起跑、可引导起跑、
//     重启接管三条路都要带全,落库时跟水位同一笔存 —— 实时事件、库里重读、接管后三种来源
//     必须算出同一个触发点;
//  F2 「下一轮会不会是 1M」跟起跑那一侧同一套判据:没 key 的供应商会回退官方账号,额外参数
//     里的 --model 会覆盖选中的模型。
//
// 跑法:ASH_DB=/tmp/test-context-1m-notice-$RANDOM.db npx tsx server/scripts/test-context-1m-notice.ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { requireTmpDb } from "./tmp-db.js";

requireTmpDb("test-context-1m-notice");

const { claudeModelWindow, clampedCompactWindow, CLAUDE_1M_WINDOW, CLAUDE_STANDARD_WINDOW } =
  await import("@ash/shared/context-1m");
const { claudeCompactionPlan, cliConfigOverrideEnv, cliConfigOverrideHints } = await import("@ash/shared/cli-overrides");
const { effectiveContextWindow, contextRatio, contextCompactTrigger, compactSnapshotFromEnv } = await import("@ash/shared/usage");
const { launchFields, sessionContext, sessionCompactSnapshot, sessionLaunchCompact, setSessionContext } = await import("../src/usage.js");

// ── ① 判定 ────────────────────────────────────────────────────────────────
const relay = {
  id: "p1",
  name: "nm-ccb",
  protocol: "anthropic" as const,
  model: "claude-opus-5-5",
  context1mModels: ["claude-opus-5-5"],
  hasKey: true,
};

assert.deepEqual(
  claudeModelWindow("claude-fable-5-2", relay),
  { model: "claude-fable-5-2", window: CLAUDE_STANDARD_WINDOW, provider: { id: "p1", name: "nm-ccb" }, blocker: null },
  "没在 1M 列表里的模型按 200k 算,并且给出能一键开启的那家供应商",
);
assert.equal(claudeModelWindow("claude-opus-5-5", relay)?.window, CLAUDE_1M_WINDOW, "列表里的按 1M 算");
assert.equal(claudeModelWindow("", relay)?.model, "claude-opus-5-5", "模型留空 = 跟随供应商默认模型");
assert.equal(claudeModelWindow("claude-opus-5-5[1m]", null)?.window, CLAUDE_1M_WINDOW, "官方账号带 [1m] 后缀就是 1M");
assert.equal(claudeModelWindow("claude-opus-5-5[1m]", null)?.model, "claude-opus-5-5", "判定结果里的模型名去掉后缀");
assert.equal(claudeModelWindow("claude-opus-5-5", null)?.provider, null, "官方账号没有能一键开启的供应商");
assert.equal(claudeModelWindow(null, null), null, "官方账号又没指定模型:判不出来,不猜");
assert.equal(claudeModelWindow("claude-opus-5-5", null)?.blocker?.kind, "official");

// F2:没 key 的供应商在起跑时不会挂上(loadRelay 返回 undefined),列表里声明了 1M 也不算。
const keyless = claudeModelWindow("claude-opus-5-5", { ...relay, hasKey: false });
assert.equal(keyless?.window, CLAUDE_STANDARD_WINDOW, "没 key 时按官方账号算,1M 声明不生效");
assert.equal(keyless?.provider, null, "没 key 时不给一键开启(开了也用不上)");
assert.deepEqual(keyless?.blocker, { kind: "no-key", provider: { id: "p1", name: "nm-ccb" } });
assert.equal(claudeModelWindow("", { ...relay, hasKey: false }), null, "没 key 也没模型:退回官方账号,判不出来");

// F2:额外参数里的 --model 排在 ash 那份之后,覆盖选中的模型;ash 只给选中的那个补 [1m]。
const overridden = claudeModelWindow("claude-opus-5-5", relay, ["--model claude-sonnet-5"]);
assert.equal(overridden?.model, "claude-sonnet-5", "合并 token 也要拆开认出 --model");
assert.equal(overridden?.window, CLAUDE_STANDARD_WINDOW, "选中的模型开了 1M 也没用,跑的是额外参数里那个");
assert.equal(overridden?.blocker?.kind, "extra-args-model");
assert.equal(
  claudeModelWindow("claude-opus-5-5", relay, ["--model=claude-sonnet-5[1m]"])?.window,
  CLAUDE_1M_WINDOW,
  "额外参数自己带 [1m] 就是 1M",
);

assert.equal(
  claudeModelWindow("claude-opus-5-5", { ...relay, protocol: "openai" })?.provider,
  null,
  "openai 协议的供应商没有 1M 声明这回事",
);

assert.deepEqual(clampedCompactWindow(600_000, 200_000), { configured: 600_000, effective: 200_000 });
assert.equal(clampedCompactWindow(600_000, 1_000_000), null, "开了 1M 就不截");
assert.equal(clampedCompactWindow(200_000, 200_000), null, "相等不算截");
assert.equal(clampedCompactWindow(undefined, 200_000), null, "没配窗口无从谈截");

// ── ② 触发点按截过的窗口算 ───────────────────────────────────────────────────
const values = { autoCompactWindow: 600_000, autoCompactPercent: 80 };
const declared = claudeCompactionPlan(values);
const clamped = claudeCompactionPlan(values, undefined, 200_000);
assert.ok(declared && clamped);
assert.equal(clamped.envPercent, declared.envPercent, "注入的百分比照旧按声明窗口换算");
assert.equal(
  cliConfigOverrideEnv("claude", values).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
  "82.76",
  "env 里写的数不因模型窗口改变",
);
assert.equal(clamped.window, 200_000);
assert.equal(clamped.clampedFrom, 600_000);
// 原形会话里实测的 17 次压缩,pre_tokens 最小 149,485 —— 触发点就是 0.8276 × (200k − 20k)。
assert.equal(clamped.trigger, 148_968, "被截到 200k 时真实触发点 ≈ 149k");
assert.ok(Math.abs(declared.trigger - 480_000) <= 100, `没截时 600k 的 80% ≈ 480k,实际 ${declared.trigger}`);
assert.equal(declared.clampedFrom, null);
assert.deepEqual(
  claudeCompactionPlan(values, undefined, 1_000_000),
  declared,
  "模型窗口比声明值大时跟不传一样",
);
const hint = cliConfigOverrideHints("claude", values, undefined, 200_000)[0] ?? "";
assert.ok(hint.includes("截掉") && hint.includes("149k"), `提示要说清被截、并给出真实触发点:${hint}`);

// ── ③ 水位胶囊的分母 ──────────────────────────────────────────────────────
assert.equal(
  effectiveContextWindow({ used: 120_000, window: 200_000, windowEstimated: false, compactWindow: 600_000 }),
  200_000,
  "CLI 自报 200k 时压缩窗口 600k 不作数",
);
assert.equal(
  Math.round(contextRatio({ used: 150_000, window: 200_000, windowEstimated: false, compactWindow: 600_000 })! * 100),
  75,
  "剩余量按 200k 算,而不是骗人说还剩 75%",
);
assert.equal(
  effectiveContextWindow({ used: 120_000, window: 1_000_000, windowEstimated: false, compactWindow: 600_000 }),
  600_000,
  "开了 1M 时压缩窗口才是先撞到的那个",
);
assert.equal(
  effectiveContextWindow({ used: 120_000, window: 200_000, windowEstimated: true, compactWindow: 600_000 }),
  600_000,
  "按模型名估出来的 200k 认不出 1M,不拿它截",
);

// F1:触发点只从会话自己的启动快照算 —— 原形会话固化的 --settings 原样喂进去。
const frozenArgs = `--settings '{"autoCompactEnabled":true,"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"600000",`
  + `"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"82.76","DISABLE_COMPACT":"","DISABLE_AUTO_COMPACT":""}}'`;
// 原形会话的命令行:只有 ash 那一个 --settings(临时文件路径),resume_args 里的就是生效配置。
const frozenCommand = "claude -p --model claude-fable-5-2 --settings /tmp/ash-claude-settings-1.json <messages via stdin>";
const frozen = sessionContext({
  contextUsed: 143_746, contextWindow: 200_000, contextWindowEstimated: false,
  contextCompact: null, resumeArgs: frozenArgs, commandLine: frozenCommand,
});
assert.deepEqual(
  frozen,
  { used: 143_746, window: 200_000, windowEstimated: false, compactWindow: 600_000, compactPercent: 82.76 },
  "会话水位要带出起跑时真正注入的窗口与百分比",
);
assert.equal(contextCompactTrigger(frozen), 148_968, "不看执行器当前配置,也能算出这一轮 ~149k 就压");
assert.equal(
  contextCompactTrigger({ ...frozen!, compactMaxOutput: 10_000 }),
  Math.min(Math.floor((190_000 * 82.76) / 100), 177_000),
  "固化了输出预留就按它算",
);
assert.equal(
  contextCompactTrigger({ used: 1, window: 200_000, windowEstimated: false }),
  null,
  "没配压缩窗口时不编触发点",
);

// 解析器会顺手给内置 Monitor 记账,先把库建好。
const { db, ensureSchema } = await import("../src/db/index.js");
await ensureSchema();

// F1(第 2 轮):快照由产出水位的那一层带上。用一个假的 claude 可执行文件跑真实的执行器,
// 吐一帧 assistant + 一帧 result(原形会话的水位与自报窗口)。
const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { spawn } = await import("node:child_process");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { cliHostEnv } = await import("../src/executors/cli-env.js");
const fixtureDir = mkdtempSync(join(tmpdir(), "ash-context-1m-notice-"));
const frames = [
  { type: "assistant", message: { model: "claude-fable-5-2", content: [], usage: { input_tokens: 143_746, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  { type: "result", subtype: "success", is_error: false, session_id: "fixture-cli", modelUsage: { "claude-fable-5-2": { contextWindow: 200_000 } }, usage: { input_tokens: 143_746, output_tokens: 1 } },
].map((frame) => JSON.stringify(frame)).join("\n");
const fakeClaude = join(fixtureDir, "fake-claude");
writeFileSync(fakeClaude, `#!/bin/sh\ncat <<'EOF'\n${frames}\nEOF\n`);
chmodSync(fakeClaude, 0o755);
const contextOf = async (events: AsyncIterable<{ kind: string; context?: unknown }>) => {
  let found: unknown = null;
  for await (const event of events) if (event.kind === "context") found = event.context;
  return found as Parameters<typeof contextCompactTrigger>[0];
};

const launchOverrides = { autoCompactWindow: 600_000, autoCompactPercent: 80 };
const launched = new ClaudeExecutor({ model: "claude-fable-5-2", bin: fakeClaude, configOverrides: launchOverrides });
const expectedSnapshot = compactSnapshotFromEnv(cliConfigOverrideEnv("claude", launchOverrides, cliHostEnv(fixtureDir)));
assert.equal(expectedSnapshot.compactWindow, 600_000);
assert.ok(typeof expectedSnapshot.compactPercent === "number", "配了百分比,快照里就得有");

const liveRun = await contextOf(launched.run({ prompt: "hi", cwd: fixtureDir }).events);
assert.deepEqual(
  liveRun,
  { used: 143_746, window: 200_000, windowEstimated: false, ...expectedSnapshot },
  "普通起跑:实时水位带着整份启动快照(以前只带窗口,百分比缺了就按默认 167k 算)",
);
const liveSteer = await contextOf(launched.runSteerable({ prompt: "hi", cwd: fixtureDir }).events);
assert.deepEqual(liveSteer, liveRun, "可引导起跑跟普通起跑是同一份快照");
assert.deepEqual(launched.run({ prompt: "hi", cwd: fixtureDir }).launchCompact, expectedSnapshot, "句柄上带的就是水位上那份");

// 第 3 轮 F1:额外参数里自带 --settings 会整份盖掉 ash 那份,快照必须是「不知道」,不能发布
// 被盖掉的 600k / 82.76。profile 的额外参数、本次调用的额外参数,两处来源都算。
const overriding = `--settings {"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"100000","CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"50"}}`;
const shadowedByProfile = new ClaudeExecutor({
  model: "claude-fable-5-2", bin: fakeClaude, configOverrides: launchOverrides, extraArgs: [overriding],
});
const shadowedRun = shadowedByProfile.run({ prompt: "hi", cwd: fixtureDir });
assert.deepEqual(shadowedRun.launchCompact, { compactUnknown: true }, "profile 额外参数盖掉时,句柄上记的是不知道");
const shadowedContext = await contextOf(shadowedRun.events);
assert.deepEqual(
  shadowedContext,
  { used: 143_746, window: 200_000, windowEstimated: false, compactUnknown: true },
  "水位上不带被盖掉的压缩数,只标不知道",
);
assert.equal(contextCompactTrigger(shadowedContext), null, "不知道就不给触发点");
assert.equal(effectiveContextWindow(shadowedContext), 200_000, "按模型窗口显示");
assert.equal(clampedCompactWindow(shadowedContext?.compactWindow, shadowedContext?.window), null, "也就不会提示「没开 1M」");
const shadowedSteer = await contextOf(shadowedByProfile.runSteerable({ prompt: "hi", cwd: fixtureDir }).events);
assert.equal(shadowedSteer?.compactUnknown, true, "可引导起跑同一判据");
const shadowedByCall = await contextOf(launched.run({ prompt: "hi", cwd: fixtureDir, extraArgs: ["--settings", "{}"] }).events);
assert.equal(shadowedByCall?.compactUnknown, true, "本次调用的额外参数同样会盖掉");

// 接管:执行器此刻已经改成 100k,被接回的旧进程却是按 600k 起的。
const changed = new ClaudeExecutor({ model: "claude-fable-5-2", bin: fakeClaude, configOverrides: { autoCompactWindow: 100_000, autoCompactPercent: 80 } });
const attachChild = () => spawn(fakeClaude, [], { stdio: ["pipe", "pipe", "pipe"] });
const reattached = await contextOf(changed.attach(attachChild(), {
  sessionId: "fixture-cli",
  commandLine: "claude -p --model claude-fable-5-2 <prompt via stdin>",
  compact: sessionCompactSnapshot(frozenArgs),
}).events);
assert.equal(reattached?.compactWindow, 600_000, "接管用会话存下的那份,不是此刻的执行器配置");
assert.equal(contextCompactTrigger(reattached), 148_968, "接管后的触发点跟起跑时一致");
const residentReattached = await contextOf(changed.attach(attachChild(), {
  sessionId: "fixture-cli",
  commandLine: "claude -p --input-format stream-json --model claude-fable-5-2 <messages via stdin>",
  compact: sessionCompactSnapshot(frozenArgs),
}).events);
assert.equal(residentReattached?.compactWindow, 600_000, "可引导流的接管同样用旧快照");
const unknown = await contextOf(changed.attach(attachChild(), { sessionId: "fixture-cli", commandLine: "claude -p" }).events);
assert.equal(unknown?.compactWindow, undefined, "不知道旧快照就不带,不拿当前配置去补");

// 接管读的是起跑时随 commandLine 一起落下的那份(launchFields),不是 resume_args 反推:
// resume_args 里只有 ash 自己那份 --settings,看不出它被额外参数盖掉了。
const shadowedLaunch = launchFields(shadowedRun);
assert.equal(shadowedLaunch.commandLine, shadowedRun.commandLine);
const shadowedReattached = await contextOf(changed.attach(attachChild(), {
  sessionId: "fixture-cli",
  commandLine: shadowedRun.commandLine,
  compact: sessionLaunchCompact({ launchCompact: shadowedLaunch.launchCompact, resumeArgs: frozenArgs, commandLine: shadowedRun.commandLine }),
}).events);
assert.equal(shadowedReattached?.compactUnknown, true, "起跑时被盖掉的,接管后也还是不知道");
assert.equal(shadowedReattached?.compactWindow, undefined);
assert.deepEqual(
  sessionLaunchCompact({ launchCompact: launchFields(launched.run({ prompt: "hi", cwd: fixtureDir })).launchCompact, resumeArgs: null, commandLine: null }),
  expectedSnapshot,
  "正常起跑的那份原样读回",
);
assert.equal(
  sessionLaunchCompact({ launchCompact: null, resumeArgs: frozenArgs, commandLine: frozenCommand }).compactWindow,
  600_000,
  "这一列上线前起的进程才退回 resume_args,且命令行证明只有 ash 那份 --settings",
);

// 第 4 轮:升级前起的进程,额外参数里另带了 --settings(命令行里两份)—— resume_args 只有
// ash 那份,证明不了它生效,接管与重读都必须是「不知道」,不能退回 600k / ~149k。
const legacyShadowed = { launchCompact: null, contextCompact: null, resumeArgs: frozenArgs, commandLine: shadowedRun.commandLine };
assert.ok(shadowedRun.commandLine.split("--settings").length > 2, "夹具:命令行里确实有两份 --settings");
assert.deepEqual(sessionLaunchCompact(legacyShadowed), { compactUnknown: true }, "老行接管:证明不了就是不知道");
const legacyReattached = await contextOf(changed.attach(attachChild(), {
  sessionId: "fixture-cli",
  commandLine: shadowedRun.commandLine,
  compact: sessionLaunchCompact(legacyShadowed),
}).events);
assert.equal(contextCompactTrigger(legacyReattached), null, "老行接管后不再报 ~149k");
assert.equal(legacyReattached?.compactUnknown, true);
assert.deepEqual(
  sessionContext({ contextUsed: 143_746, contextWindow: 200_000, contextWindowEstimated: false, ...legacyShadowed }),
  { used: 143_746, window: 200_000, windowEstimated: false, compactUnknown: true },
  "老行水位重读走同一道判定",
);
assert.deepEqual(
  sessionLaunchCompact({ launchCompact: null, resumeArgs: frozenArgs, commandLine: null }),
  { compactUnknown: true },
  "老行连命令行都没有:同样证明不了",
);
assert.deepEqual(
  sessionLaunchCompact({ launchCompact: null, resumeArgs: null, commandLine: shadowedRun.commandLine }),
  {},
  "ash 根本没注入压缩窗口:没有可说的,不标不知道",
);

// ── ④ 一键开启端点 ────────────────────────────────────────────────────────
const { llmProviders } = await import("../src/db/schema.js");
const { api } = await import("../src/routes.js");
await db.insert(llmProviders).values([
  {
    id: "anthropic-1",
    name: "nm-ccb",
    protocol: "anthropic",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    model: "claude-opus-5-5",
    context1mModels: JSON.stringify(["claude-opus-5-5"]),
    createdAt: new Date().toISOString(),
  },
  {
    id: "openai-1",
    name: "cpa",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    model: "gpt-5.5",
    createdAt: new Date().toISOString(),
  },
]);

const enable = async (providerId: string, body: unknown, raw?: string) => {
  const res = await api.fetch(new Request(`http://127.0.0.1/llm-providers/${providerId}/context-1m-models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as { context1mModels?: string[]; error?: string } };
};

// 落库:快照跟水位同一笔存。之后会话又按新配置起跑(resume_args 被改写成 100k),
// 库里那份水位仍是旧进程报的,重读出来必须还是旧进程的快照 —— 跟实时那份一致。
const { sessions } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
await db.insert(sessions).values({
  id: "sess-1", taskId: "task-1", role: "single", agentType: "claude", executor: "claude@test",
  startedAt: new Date().toISOString(), resumeArgs: frozenArgs,
});
await setSessionContext("sess-1", liveRun!);
await db.update(sessions)
  .set({ resumeArgs: frozenArgs.replace('"600000"', '"100000"') })
  .where(eq(sessions.id, "sess-1"));
const [sessRow] = await db.select().from(sessions).where(eq(sessions.id, "sess-1"));
assert.deepEqual(sessionContext(sessRow!), liveRun, "库里重读 = 实时那份,不随 resume_args 改写而变");

const first = await enable("anthropic-1", { model: "claude-fable-5-2[1m]" });
assert.equal(first.status, 200, JSON.stringify(first.body));
assert.deepEqual(first.body.context1mModels, ["claude-opus-5-5", "claude-fable-5-2"], "追加在原列表后面,去掉 [1m] 后缀");
const again = await enable("anthropic-1", { model: "claude-fable-5-2" });
assert.deepEqual(again.body.context1mModels, ["claude-opus-5-5", "claude-fable-5-2"], "重复开启是幂等的");
// 两处入口并发点:各自追加,谁也不冲掉谁(读-改-写整份 PATCH 会丢一条)。
await Promise.all([
  enable("anthropic-1", { model: "claude-sonnet-5" }),
  enable("anthropic-1", { model: "claude-fable-5-1" }),
]);
const [row] = await db.select().from(llmProviders).where((await import("drizzle-orm")).eq(llmProviders.id, "anthropic-1"));
assert.deepEqual(
  new Set(JSON.parse(row!.context1mModels)),
  new Set(["claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5", "claude-fable-5-1"]),
  "并发开启两个模型,两个都在",
);

assert.equal((await enable("openai-1", { model: "gpt-5.5" })).status, 400, "openai 协议的供应商拒绝");
assert.equal((await enable("anthropic-1", { model: "  " })).status, 400, "空模型名拒绝");
assert.equal((await enable("anthropic-1", null)).status, 400, "JSON null 是 400,不是 500");
assert.equal((await enable("anthropic-1", ["claude-opus-5"])).status, 400, "数组不是请求体该有的形状");
assert.equal((await enable("anthropic-1", undefined, "{not json")).status, 400, "坏 JSON 400");
assert.equal((await enable("missing", { model: "claude-opus-5" })).status, 404, "不存在的供应商 404");

rmSync(process.env.ASH_DB!, { force: true });
rmSync(fixtureDir, { recursive: true, force: true });
console.log("test-context-1m-notice: ok");
process.exit(0);
