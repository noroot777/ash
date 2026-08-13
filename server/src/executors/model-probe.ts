// 「这个 CLI 现在有哪些模型」——现问 CLI,而不是只读发版时抄下的快照。
//
// 起因(2026-08-13):xAI 发了 grok-4.6,本机 `grok models` 早就列出来了,harness 的
// 下拉框里却还是 grok-4.5 —— 因为候选唯一的来源是 `shared/src/cli-presets.ts` 里
// 硬编码的 CLI_MODEL_PRESETS。那张表是**发版快照**,而各家上新模型跟 harness 发版
// 毫无关系,所以它必然滞后,且滞后多久取决于「有没有人想起来改它」。
//
// 三条设计约束,都来自这个系统里已有的先例:
//  ① **只问,不跑**:探测走 spec.models 那条只读查询命令(`grok models` 之类),绝不
//     为了拿清单起一个真实回合 —— skills.ts 顶部记着教训:那一下 haiku 烧了 $0.084。
//  ② **诚实降级**:探不到(没装 / 没登录 / 命令改了)就退回快照,并把原因原样带给前端。
//     `source` 字段就是给界面区分「实时目录」和「内置兜底」用的,不许拿后者冒充前者。
//  ③ **缓存 + 显式刷新**:跟 skills 一样是内存缓存(重启即重探,不会有陈旧数据长期骗人),
//     TTL 到点自动重探,用户也能在选择器里点「刷新」强制现问。
//
// 为什么不落库:清单是**本机 CLI 当下的事实**,不是用户配置。落库要额外处理「换了
// CLI 版本 / 换了登录账号 / 卸载了」的失效,而重启后重探一次的代价只有几百毫秒。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentType } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import type { CliModelCatalog } from "@harness/shared/cli-presets";
import { CLI_MODEL_PRESETS } from "@harness/shared/cli-presets";
import { probeBins } from "./bin-probe.js";
import { CLI_SPEC_BY_KEY } from "./catalog/index.js";

const exec = promisify(execFile);

/** 探测结果的保鲜期。到点后下一次读取会重探(读的人拿到的仍是旧值,不阻塞)。 */
const TTL_MS = 6 * 60 * 60 * 1000;

/** 清单命令的默认超时。登录态查询要一次网络往返,给够;卡住不该拖垮页面。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 一个 CLI 报几百个模型是正常的(pi 就有一表),但要有上限防止把脏输出整段端上来。 */
const MAX_MODELS = 500;

interface CacheEntry {
  catalog: CliModelCatalog;
  at: number;
}

const cache = new Map<AgentType, CacheEntry>();
/** 同一个 type 的并发探测合并成一次:三个选择器同时打开不该起三个子进程。 */
const inflight = new Map<AgentType, Promise<CliModelCatalog>>();

const presetCatalog = (type: AgentType, patch: Partial<CliModelCatalog> = {}): CliModelCatalog => ({
  type,
  models: [...CLI_MODEL_PRESETS[type]],
  defaultModel: null,
  source: "preset",
  probeSupported: !!CLI_SPEC_BY_KEY[type]?.models,
  available: false,
  probedAt: null,
  cliVersion: null,
  error: null,
  ...patch,
});

/** 报错文案:只留最后一段有用的,别把整页 usage 塞进界面。 */
function reasonOf(error: unknown): string {
  // execFile 的错误把 CLI 的抱怨放在 stderr 上,message 往往只有一句
  // "Command failed" —— 后者对查问题毫无用处,所以 stderr 优先。
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const raw =
    typeof stderr === "string" && stderr.trim()
      ? stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);
  return raw.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) || "探测失败";
}

// 同名去重但保序:CLI 报的顺序通常有意义(默认模型、推荐档在前)。默认模型再提到首位,
// 这样下拉框第一眼看到的就是「不选就是它」的那个。导出只为回归测试钉住这两条。
export function normalizeModelList(models: string[], defaultModel: string | null): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of models) {
    const model = raw.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    ordered.push(model);
    if (ordered.length >= MAX_MODELS) break;
  }
  if (defaultModel && ordered.includes(defaultModel)) {
    return [defaultModel, ...ordered.filter((model) => model !== defaultModel)];
  }
  return ordered;
}

async function probe(type: AgentType): Promise<CliModelCatalog> {
  const spec = CLI_SPEC_BY_KEY[type];
  if (!spec?.models) return presetCatalog(type);

  // 探测跑的是 probeBins 解析出的**绝对路径**,与派任务时是同一套查找口径
  // (GUI 启动的 server 常常缺 /opt/homebrew/bin 之类,裸命令名会「装了却查不到」)。
  const found = await probeBins(spec.bins, spec.fallbackVersionMatch);
  if (!found) return presetCatalog(type, { error: null });

  const base = { available: true, cliVersion: found.version, probeSupported: true as const };
  try {
    const { stdout, stderr } = await exec(found.path, spec.models.args, {
      timeout: spec.models.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = spec.models.parse(stdout, stderr);
    const models = normalizeModelList(parsed.models, parsed.defaultModel ?? null);
    // 命令跑通但一个都没解析出来 = 没登录或输出格式变了。降级到快照并说清楚,
    // 因为空下拉框会被当成「这个 CLI 没有模型」,那是最难查的一种假象。
    if (!models.length) {
      return presetCatalog(type, {
        ...base,
        error: `${spec.bins[0]} ${spec.models.args.join(" ")} 没有列出任何模型(多半是未登录,或该 CLI 换了输出格式)`,
      });
    }
    return {
      type,
      models,
      defaultModel: parsed.defaultModel?.trim() || null,
      source: "probe",
      probedAt: new Date().toISOString(),
      error: null,
      ...base,
    };
  } catch (error) {
    return presetCatalog(type, { ...base, error: reasonOf(error) });
  }
}

function fresh(entry: CacheEntry | undefined): boolean {
  return !!entry && Date.now() - entry.at < TTL_MS;
}

/**
 * 一个 CLI 的模型清单。`force` = 用户点了「刷新」,绕过缓存与 TTL 现问一次。
 *
 * 缓存未命中时**等**探测结果(第一次打开选择器要多等几百毫秒,但拿到的是真清单);
 * 命中且未过期直接返回;过期则重探 —— 探测本身很便宜,不做后台预热那套复杂度。
 */
export function modelCatalogFor(type: AgentType, force = false): Promise<CliModelCatalog> {
  const cached = cache.get(type);
  if (!force && fresh(cached)) return Promise.resolve(cached!.catalog);

  const running = inflight.get(type);
  if (running && !force) return running;

  const request = probe(type)
    .then((catalog) => {
      cache.set(type, { catalog, at: Date.now() });
      return catalog;
    })
    .catch(() => presetCatalog(type, { error: "探测过程异常" }))
    .finally(() => {
      if (inflight.get(type) === request) inflight.delete(type);
    });
  inflight.set(type, request);
  return request;
}

/** 多个 CLI 的清单,并发探。不传 types = 全部登记在目录里的。 */
export function modelCatalogs(types?: AgentType[], force = false): Promise<CliModelCatalog[]> {
  const wanted = types?.length ? types : [...AGENT_TYPES];
  return Promise.all(wanted.map((type) => modelCatalogFor(type, force)));
}

/** 只给测试用:清掉缓存。 */
export function resetModelCatalogCache(): void {
  cache.clear();
  inflight.clear();
}
