// CLI 模型清单探测(server/src/executors/model-probe.ts + 各 spec 的 models 解析器)的回归测试:
//   npm -w server run test:cli-models
//
// 钉住的是「刷新机制」这层的不变量,不是各家 CLI 到底有哪些模型(那随时会变,正是这套
// 机制存在的理由):
//   ① 解析器只认清单段落,抬头/提示语/表头不能被当成模型名;未登录那种输出解析成空数组
//      (空数组是**降级信号**,上层据此退回快照——解析器硬凑一个假模型才是灾难);
//   ② 去重保序 + CLI 报告的默认模型排首位;
//   ③ 每个 AgentType 都拿得到 catalog,Claude 文档及 spec.models 能力与按钮一致;
//   ④ 没有清单命令 / 没装 CLI 时诚实降级:source==="preset" 且 models 等于内置快照;
//   ⑤ 缓存命中不重复起子进程,force 会绕过缓存,降级结果比成功结果短命;
//   ⑥ 本机装了 grok / codex 时的**真实**探测(装了才断言,没装就跳过并说明——不拿本机环境当硬前提);
//   ⑦ 多人模式下**一次都不问宿主机 CLI**(§八),连自用模式下探到的缓存也不许端出来;
//   ⑧ per-model 档位的三条来源各自解析得对,且「不知道」与「没有档位」永远分得开。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TYPES } from "@ash/shared";
import { CLI_MODEL_PRESETS, CLI_MODEL_PROBE_TYPES } from "@ash/shared/cli-presets";
import { MULTI_USER_HOST_CLI_MODELS_HIDDEN } from "@ash/shared/multiuser";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

// ⑦ 要读实例模式(权威值在 app_settings 表里),所以这条测试也得自带临时库。
//
// 碰库的模块一律 **`await import`**,不能写成顶部的 `import`:那种写法会被提升到
// 下面这句赋值**之前**执行,`db/index.ts` 在模块求值时就解析并打开了 ASH_DB ——
// 于是测试连的是仓库默认的 `data/ash.db`,而 `requireTmpDb` 那道闸只看环境变量,
// 一个字都拦不住。上面留的静态 import 都不碰库(@ash/shared 是纯常量与解析器)。
const stage = mkdtempSync(join(tmpdir(), "ash-cli-models-"));
process.env.ASH_DB ||= join(stage, "cli-models.db");
requireTmpDb("test-cli-models");

const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { parseGrokModels } = await import("../src/executors/catalog/grok.js");
const { parseCodexModels } = await import("../src/executors/catalog/codex.js");
const { parsePiModels } = await import("../src/executors/catalog/pi.js");
const { parseClaudeModelInfos } = await import("../src/executors/claude-model-probe.js");
const { extractClaudeDocModels } = await import("../src/executors/claude-doc-models.js");
const { catalogTtlMs, modelCatalogFor, modelCatalogs, normalizeModelList, resetModelCatalogCache } =
  await import("../src/executors/model-probe.js");
const { probeBins } = await import("../src/executors/bin-probe.js");
const { ensureSchema } = await import("../src/db/index.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const { parseAppSettingsPatch, patchAppSettings } = await import("../src/app-settings.js");

assert.deepEqual(
  extractClaudeDocModels("claude-opus-4-6 claude-opus-4-6 claude-sonnet-4-6 claude-haiku-4-5-20251001 claude-platform-on-aws claude-opus-5-system-card"),
  ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  "Claude 官方文档:去重并滤掉非模型链接",
);
const originalFetch = globalThis.fetch;
let docsFetches = 0;
let docsFail = false;
globalThis.fetch = async () => {
  docsFetches += 1;
  return new Response(docsFail ? "unavailable" : "claude-opus-4-6 claude-sonnet-4-6", {
    status: docsFail ? 503 : 200,
  });
};

await ensureSchema();
assert.throws(() => parseAppSettingsPatch({ claudeModelRefreshHours: 0 }), /1~168/);
assert.throws(() => parseAppSettingsPatch({ claudeCustomModelIds: [""] }), /模型 ID/);

// ── ① 解析器:真实输出 ────────────────────────────────────────────────────
// 2026-08-13 本机 `grok models`(v1.0.3)的原样输出。
const GROK_REAL = `You are logged in with grok.com.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`;
{
  const parsed = parseGrokModels(GROK_REAL);
  assert.deepEqual(parsed.models, ["grok-4.6", "grok-4.5"], "grok:应只取清单段落里的模型 id");
  assert.equal(parsed.defaultModel, "grok-4.6", "grok:应认出 Default model 行");
  // 抬头里的 "grok.com" 长得很像模型名,是这个解析器最容易踩的坑。
  assert.ok(!parsed.models.includes("grok.com"), "grok:抬头的登录域名不能被当成模型");
}
{
  // 未登录:没有 Available models 段 → 空数组(降级信号),不是抛异常、也不是瞎猜。
  const parsed = parseGrokModels("You are not logged in. Run `grok login` first.\n");
  assert.deepEqual(parsed.models, [], "grok:未登录应解析成空数组,由上层降级到快照");
  assert.equal(parsed.defaultModel, null);
}
{
  // 段落后面还跟着别的抬头时,条目段要在第一个非条目行处收口。
  const parsed = parseGrokModels("Available models:\n  * a\n  - b\nOther section:\n  * c\n");
  assert.deepEqual(parsed.models, ["a", "b"], "grok:条目段应在非条目行处结束");
}
{
  // ANSI 色码是 CLI 输出的常态(它并不总是判断 TTY),不能因此漏掉模型。
  const parsed = parseGrokModels("Available models:\n  * [32mgrok-4.6[0m (default)\n");
  assert.deepEqual(parsed.models, ["grok-4.6"], "grok:带色码的输出也要能解析");
}

// `codex debug models` 是 JSON:字段齐全但混着 codex 自己都不列的内部模型。
// 这段是 0.153.4 实测输出的**结构**裁剪版(每个模型真身还带 500KB 的 prompt 模板)。
const CODEX_REAL = JSON.stringify({
  models: [
    { slug: "gpt-5.5", visibility: "list", priority: 12 },
    { slug: "gpt-6-astra", visibility: "list", priority: 1 },
    { slug: "gpt-daybreak-blue-latest", visibility: "hide", priority: 10 },
    { slug: "codex-auto-review", visibility: "hide", priority: 43 },
    { slug: "gpt-5.6-sol", visibility: "list", priority: 6 },
  ],
});
{
  const parsed = parseCodexModels(CODEX_REAL);
  assert.deepEqual(
    parsed.models,
    ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5"],
    "codex:按 priority 升序,且 visibility=hide 的内部模型不进候选",
  );
  // codex 的目录里没有「默认模型」字段(实际默认还受 ~/.codex/config.toml 影响),
  // 不许拿 priority 最小的那个冒充 —— 界面会据此打「CLI 默认」标记。
  assert.equal(parsed.defaultModel, null, "codex:没有默认模型字段就必须报 null");
}
{
  // 升级提示之类会印在 JSON 前面,从第一个 `{` 截起才解析得动。
  const parsed = parseCodexModels(`A new version of codex is available!\n${CODEX_REAL}`);
  assert.equal(parsed.models[0], "gpt-6-astra", "codex:JSON 前面的噪音行不能让解析失败");
}
{
  assert.deepEqual(parseCodexModels("command not found").models, [], "codex:非 JSON 输出解析成空数组");
  assert.deepEqual(parseCodexModels('{"models":"nope"}').models, [], "codex:models 不是数组时不许硬凑");
  assert.deepEqual(parseCodexModels("{}").models, [], "codex:缺 models 字段解析成空数组");
}
{
  // 老版本 CLI 还没有 visibility/priority 字段时,少列一个真实模型比多列一个内部代号更糟。
  const parsed = parseCodexModels(JSON.stringify({ models: [{ slug: "gpt-x" }, { slug: "gpt-y" }] }));
  assert.deepEqual(parsed.models, ["gpt-x", "gpt-y"], "codex:字段缺失时按可见处理并保持原序");
}

{
  // 2026-08-13 本机 `pi --list-models` 的原样形状:空格对齐的六列表格,首行是表头。
  const parsed = parsePiModels(
    [
      "provider   model                       context  max-out  thinking  images",
      "anthropic  claude-opus-5               1M       128K     yes       yes   ",
      "openai     gpt-5.2                     400K     128K     yes       yes   ",
      "",
    ].join("\n"),
  );
  assert.deepEqual(parsed.models, ["anthropic/claude-opus-5", "openai/gpt-5.2"], "pi:前两列应拼成 provider/model");
  assert.ok(!parsed.models.some((m) => m.startsWith("provider/")), "pi:表头行不能被当成模型");
}
assert.deepEqual(parsePiModels("").models, [], "pi:空输出解析成空数组");

// ── ② 去重保序 + 默认模型排首位 ─────────────────────────────────────────
assert.deepEqual(
  normalizeModelList(["b", "a", "b", " a ", ""], null),
  ["b", "a"],
  "去重后应保持 CLI 报的顺序(默认/推荐档常在前)",
);
assert.deepEqual(
  normalizeModelList(["old", "new"], "new"),
  ["new", "old"],
  "CLI 报告的默认模型应排到候选首位",
);
assert.deepEqual(
  normalizeModelList(["a", "b"], "不在清单里的"),
  ["a", "b"],
  "默认模型不在清单里就别硬塞进去",
);

// ── ③④ 每个类型都拿得到 catalog,不支持/没装的诚实降级 ────────────────────
// 前端首帧画不画「刷新」按钮读的是 shared 里手抄的 CLI_MODEL_PROBE_TYPES(那时服务端
// 还没回话),两份不一致的后果是「新加了能查清单的 CLI,按钮却要等接口回来才出现」——
// 这正是 86a3f06 修过一次的症状,所以在这里钉死。
assert.deepEqual(
  [...CLI_MODEL_PROBE_TYPES].sort(),
  AGENT_TYPES.filter((type) => type === "claude" || !!CLI_SPEC_BY_KEY[type].models).sort(),
  "CLI_MODEL_PROBE_TYPES 必须与可刷新来源一致(前端首帧据它画刷新按钮)",
);
resetModelCatalogCache();
const all = await modelCatalogs();
assert.equal(all.length, AGENT_TYPES.length, "每个 AgentType 都要有一条 catalog");
for (const catalog of all) {
  const spec = CLI_SPEC_BY_KEY[catalog.type];
  assert.equal(
    catalog.probeSupported,
    catalog.type === "claude" || !!spec.models,
    `${catalog.type}:probeSupported 必须跟可刷新来源一致(界面据此决定要不要给刷新按钮)`,
  );
  if (!spec.models && catalog.type !== "claude") {
    assert.equal(catalog.source, "preset", `${catalog.type}:没有清单命令时只可能是快照`);
    assert.deepEqual(
      [...catalog.models],
      [...CLI_MODEL_PRESETS[catalog.type]],
      `${catalog.type}:降级时应原样给出内置快照`,
    );
    assert.equal(catalog.probedAt, null, `${catalog.type}:没探过就不该有探测时刻`);
  }
  if (catalog.source === "probe") {
    assert.ok(catalog.models.length > 0, `${catalog.type}:探测成功却给空清单是不允许的`);
    assert.ok(catalog.probedAt, `${catalog.type}:探测成功必须带时刻`);
    assert.equal(catalog.error, null, `${catalog.type}:探测成功不该带错误`);
  }
}
const claudeDocs = all.find((catalog) => catalog.type === "claude")!;
assert.equal(claudeDocs.source, "docs", "Claude 官方账号应从文档取完整模型 ID");
assert.ok(claudeDocs.probedAt);
assert.equal(claudeDocs.error, null);
assert.ok(claudeDocs.models.includes("claude-opus-4-6"));
assert.ok(claudeDocs.models.includes("opus"), "文档 ID 不应盖掉 CLI 别名");
assert.equal(docsFetches, 1);
assert.equal(await modelCatalogFor("claude"), claudeDocs, "Claude 文档结果应命中缓存");
await patchAppSettings({ claudeModelRefreshHours: 12, claudeCustomModelIds: ["claude-opus-9-9"] });
const configuredDocs = await modelCatalogFor("claude");
assert.equal(configuredDocs.source, "docs", "设置变化后缓存必须失效");
assert.ok(configuredDocs.models.includes("claude-opus-9-9"), "手填列表要进候选");
assert.equal(configuredDocs.refreshIntervalHours, 12);
assert.equal(catalogTtlMs(configuredDocs, 12), 12 * 60 * 60 * 1000);
assert.equal(docsFetches, 2, "保存配置后应该重新获取官方目录");
docsFail = true;
const docsFallback = await modelCatalogFor("claude", true);
assert.equal(docsFallback.source, "preset", "文档不可用时应回退内置别名");
assert.match(docsFallback.error ?? "", /HTTP 503/);
assert.ok(docsFallback.models.includes("claude-opus-9-9"), "文档失败也要保留手填模型");
docsFail = false;
assert.equal((await modelCatalogFor("claude", true)).source, "docs", "手动刷新应恢复文档清单");
assert.ok(catalogTtlMs(docsFallback) < catalogTtlMs(claudeDocs), "文档失败的兜底应尽快重试");

// ── ⑤ 缓存 ───────────────────────────────────────────────────────────────
{
  resetModelCatalogCache();
  const first = await modelCatalogFor("grok");
  const second = await modelCatalogFor("grok");
  assert.equal(first, second, "缓存命中应返回同一份结果,而不是再起一次子进程");
  // 并发去重:三个选择器同时打开只该探一次。
  resetModelCatalogCache();
  const [a, b, c] = await Promise.all([modelCatalogFor("grok"), modelCatalogFor("grok"), modelCatalogFor("grok")]);
  assert.equal(a, b, "并发请求应合并成一次探测");
  assert.equal(b, c, "并发请求应合并成一次探测");
  const forced = await modelCatalogFor("grok", true);
  assert.notEqual(forced, a, "force 必须绕过缓存重新探测(这就是「刷新」按钮)");
  // 光看「换了个对象」证不了什么(每次探测本来就新建对象);要紧的是**结果写回了缓存**,
  // 否则刷新只对点它的那一次可见,下一个打开选择器的人又拿到旧的。
  assert.equal(await modelCatalogFor("grok"), forced, "force 的结果必须成为新的缓存值");
}

// ── ⑤b 陈旧探测不许覆盖新结果 ────────────────────────────────────────────
// 用户点刷新时,先前那次探测可能还卡在 10s 超时上;它结算得更晚,若照写缓存就会把
// 刚刷出来的实时清单盖回快照 —— 界面无缘无故退回旧值,看着像「刷新按钮没用」。
// 这里不去制造真实竞态(时序不可控),而是直接钉住那条规则:**只有当前那次探测有权
// 写缓存**。resetModelCatalogCache() 清掉 inflight,等价于「这次已经不是当前那次了」。
{
  resetModelCatalogCache();
  const stale = modelCatalogFor("grok");
  resetModelCatalogCache();
  const staleResult = await stale;
  const next = await modelCatalogFor("grok");
  assert.notEqual(next, staleResult, "已被顶掉的探测不该把结果写进缓存");
}

// ── ⑤c 降级结果不许和成功结果一样保鲜 ────────────────────────────────────
// 一次超时/抖动若按成功那档缓存,内置快照就钉住半天;界面只写「内置清单」,用户没
// 理由知道该去点刷新。没有清单命令的 CLI 是另一回事:重探不会有新结果,别反复问。
{
  const presetShape = {
    type: "grok" as const,
    models: ["grok-4.6"],
    defaultModel: null,
    available: false,
    probedAt: null,
    cliVersion: null,
    error: null,
  };
  const ok = { ...presetShape, source: "probe" as const, probeSupported: true, skipped: null };
  const failed = { ...presetShape, source: "preset" as const, probeSupported: true, skipped: null };
  const noCommand = { ...presetShape, source: "preset" as const, probeSupported: false, skipped: null };
  assert.ok(catalogTtlMs(failed) < catalogTtlMs(ok), "探测失败的缓存必须比成功的短命");
  assert.equal(catalogTtlMs(noCommand), catalogTtlMs(ok), "没有清单命令的 CLI 不该被反复重探");
}

// ── ⑥ 本机真实探测(装了才断言) ────────────────────────────────────────
{
  const grok = CLI_SPEC_BY_KEY.grok;
  const installed = await probeBins(grok.bins, grok.fallbackVersionMatch);
  if (!installed) {
    console.log("· 本机没装 grok,跳过真实探测断言(机制本身已由上面几条覆盖)");
  } else {
    const catalog = await modelCatalogFor("grok", true);
    assert.ok(catalog.available, "探到了 bin 就该报 available");
    if (catalog.source === "probe") {
      assert.ok(catalog.models.length > 0, "grok 探测成功应给出非空清单");
      console.log(`· grok ${catalog.cliVersion ?? "?"} 实探:${catalog.models.join(", ")}`);
    } else {
      // 没登录也是合法状态 —— 但必须说清楚为什么退回快照,不许装作实时目录。
      assert.ok(catalog.error, "探测失败必须带上原因,否则界面只能显示一个假的实时清单");
      console.log(`· grok 装着但没探到清单(${catalog.error}),已降级到快照 —— 符合预期`);
    }
  }
}

{
  const codex = CLI_SPEC_BY_KEY.codex;
  const installed = await probeBins(codex.bins, codex.fallbackVersionMatch);
  if (!installed) {
    console.log("· 本机没装 codex,跳过真实探测断言(机制本身已由上面几条覆盖)");
  } else {
    const catalog = await modelCatalogFor("codex", true);
    assert.ok(catalog.available, "探到了 bin 就该报 available");
    if (catalog.source === "probe") {
      assert.ok(catalog.models.length > 0, "codex 探测成功应给出非空清单");
      console.log(`· codex ${catalog.cliVersion ?? "?"} 实探:${catalog.models.join(", ")}`);
    } else {
      assert.ok(catalog.error, "探测失败必须带上原因,否则界面只能显示一个假的实时清单");
      console.log(`· codex 装着但没探到清单(${catalog.error}),已降级到快照 —— 符合预期`);
    }
  }
}

// ── ⑧ per-model 档位的三条来源 ───────────────────────────────────────────
// 2026-10-01 接上:模型清单本来就在现问 CLI,而 codex / claude / opencode 这三家**同一
// 份数据里**就带着每个模型允许哪些智能水平。钉住的是「解析得对 + 分得清不知道与没有」,
// 不是具体档位值(那随 CLI 版本变,正是不再手写它的理由)。
{
  // codex:`supported_reasoning_levels` 形状取自 0.153.4 实测输出。
  const codexOut = JSON.stringify({
    models: [
      {
        slug: "gpt-x-sol",
        priority: 1,
        supported_reasoning_levels: [
          { effort: "low", description: "快" },
          { effort: "max", description: "深" },
          { effort: "ultra", description: "最深 + 自动委派" },
        ],
      },
      // 同代里少一档的那个:一条前缀规则发同一套档位就会在这里露出来。
      { slug: "gpt-x-luna", priority: 2, supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] },
      // 老版本 CLI 没有这个字段 → 必须是「不知道」(缺 key),不能当成「没有档位」。
      { slug: "gpt-legacy", priority: 3 },
      // CLI 明确报空数组 → 那是答案:这个模型没有档位。
      { slug: "gpt-noeffort", priority: 4, supported_reasoning_levels: [] },
      // 字段还在但形状全变了 → 同样按「不知道」处理,别硬凑。
      { slug: "gpt-weird", priority: 5, supported_reasoning_levels: [{ level: "low" }] },
      // 隐藏模型不进候选,但档位要登记:profile 里钉着它的老配置仍要判得对。
      { slug: "gpt-hidden", priority: 6, visibility: "hide", supported_reasoning_levels: [{ effort: "high" }] },
      // 裸字符串数组:字段将来简化成这种也要接得住。
      { slug: "gpt-plain", priority: 7, supported_reasoning_levels: ["low", "LOW", "high"] },
    ],
  });
  const codex = parseCodexModels(codexOut);
  const efforts = codex.modelEfforts ?? {};
  assert.deepEqual(codex.models, ["gpt-x-sol", "gpt-x-luna", "gpt-legacy", "gpt-noeffort", "gpt-weird", "gpt-plain"]);
  assert.deepEqual(efforts["gpt-x-sol"], ["low", "max", "ultra"]);
  assert.deepEqual(efforts["gpt-x-luna"], ["low", "max"], "同代模型各报各的,不许共用一套");
  assert.equal("gpt-legacy" in efforts, false, "字段缺失 = 不知道,必须缺 key 而不是空数组");
  assert.deepEqual(efforts["gpt-noeffort"], [], "CLI 报空数组 = 这个模型没有档位");
  assert.equal("gpt-weird" in efforts, false, "形状变了要按不知道处理");
  assert.deepEqual(efforts["gpt-hidden"], ["high"], "隐藏模型的档位照样登记");
  assert.deepEqual(efforts["gpt-plain"], ["low", "high"], "裸字符串数组也接,并去重归一");
}

{
  // pi:只有 yes/no 一列,所以只做得了「没有档位」这半件事。
  const piOut = [
    "provider   model            context  max-out  thinking  images",
    "anthropic  claude-sonnet-5  1M       128K     yes       yes",
    "openai     gpt-legacy-4     128K     16K      no        yes",
  ].join("\n");
  const pi = parsePiModels(piOut);
  assert.deepEqual(pi.models, ["anthropic/claude-sonnet-5", "openai/gpt-legacy-4"]);
  assert.deepEqual(pi.modelEfforts, { "openai/gpt-legacy-4": [] }, "thinking=no 才登记(空集);yes 不等于支持全部 7 档");

  // 列序换了也要跟着走:按表头定位而不是写死下标。
  const moved = parsePiModels([
    "provider   model         thinking  context",
    "openai     gpt-legacy-4  no        128K",
  ].join("\n"));
  assert.deepEqual(moved.modelEfforts, { "openai/gpt-legacy-4": [] }, "thinking 列换位置后仍要读对");

  // 没有表头(格式大改)时不猜:宁可不给档位,也不能把隔壁列当 yes/no 读。
  const headless = parsePiModels("openai     gpt-legacy-4  no        128K");
  assert.equal(headless.modelEfforts, undefined, "读不到表头就不产出档位");
}

{
  // claude:control protocol 的 ModelInfo。haiku 那行**整个没有** supportsEffort 两个
  // 字段(2026-10-01 对 2.1.283 实测),这正是「字段缺失 = 不支持」的依据。
  const probe = parseClaudeModelInfos([
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5[1m]",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high", "max"],
    },
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
    // 说支持却没给清单 → 不知道,退回规则表,不能当成「没有档位」。
    { value: "mystery", resolvedModel: "claude-mystery-9", supportsEffort: true },
  ]);
  assert.ok(probe);
  assert.deepEqual(probe.models, ["sonnet", "haiku", "mystery"]);
  assert.deepEqual(probe.modelEfforts["sonnet"], ["low", "high", "max"], "别名要能查到");
  assert.deepEqual(probe.modelEfforts["claude-sonnet-5[1m]"], ["low", "high", "max"], "canonical id 也要");
  assert.deepEqual(probe.modelEfforts["claude-sonnet-5"], ["low", "high", "max"], "去掉上下文后缀的那个同样要");
  assert.deepEqual(probe.modelEfforts["haiku"], [], "没有 supportsEffort 字段 = 这个模型没有档位");
  assert.equal("mystery" in probe.modelEfforts, false, "说支持却没给清单时按不知道处理");
  assert.equal(parseClaudeModelInfos("not-an-array"), null, "形状不对要返回 null 让上层降级");
  assert.equal(parseClaudeModelInfos([]), null, "空清单等于没探到");
}

{
  // opencode/kilo:读它自己缓存的 models.dev 快照。这条来源弱一级,所以裁剪更严。
  const cacheRoot = mkdtempSync(join(stage, "xdg-"));
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(cacheRoot, "opencode"), { recursive: true });
  writeFileSync(join(cacheRoot, "opencode", "models.json"), JSON.stringify({
    anthropic: {
      models: {
        // `none` 不在 opencode 的 --variant 并集里 → 求交后丢掉,不引入新值。
        "claude-x": { reasoning_options: [{ type: "effort", values: ["none", "low", "max"] }] },
        // budget_tokens 不是 effort 档位 → 不登记(登记空数组等于替 opencode 断言「没档位」)。
        "claude-budget": { reasoning_options: [{ type: "budget_tokens", min: 1024 }] },
        // 全部落在并集之外 → 同样不登记,而不是登记一个空集。
        "claude-alien": { reasoning_options: [{ type: "effort", values: ["none", "off"] }] },
      },
    },
  }), "utf8");
  const prevXdg = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheRoot;
  try {
    const { readOpencodeModelEfforts } = await import("../src/executors/opencode-model-efforts.js");
    const map = await readOpencodeModelEfforts("opencode");
    assert.deepEqual(map["anthropic/claude-x"], ["low", "max"], "第三方数据只用来收窄并集,不引入 none 这种新值");
    assert.equal("anthropic/claude-budget" in map, false, "budget_tokens 型不是 effort 档位,不登记");
    assert.equal("anthropic/claude-alien" in map, false, "求交后为空也不登记(断言「无档位」没依据)");
    assert.deepEqual(await readOpencodeModelEfforts("grok"), {}, "没有这条来源的 CLI 返回空表");
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prevXdg;
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

// ⑧b 本机装了 codex / claude 就实探一次档位(装了才断言,同 ⑥ 的口径)。
{
  const codex = CLI_SPEC_BY_KEY.codex;
  if (await probeBins(codex.bins, codex.fallbackVersionMatch)) {
    const catalog = await modelCatalogFor("codex", true);
    if (catalog.source === "probe") {
      const probed = Object.keys(catalog.modelEfforts ?? {});
      assert.ok(probed.length > 0, "codex 探测成功时档位表不该是空的(它和清单同在一份输出里)");
      console.log(`· codex 实探档位 ${probed.length} 条,例:${probed[0]} → ${JSON.stringify(catalog.modelEfforts![probed[0]!])}`);
    }
  } else {
    console.log("· 本机没装 codex,跳过档位实探");
  }
}

{
  const claude = CLI_SPEC_BY_KEY.claude;
  const found = await probeBins(claude.bins, claude.fallbackVersionMatch);
  if (!found) {
    console.log("· 本机没装 claude,跳过 control 探针实测");
  } else {
    const { probeClaudeModels } = await import("../src/executors/claude-model-probe.js");
    const probe = await probeClaudeModels(found.path);
    if (!probe) {
      // 合法状态:没登录、settings 里配了认证(探针刻意不加载 settings)、或协议变了。
      console.log("· claude 装着但 control 探针没拿到 ModelInfo —— 档位退回规则表,符合降级预期");
    } else {
      assert.ok(probe.models.length > 0);
      assert.ok(Object.keys(probe.modelEfforts).length > 0, "拿到 ModelInfo 就该有档位表");
      console.log(`· claude 实探:${probe.models.join(", ")}`);
    }
  }
}

// ── ⑦ 多人模式:一次都不问宿主机 CLI ──────────────────────────────────────
// `grok models` 问的是宿主机那个登录账号,而 §八 要抹掉的就是它。原来这条端点谁登录
// 了都能打,server 用**自己进程的环境**(带着宿主的 XAI_API_KEY 之类)起一个 CLI 子
// 进程,再把宿主账号的模型清单端出来(第 2 轮审查 P1)。
//
// 这一组放在最后:setInstanceMode("multi") 之后就回不去自用模式了。
{
  // 先在自用模式下把结果探进缓存 —— 转多人之后它不许再被端出来(判据必须排在
  // 缓存**之前**,否则那份实时清单会在缓存里躺满 6 小时)。
  resetModelCatalogCache();
  const beforeSwitch = await modelCatalogFor("grok");
  assert.equal(beforeSwitch.skipped, null, "自用模式下不该有「没去问」这回事");

  await setInstanceMode("multi", join(stage, "root"));

  const grok = await modelCatalogFor("grok");
  assert.equal(grok.source, "preset", "多人模式下只能给内置快照");
  assert.equal(grok.skipped, MULTI_USER_HOST_CLI_MODELS_HIDDEN, "得说清楚是**没去问**,不是问失败了");
  assert.equal(grok.error, null, "没去问就不是失败:两个字段不能混着用");
  assert.deepEqual([...grok.models], [...CLI_MODEL_PRESETS.grok], "内容就是内置快照,一个字不多");
  assert.equal(grok.probedAt, null, "没探过就不该有探测时刻");
  assert.equal(grok.cliVersion, null, "连版本都不该问 —— 那也要起一次子进程");
  // force = 用户点刷新。它同样不许把子进程起起来。
  const forced = await modelCatalogFor("grok", true);
  assert.equal(forced.skipped, MULTI_USER_HOST_CLI_MODELS_HIDDEN, "刷新也不问");
  assert.equal(forced.source, "preset", "刷新也只有快照");
  // 整份清单端点同样如此,而不是只有单个 type 那条路被堵上。
  for (const catalog of await modelCatalogs()) {
    assert.equal(catalog.source, "preset", `${catalog.type}:多人模式下不该有探测结果`);
    // 「没去问」只挂在**本来就会去问**的那几家上;别的 CLI 两种模式下都是同一份快照,
    // 多挂一句说明只是噪音。
    assert.equal(
      catalog.skipped,
      CLI_MODEL_PROBE_TYPES.has(catalog.type) ? MULTI_USER_HOST_CLI_MODELS_HIDDEN : null,
      `${catalog.type}:「没去问」这句话只该出现在有清单命令的 CLI 上`,
    );
    assert.equal(catalog.available, false, `${catalog.type}:连装没装都不该去问(那也要起子进程)`);
  }
}

console.log("cli-models 回归测试通过");
globalThis.fetch = originalFetch;
await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
