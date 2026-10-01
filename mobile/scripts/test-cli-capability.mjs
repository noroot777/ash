// 手机端「智能水平档位目录什么时候取」。跑：cd mobile && npm run test:cli-capability
// （mobile 不是 npm workspace 成员，自己一套 node_modules，所以不走 `npm -w`。）
//
// 钉的是 2026-10-01 第 1 轮审查那条问题 2:档位目录原先**只在用户点开模型选择器时**才
// 取。于是一个 opencode + `anthropic/claude-opus-4-8` + `low` 的任务,打开验证设置时
// 整片变红写着「不支持 low」—— 那一刻只能按内置规则判,而 `opencode:multimodel:anthropic`
// 这条规则只给 high/max,比 CLI 实际支持的窄。点开模型选择器再关掉、什么都不改,目录
// 到了,警告就消失 —— 用户看到的是「同一份配置忽好忽坏」。
//
// 真页面已经按报告的步骤复现并确认修好(独立无头 Chrome、430×932、临时后端:挂载即
// 发 1 次 `/api/agents/models?type=opencode`,警告消失;再在新建页换执行器类型,跟着
// 发出 `type=codex`)。这条测试把同一件事钉成不需要浏览器的回归:按组件 effect 的口径
// 喂事件序列,断言请求**发在显示之前**,而不是等用户去点。
import assert from "node:assert/strict";
import { fetchCliCapability, peekCliCapability, resetCliCapabilityCache } from "../src/lib/cliCapability.ts";
import { isReasoningEffortSupported, reasoningEffortsFor } from "@ash/shared/cli-presets";

const MODEL = "anthropic/claude-opus-4-8";
// server 那边真实返回过的形状(CLI 原话经 `cachedModelEfforts` 端出来)。
const CATALOG = {
  opencode: [{
    type: "opencode",
    models: [MODEL, "openai/gpt-5.6"],
    modelEfforts: { [MODEL]: ["low", "medium", "high", "xhigh", "max"] },
  }],
  codex: [{ type: "codex", models: ["gpt-5.6"], modelEfforts: { "gpt-5.6": ["medium", "high", "xhigh"] } }],
  // 没有可问的档位来源那一档:只有候选,没有 modelEfforts。
  gemini: [{ type: "gemini", models: ["gemini-3.1-pro-preview"] }],
};

/** 假的 `api.cliModels`,记下每一次真的发了请求。 */
function tracker(overrides = {}) {
  const calls = [];
  return {
    calls,
    fetch: (type) => {
      calls.push(type);
      if (overrides[type]) return overrides[type]();
      return Promise.resolve(CATALOG[type] ?? []);
    },
  };
}

/**
 * 把组件那条 effect 跑一遍:`[provider, selection.agentType]` 变化就取一次,挂了供应商
 * 就不取。返回这一屏**显示时**手里有的档位表。
 */
async function mount(api, { type, provider = false }) {
  if (provider) return undefined;
  const cap = await fetchCliCapability(type, api.fetch);
  return cap?.efforts;
}

// ── ① 挂载即取:不碰任何模型选择器 ─────────────────────────────────────────
{
  resetCliCapabilityCache();
  const api = tracker();
  const efforts = await mount(api, { type: "opencode" });
  assert.deepEqual(api.calls, ["opencode"], "首次挂载就该取一次目录，不能等用户点模型选择器");
  assert.ok(
    isReasoningEffortSupported("opencode", MODEL, "low", efforts),
    "拿到 CLI 原话之后，low 必须判成支持（这正是报告里那片红字）",
  );
  // 反向断言:没有目录时旧行为确实会把它判成不支持 —— 用例是判别性的,不是假绿。
  assert.equal(
    isReasoningEffortSupported("opencode", MODEL, "low", undefined),
    false,
    "内置规则本来就比 CLI 窄；这一条不成立说明用例选错了模型，测不出回归",
  );
  assert.ok(
    reasoningEffortsFor("opencode", MODEL, efforts).includes("low"),
    "sheet 里的候选也得用同一份依据，否则会出现「警告说不支持、候选里又选得着」",
  );
}

// ── ② 换执行器类型:跟着重取 ───────────────────────────────────────────────
{
  resetCliCapabilityCache();
  const api = tracker();
  await mount(api, { type: "opencode" });
  const codex = await mount(api, { type: "codex" });
  assert.deepEqual(api.calls, ["opencode", "codex"], "换了智能体类型必须重取，不能继续用上一个 CLI 的档位");
  assert.ok(
    !isReasoningEffortSupported("codex", "gpt-5.6", "low", codex),
    "codex 的 gpt-5.6 按它自己报的档位不含 low —— 换类型后不许沿用 opencode 那份",
  );
}

// ── ③ 同一类型并发只打一次 ───────────────────────────────────────────────
{
  resetCliCapabilityCache();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = tracker({ opencode: () => gate.then(() => CATALOG.opencode) });
  // 一个任务详情里「执行」和「验证」两个 ExecutionConfig 同时挂载。
  const both = Promise.all([
    fetchCliCapability("opencode", api.fetch),
    fetchCliCapability("opencode", api.fetch),
  ]);
  release();
  const [left, right] = await both;
  assert.deepEqual(api.calls, ["opencode"], "同一类型的并发取数要合并成一次请求");
  assert.equal(left, right, "两个挂载点该拿到同一份结果");
}

// ── ④ 命中缓存不再请求；失败不写缓存 ─────────────────────────────────────
{
  resetCliCapabilityCache();
  const api = tracker();
  await mount(api, { type: "opencode" });
  await mount(api, { type: "opencode" });
  assert.deepEqual(api.calls, ["opencode"], "缓存命中后不该再发请求");
  assert.ok(peekCliCapability("opencode"), "命中的那份要能被下一次挂载的首帧同步读到");

  resetCliCapabilityCache();
  const flaky = tracker({ opencode: () => Promise.reject(new Error("离线")) });
  assert.equal(await mount(flaky, { type: "opencode" }), undefined, "取不到就退回内置规则，不抛");
  assert.equal(peekCliCapability("opencode"), undefined, "失败不许写缓存，下次进来还要再试");
  await mount(flaky, { type: "opencode" });
  assert.deepEqual(flaky.calls, ["opencode", "opencode"], "上一次失败之后必须重试");
}

// ── ⑤ 挂了供应商那一档不取 ───────────────────────────────────────────────
{
  resetCliCapabilityCache();
  const api = tracker();
  assert.equal(await mount(api, { type: "opencode", provider: true }), undefined, "供应商档不读 CLI 档位表");
  assert.deepEqual(api.calls, [], "挂了供应商就不该白发这个请求");
}

// ── ⑥ 没有档位来源的 CLI:有候选但没有档位表,不许把它当成「没有档位」 ──────
{
  resetCliCapabilityCache();
  const api = tracker();
  const efforts = await mount(api, { type: "gemini" });
  assert.equal(efforts, undefined, "回答里没有 modelEfforts 就是「没有可问的来源」");
  assert.deepEqual(
    reasoningEffortsFor("gemini", "gemini-3.1-pro-preview", efforts),
    reasoningEffortsFor("gemini", "gemini-3.1-pro-preview"),
    "这一档必须与没接 probe 时逐字一致",
  );
}

console.log("✓ 档位目录在挂载时和换类型时都会取；并发合并、失败重试、供应商档不取");
