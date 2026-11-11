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
// 跑法:ASH_DB=/tmp/test-context-1m-notice-$RANDOM.db npx tsx server/scripts/test-context-1m-notice.ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { requireTmpDb } from "./tmp-db.js";

requireTmpDb("test-context-1m-notice");

const { claudeModelWindow, clampedCompactWindow, CLAUDE_1M_WINDOW, CLAUDE_STANDARD_WINDOW } =
  await import("@ash/shared/context-1m");
const { claudeCompactionPlan, cliConfigOverrideEnv, cliConfigOverrideHints } = await import("@ash/shared/cli-overrides");
const { effectiveContextWindow, contextRatio } = await import("@ash/shared/usage");

// ── ① 判定 ────────────────────────────────────────────────────────────────
const relay = {
  id: "p1",
  name: "nm-ccb",
  protocol: "anthropic" as const,
  model: "claude-opus-5-5",
  context1mModels: ["claude-opus-5-5"],
};

assert.deepEqual(
  claudeModelWindow("claude-fable-5-2", relay),
  { model: "claude-fable-5-2", window: CLAUDE_STANDARD_WINDOW, provider: { id: "p1", name: "nm-ccb" } },
  "没在 1M 列表里的模型按 200k 算,并且给出能一键开启的那家供应商",
);
assert.equal(claudeModelWindow("claude-opus-5-5", relay)?.window, CLAUDE_1M_WINDOW, "列表里的按 1M 算");
assert.equal(claudeModelWindow("", relay)?.model, "claude-opus-5-5", "模型留空 = 跟随供应商默认模型");
assert.equal(claudeModelWindow("claude-opus-5-5[1m]", null)?.window, CLAUDE_1M_WINDOW, "官方账号带 [1m] 后缀就是 1M");
assert.equal(claudeModelWindow("claude-opus-5-5[1m]", null)?.model, "claude-opus-5-5", "判定结果里的模型名去掉后缀");
assert.equal(claudeModelWindow("claude-opus-5-5", null)?.provider, null, "官方账号没有能一键开启的供应商");
assert.equal(claudeModelWindow(null, null), null, "官方账号又没指定模型:判不出来,不猜");
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

// ── ④ 一键开启端点 ────────────────────────────────────────────────────────
const { db, ensureSchema } = await import("../src/db/index.js");
const { llmProviders } = await import("../src/db/schema.js");
const { api } = await import("../src/routes.js");
await ensureSchema();
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

const enable = async (providerId: string, body: unknown) => {
  const res = await api.fetch(new Request(`http://127.0.0.1/llm-providers/${providerId}/context-1m-models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as { context1mModels?: string[]; error?: string } };
};

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
assert.equal((await enable("missing", { model: "claude-opus-5" })).status, 404, "不存在的供应商 404");

rmSync(process.env.ASH_DB!, { force: true });
console.log("test-context-1m-notice: ok");
process.exit(0);
