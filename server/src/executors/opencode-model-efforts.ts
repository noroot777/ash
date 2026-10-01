// opencode / kilo 的 per-model 档位:读**它们自己缓存的那份 models.dev 快照**。
//
// 这两家的模型是 `provider/model`,`--variant`(describe:"provider-specific reasoning
// effort")能给什么由 provider 决定,而 opencode 的模型 id 本来就取自 models.dev —— 那份
// 数据带 `reasoning_options`,形如 `[{type:"effort", values:["low","medium","high"]}]`。
// 实测本机 `~/.cache/opencode/models.json`(4.1MB,203 个 provider)里:
//   anthropic/claude-opus-4-8  → effort ["low","medium","high","xhigh","max"]
//   google/gemini-3-pro-image  → effort ["low","high"]
//   openai/gpt-5.5-pro         → effort ["medium","high","xhigh"]
//   anthropic/claude-haiku-4-5 → budget_tokens(不是 effort 档位,见下)
//
// **它比 codex/claude 那两条弱一级,所以裁剪更保守**(见 shared 的 ModelEffortMap 注释):
//  ① 只认 `type === "effort"`。`budget_tokens` 说的是「用 token 预算表达思考深度」,
//     跟 `--variant` 收什么值不是一回事 —— 登记成空数组等于替 opencode 断言「这个模型
//     没有档位」,没有依据,所以**不登记**,退回规则表。
//  ② 登记前与 CLI 并集**求交**:models.dev 的 `none`/`off` 这些值 `--variant` 认不认
//     没有出处。第三方数据只用来**收窄**已知并集,不引入新值。
//  ③ 求交后为空也不登记:那说明这个模型的档位全在并集之外,断言「无档位」同样没依据。
//
// 不落库、不联网:只读它已经下载好的那份文件。opencode 没装 / 没跑过 / 文件格式变了,
// 一律返回空表,档位退回 `MODEL_EFFORT_RULES` —— 跟这个文件不存在时一模一样。

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentType } from "@ash/shared";
import { CLI_MODEL_PRESETS, REASONING_EFFORT_VALUES, modelEffortKey } from "@ash/shared/cli-presets";
import type { ModelEffortMap } from "@ash/shared/cli-presets";

/** 4MB 上下是常态;上限只防「文件被别的东西写成了几百 MB」这种意外。 */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * 缓存文件路径。**kilo 那条是按 fork 惯例推的**(它沿用 opencode 的 `provider/model` 与
 * `--variant`,缓存目录大概率同构),本机没装 kilo,**未实测**。推错的代价是读不到文件 →
 * 空表 → 退回规则表,与不接这一条完全等价,所以宁可推一下。
 */
function cachePaths(type: AgentType): string[] {
  const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  if (type === "opencode") return [join(base, "opencode", "models.json")];
  if (type === "kilo") return [join(base, "kilo", "models.json"), join(base, "kilocode", "models.json")];
  return [];
}

interface ModelsDevEntry {
  reasoning_options?: unknown;
}

/**
 * 只保留**这个 CLI 的候选模型涉及到的 provider**。
 *
 * 为什么必须收窄:本机那份 models.dev 快照有 149 个 provider、2657 个带 effort 的模型,
 * 整份端出来是 **143KB**,而 `GET /api/agents/models` 不带 type 时会把 opencode 和 kilo
 * 的两份一起返回 —— 为了几个用得上的模型让每个开选择器的人多下载近 300KB,不值。那
 * 149 家里绝大多数是用户压根没认证的第三方聚合站(deepinfra / poe / sensenova …)。
 *
 * 保留的粒度是 **provider 而不是模型**:候选里只写了 `anthropic/claude-opus-4-8`,但
 * 用户手填 `anthropic/claude-opus-4-5` 同样该拿到 probe 数据 —— 同一家 provider 下的
 * 模型是一起认证、一起可用的。
 *
 * 收窄之外的 provider 退回 `MODEL_EFFORT_RULES`,与接这条来源之前完全一样,不是退步。
 */
function candidateProviders(type: AgentType): ReadonlySet<string> {
  const providers = new Set<string>();
  for (const model of CLI_MODEL_PRESETS[type] ?? []) {
    const slash = model.indexOf("/");
    if (slash > 0) providers.add(model.slice(0, slash).trim().toLowerCase());
  }
  return providers;
}

/** `reasoning_options` → effort 档位名;不是 effort 型就返回 null(「这里没有答案」)。 */
function effortValues(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  for (const option of raw) {
    const entry = option as { type?: unknown; values?: unknown } | null;
    if (entry?.type !== "effort" || !Array.isArray(entry.values)) continue;
    const values = entry.values
      .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
      .filter((value, index, all) => value && all.indexOf(value) === index);
    if (values.length) return values;
  }
  return null;
}

export async function readOpencodeModelEfforts(type: AgentType): Promise<ModelEffortMap> {
  const allowed = new Set(REASONING_EFFORT_VALUES[type] ?? []);
  const providers = candidateProviders(type);
  if (!allowed.size || !providers.size) return {};
  for (const path of cachePaths(type)) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, { models?: Record<string, ModelsDevEntry> }>;
      if (!parsed || typeof parsed !== "object") continue;
      const efforts: Record<string, readonly string[]> = {};
      for (const [provider, bundle] of Object.entries(parsed)) {
        if (!providers.has(provider.trim().toLowerCase())) continue;
        const models = bundle?.models;
        if (!models || typeof models !== "object") continue;
        for (const [id, entry] of Object.entries(models)) {
          const values = effortValues(entry?.reasoning_options);
          if (!values) continue;
          const narrowed = values.filter((value) => allowed.has(value));
          if (!narrowed.length) continue;
          efforts[modelEffortKey(`${provider}/${id}`)] = narrowed;
        }
      }
      if (Object.keys(efforts).length) return efforts;
    } catch {
      // 读不到 / JSON 坏了 —— 换下一个候选路径,都不行就空表。
    }
  }
  return {};
}
