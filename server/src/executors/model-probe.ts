// 「这个 CLI 现在有哪些模型」——现问 CLI,而不是只读发版时抄下的快照
// (`shared/src/cli-presets.ts` 的 CLI_MODEL_PRESETS:各家上新模型跟 ash 发版
// 毫无关系,那张表必然滞后,且滞后多久取决于「有没有人想起来改它」)。
//
// 三条设计约束,都来自这个系统里已有的先例:
//  ① **只问,不跑**:探测走 spec.models 那条只读查询命令(`grok models` 之类),绝不
//     为了拿清单起一个真实回合 —— skills.ts 顶部记着教训:那一下 haiku 烧了 $0.084。
//  ② **诚实降级**:探不到(没装 / 没登录 / 命令改了)就退回快照,并把原因原样带给前端。
//     `source` 字段就是给界面区分「实时目录」和「内置兜底」用的,不许拿后者冒充前者。
//  ③ **缓存 + 显式刷新**:跟 skills 一样是内存缓存(重启即重探,不会有陈旧数据长期骗人),
//     TTL 到点自动重探,用户也能在选择器里点「刷新」强制现问。
//  ④ **多人模式下一次都不问**:探测问的是宿主机那个登录账号,而 §八 要抹掉的就是它。
//     判据见 `modelCatalogFor` 顶部 —— 这条端点没有鉴权可言(它不读任何人的资源),
//     真正的边界是「多人模式下压根不去起这个子进程」。
//
// 为什么不落库:清单是**本机 CLI 当下的事实**,不是用户配置。落库要额外处理「换了
// CLI 版本 / 换了登录账号 / 卸载了」的失效,而重启后重探一次的代价只有几百毫秒。

import type { AgentType } from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import { MULTI_USER_HOST_CLI_MODELS_HIDDEN } from "@ash/shared/multiuser";
import type { CliModelCatalog } from "@ash/shared/cli-presets";
import { CLI_MODEL_PRESETS } from "@ash/shared/cli-presets";
import { probeBins } from "./bin-probe.js";
import { CLI_SPEC_BY_KEY } from "./catalog/index.js";
import { execFileText as exec } from "../exec.js";
import { isMultiUser } from "../auth/mode.js";

/** 探测结果的保鲜期。到点后下一次读取会**等**一次重探(不做后台预热那套复杂度)。 */
const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * **降级结果**的保鲜期,短得多。一次超时或网络抖动若按成功那档存着,内置快照就会钉住
 * 半天;界面上只写「内置清单」,用户没理由知道自己看的是一次抖动的后果、更没理由想到
 * 去点刷新。探不到的那一次重探本来就很便宜(多半在 probeBins 那步就返回了)。
 */
const DEGRADED_TTL_MS = 2 * 60 * 1000;

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
  skipped: null,
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
      skipped: null,
      ...base,
    };
  } catch (error) {
    return presetCatalog(type, { ...base, error: reasonOf(error) });
  }
}

/**
 * 一条缓存能存多久。导出只为回归测试钉住「降级结果不许和成功结果一样保鲜」。
 * 没有清单命令的 CLI 除外:它永远只有快照,重探不会有新结果,没必要反复问。
 */
export function catalogTtlMs(catalog: CliModelCatalog): number {
  if (!catalog.probeSupported) return TTL_MS;
  return catalog.source === "probe" ? TTL_MS : DEGRADED_TTL_MS;
}

function fresh(entry: CacheEntry | undefined): boolean {
  return !!entry && Date.now() - entry.at < catalogTtlMs(entry.catalog);
}

/**
 * 一个 CLI 的模型清单。`force` = 用户点了「刷新」,绕过缓存与 TTL 现问一次。
 *
 * 缓存未命中时**等**探测结果(第一次打开选择器要多等几百毫秒,但拿到的是真清单);
 * 命中且未过期直接返回;过期则重探 —— 探测本身很便宜,不做后台预热那套复杂度。
 *
 * 多人模式下**一次都不问宿主机 CLI**(§八「宿主机 CLI 订阅彻底抹去」):`grok models`
 * 这类命令问的是宿主机那个登录账号,而那正是被隔离掉的东西 —— 执行器必须挂自己的
 * 供应商才跑得起来,模型候选也就该来自供应商。留着这条路的代价是实打实的:任何一个
 * 登录用户 POST 一次 refresh,就能让 server 用**自己进程的环境**(里面带着宿主的
 * ANTHROPIC_API_KEY / XAI_API_KEY 之类)起一个 CLI 子进程,并把宿主账号的模型清单
 * 端出来(第 2 轮审查 P1)。
 *
 * 这道判据排在**读缓存之前**:自用模式下探到的实时清单会在缓存里躺 6 小时,转成多人
 * 之后不能继续被端出来。它自己也不写缓存 —— 那不是探测结果,没有保鲜期可言。
 * 但登记 inflight 仍然是**同步**的(判据在 request 链里而不是函数开头),否则并发去重
 * 与「陈旧探测不许覆盖新结果」两条都会因为多了一个 await 而失效。
 */
export function modelCatalogFor(type: AgentType, force = false): Promise<CliModelCatalog> {
  const running = inflight.get(type);
  if (running && !force) return running;

  const request: Promise<CliModelCatalog> = isMultiUser()
    .then(async (multi): Promise<{ catalog: CliModelCatalog; probed: boolean }> => {
      if (multi) {
        // 只有本来就会去问的那几家才谈得上「没去问」;没有清单命令的 CLI 在两种模式下
        // 拿到的是同一份快照,给它挂一句多人模式的说明只会平白多出一行噪音。
        const wouldProbe = !!CLI_SPEC_BY_KEY[type]?.models;
        return {
          catalog: presetCatalog(type, wouldProbe ? { skipped: MULTI_USER_HOST_CLI_MODELS_HIDDEN } : {}),
          probed: false,
        };
      }
      const cached = cache.get(type);
      if (!force && fresh(cached)) return { catalog: cached!.catalog, probed: false };
      return { catalog: await probe(type), probed: true };
    })
    .then(({ catalog, probed }) => {
      // **只有当前那次探测有权写缓存**。force 会另起一次并顶掉 inflight,此时先前
      // 那次(可能还在等 10s 超时)结算得更晚 —— 不拦住的话它会把用户刚刷出来的
      // 实时清单覆盖回 preset,界面无缘无故退回快照,而且看着像「刷新按钮没用」。
      //
      // `probed` 那一半同样要紧:命中缓存也照写的话,时间戳会被每一次读续上,6 小时的
      // 保鲜期就变成了「6 小时没人看」,永远轮不到重探。
      if (probed && inflight.get(type) === request) cache.set(type, { catalog, at: Date.now() });
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
