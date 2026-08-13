// CLI 模型清单探测(server/src/executors/model-probe.ts + 各 spec 的 models 解析器)的回归测试:
//   npm -w server run test:cli-models
//
// 钉住的是「刷新机制」这层的不变量,不是各家 CLI 到底有哪些模型(那随时会变,正是这套
// 机制存在的理由):
//   ① 解析器只认清单段落,抬头/提示语/表头不能被当成模型名;未登录那种输出解析成空数组
//      (空数组是**降级信号**,上层据此退回快照——解析器硬凑一个假模型才是灾难);
//   ② 去重保序 + CLI 报告的默认模型排首位;
//   ③ 每个 AgentType 都拿得到 catalog,`probeSupported` 与 spec.models 严格一致;
//   ④ 没有清单命令 / 没装 CLI 时诚实降级:source==="preset" 且 models 等于内置快照;
//   ⑤ 缓存命中不重复起子进程,force 会绕过缓存,降级结果比成功结果短命;
//   ⑥ 本机装了 grok 时的**真实**探测(装了才断言,没装就跳过并说明——不拿本机环境当硬前提)。
import assert from "node:assert/strict";
import { AGENT_TYPES } from "@harness/shared";
import { CLI_MODEL_PRESETS, CLI_MODEL_PROBE_TYPES } from "@harness/shared/cli-presets";
import { CLI_SPEC_BY_KEY } from "../src/executors/catalog/index.js";
import { parseGrokModels } from "../src/executors/catalog/grok.js";
import { parsePiModels } from "../src/executors/catalog/pi.js";
import { catalogTtlMs, modelCatalogFor, modelCatalogs, normalizeModelList, resetModelCatalogCache } from "../src/executors/model-probe.js";
import { probeBins } from "../src/executors/bin-probe.js";

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
  AGENT_TYPES.filter((type) => !!CLI_SPEC_BY_KEY[type].models).sort(),
  "CLI_MODEL_PROBE_TYPES 必须与填了 spec.models 的 type 完全一致(前端首帧据它画刷新按钮)",
);
resetModelCatalogCache();
const all = await modelCatalogs();
assert.equal(all.length, AGENT_TYPES.length, "每个 AgentType 都要有一条 catalog");
for (const catalog of all) {
  const spec = CLI_SPEC_BY_KEY[catalog.type];
  assert.equal(
    catalog.probeSupported,
    !!spec.models,
    `${catalog.type}:probeSupported 必须跟 spec.models 一致(界面据此决定要不要给刷新按钮)`,
  );
  if (!spec.models) {
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
  const ok = { ...presetShape, source: "probe" as const, probeSupported: true };
  const failed = { ...presetShape, source: "preset" as const, probeSupported: true };
  const noCommand = { ...presetShape, source: "preset" as const, probeSupported: false };
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

console.log("cli-models 回归测试通过");
