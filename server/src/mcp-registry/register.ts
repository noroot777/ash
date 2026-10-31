// 按 `catalog.ts` 那张表,给任意一家 CLI 的配置目录补上 ash MCP 登记 —— **一份通用实现**。
//
// 原来只有 claude 和 codex 两条写死的路(`auth/user-cli-mcp.ts` 里两个 ensureXxx),所以
// 另外十三家执行器一行注册逻辑都没有,换它们跑任务全是 failed。现在的分工:
//
//   catalog.ts   哪家写在哪、什么形状(声明)
//   shapes.ts    怎么拼出新内容(纯函数,不碰文件)
//   这个文件     一次补接的流程:读 → 看状态 → 拼 → (codex 多一问) → 发布
//   config-publish.ts  怎么安全地落盘(就地写、失败回写、写完读回来比对)
//
// 三条边界照旧,全是审查打出来的:
//  · **只补 ash 这一条**,不搬宿主的其它 MCP(隔离档的意义是抹掉宿主的订阅和凭证);
//  · **已有登记一律不覆盖**,含历史名 `harness`(用户可能自己改过 URL 或路径);
//  · **「读不出来」绝不当成「没有」**:读不动、解析不了一律如实报,不写 —— 拿它当空去写,
//    就是一份只剩 MCP 登记的新文件把用户整份配置盖掉。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { byHand, type ApprovalVerdict } from "../auth/codex-approve.js";
import { fileState, publishFresh, readForWrite } from "../auth/config-publish.js";
import { currentListeningPort } from "../listening-port.js";
import { REPO_DIR } from "../paths.js";
import { ashMcpConfigDir, ashMcpMechanism } from "./catalog.js";
import { ASH_MCP_NAMES, foldScan } from "./shapes.js";
import type {
  AshMcpComposeOpts, AshMcpConfigSite, AshMcpConfigState, AshMcpEntry, AshMcpMechanism,
  AshMcpNameFact, AshMcpNameScan, AshMcpShape,
} from "./types.js";

/** 本仓库这份 MCP 服务的入口。宿主没登记过时按它现拼一条。 */
const MCP_ENTRY = join(REPO_DIR, "mcp", "dist", "index.js");

const NO_SOURCE =
  `宿主机的配置里没有 ash MCP，仓库里也没有 ${MCP_ENTRY}(先在仓库根跑一次 npm run build，` +
  `或按 docs/install.md 走一遍 MCP 接入)`;

const localUrl = () => `http://127.0.0.1:${currentListeningPort() ?? 4317}`;

/** 没得可搬时自己拼的那条。仓库里还没 build 出 MCP 产物就返回 null(别登记一个不存在的入口)。 */
function builtinEntry(): AshMcpEntry | null {
  if (!existsSync(MCP_ENTRY)) return null;
  return { command: "node", args: [MCP_ENTRY], env: { ASH_URL: localUrl() } };
}

/**
 * 这家 CLI 在**这个配置目录**里的配置文件。
 *
 * `alternates` 存在哪个就用哪个:用户已经有 `opencode.jsonc` 时再新建一份 `opencode.json`,
 * 两份都会被 CLI 认,到底哪份生效说不清(opencode / kilo 都认好几个文件名)。
 */
export function ashMcpConfigFile(dir: string, site: AshMcpConfigSite): string {
  for (const candidate of site.alternates ?? []) {
    const file = join(dir, ...candidate);
    if (existsSync(file)) return file;
  }
  return join(dir, ...site.relative);
}

/**
 * **宿主机上这家 CLI 真正读的那份配置文件 —— 写、判、提示只认这一处。**
 *
 * `dirEnv` 指到文件的那几家(opencode 的 `OPENCODE_CONFIG`、kilo 的 `KILO_CONFIG`)必须原样
 * 用那个路径。本轮审查 R4:上一版只有这里认得它,另外三处消费者(预检的 `fileAshMcpVerdict`、
 * 启动自检的 `hostCliConfigFile`、自查文案的 `howToCheck`)各自先把文件名丢掉、再按默认名
 * 拼回来 —— 于是用自定义文件名的用户那边,真 CLI 连得上 ash、派审却报「没接好」,给出的
 * 路径还是另一份文件。声明了 `dirEnvIsFile` 之后不许任何消费者再自己恢复默认文件名。
 */
export function ashMcpHostFile(
  agentType: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  // 落点 = **优先级最高的那份可写来源**(见 `ashMcpHostSources`)。往更低优先级那份写,
  // 写完也可能被上面那份盖掉;只读来源(变量里那整段 JSON)当然不能当落点。
  const writable = ashMcpHostSources(agentType, env, home).filter((s) => s.file);
  return writable.at(-1)?.file ?? null;
}

/**
 * 一份「这家 CLI 会读的配置」。
 *
 * `level` 大的优先级高。**同一层里谁覆盖谁没实测**(例如 `opencode.json` 与 `opencode.jsonc`
 * 都会被读,但同名键谁赢没测过),所以同层两份结论不一致一律判看不准。
 */
export interface AshMcpSource {
  /** 给人看的名字:文件路径,或 `$OPENCODE_CONFIG_CONTENT` 这样的变量名。 */
  readonly label: string;
  /** 可写落点;null = 只读来源(整段配置装在变量里,没有文件可写)。 */
  readonly file: string | null;
  /** 只读来源的正文。 */
  readonly text?: string;
  readonly level: number;
}

/**
 * 这一层(某个配置目录)里**实际存在**的那几份;一份都不存在时给出该写哪一份。
 *
 * 「该写哪一份」只有 `ashMcpConfigFile` 一份判据,所以这里把它挑中的那个**排在最后** ——
 * 上游 `ashMcpHostFile` 取的是最后一个,两边因此必然一致。按 existsSync 的自然顺序排会
 * 分叉:kilo 同时有 `config.json` 和 `opencode.jsonc` 时,`ashMcpConfigFile` 取前者
 * (alternates 的顺序就是优先级),自然顺序的最后一个却是后者。
 */
function filesInDir(dir: string, site: AshMcpConfigSite, level: number): AshMcpSource[] {
  const names = [site.relative, ...(site.alternates ?? [])];
  const found = names.map((parts) => join(dir, ...parts)).filter((f) => existsSync(f));
  const pick = ashMcpConfigFile(dir, site);
  const files = found.length ? [...found.filter((f) => f !== pick), pick] : [pick];
  return files.map((file) => ({ label: file, file, level }));
}

/**
 * 这家 CLI 在宿主机上**会读的全部配置**,按优先级**从低到高**。
 *
 * 为什么不是一个文件(真 opencode 实测,三轮):
 *  · `OPENCODE_CONFIG` 是「再加一份」不是「取代」—— 全局那份里的 ash 照样生效;
 *  · 默认目录里 `opencode.json` 和 `opencode.jsonc` **两份都读**(上一版「找到第一个就只认
 *    它」,于是 ash 写在 `.json`、目录里又有一份 `.jsonc` 时判成 absent,安装器还往 `.jsonc`
 *    里再补一条 —— 本轮审查 F4 的第二格);
 *  · `OPENCODE_CONFIG_DIR` 是**再加一个目录**、优先级高于默认目录(本轮实测:默认那份照样
 *    生效,而这个目录里的 `enabled = false` 盖得住默认那份的开启);
 *  · `OPENCODE_CONFIG_CONTENT` 里那整段 JSON 优先级最高、而且**没有文件可写** —— 只有它
 *    有 ash 时,真 CLI 连得上,上一版却判 absent 还去改全局文件(F4 的第三格)。
 *
 * 判「到底有没有」一律走 `effectiveConfigState`:这几份合起来 CLI 最终看到的是哪一条。
 */
export function ashMcpHostSources(
  agentType: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): AshMcpSource[] {
  const mechanism = ashMcpMechanism(agentType);
  if (mechanism?.kind !== "file") return [];
  const { site } = mechanism;
  // ① 配置目录那一层。`dirEnv` 指到**目录**时它整体取代默认目录(变量原样继承给子进程,
  //    CLI 认的就是它);指到**文件**时这一层仍是默认目录 —— 那种情况下不能走
  //    `ashMcpConfigDir`,它返回的是那个文件所在的目录,拿它拼只会又得到同一份,
  //    真正该一起看的全局那份照样看不见。
  const dirOverride = site.dirEnv && !site.dirEnvIsFile ? env[site.dirEnv]?.trim() : "";
  const out: AshMcpSource[] = filesInDir(dirOverride || site.defaultDir(env, home), site, 0);
  // ② 指到另一个配置目录的变量:再加一层,优先级更高。
  const altDir = site.altDirEnv ? env[site.altDirEnv]?.trim() : "";
  if (altDir) out.push(...filesInDir(altDir, site, 1));
  // ③ 指到文件的变量。
  const file = site.dirEnvIsFile && site.dirEnv ? env[site.dirEnv]?.trim() : "";
  if (file && !out.some((s) => s.file && resolve(s.file) === resolve(file))) {
    out.push({ label: file, file, level: 2 });
  }
  // ④ 整段 JSON 装在变量里:优先级最高,**只读**。
  const inline = site.contentEnv ? env[site.contentEnv]?.trim() : "";
  if (inline) out.push({ label: `$${site.contentEnv}`, file: null, text: inline, level: 3 });
  return out;
}

/**
 * 一份来源扫出来的**逐名事实**(折叠和跨来源解析都建在它上面,见 `resolveAshMcp`)。
 *
 * 文件那一路先分清「没有这个文件」和「有但读不动」:下面的读取路径会把异常吞成「空」,
 * 于是一次 EACCES / EIO 会被说成「没有登记」,而 absent 是个会被用来拦人的结论
 * (`ash-mcp-reachability.ts` 的「向放行开」)。
 */
export function sourceScan(source: AshMcpSource, shape: AshMcpShape): AshMcpNameScan {
  if (!source.file) {
    try {
      return shape.scan(source.text ?? null);
    } catch (e) {
      return { doubt: `读里面的 ash MCP 登记失败：${(e as Error).message}`, names: new Map() };
    }
  }
  const probe = fileState(source.file);
  if (probe === "unreadable") return { doubt: "读不出来", names: new Map() };
  if (probe === "missing") return { missing: true, names: new Map() };
  try {
    return shape.scan(readFileSync(source.file, "utf8"));
  } catch (e) {
    return { doubt: `读里面的 ash MCP 登记失败：${(e as Error).message}`, names: new Map() };
  }
}

/** 一份文件里的登记状态。 */
export function fileConfigState(file: string, shape: AshMcpShape): AshMcpConfigState {
  return sourceConfigState({ label: file, file, level: 0 }, shape);
}

/** 一份来源里的登记状态(= 扫一遍再折一下,折叠判据只有 `foldScan` 一份)。 */
export function sourceConfigState(source: AshMcpSource, shape: AshMcpShape): AshMcpConfigState {
  return foldScan(sourceScan(source, shape), source.label);
}

/** 最终生效的那条登记,外加**它来自哪一份来源 / 那条登记本身**(搬运和提示都消费这个)。 */
export interface AshMcpEffective extends AshMcpConfigState {
  /** present/disabled 时:说了算的那份来源。 */
  readonly source?: AshMcpSource;
  /** present/disabled 时:那条登记在它那份里的事实(原值 / 原文 / 启动方式都在这)。 */
  readonly fact?: AshMcpNameFact;
}

type NamePick = { name: string; fact: AshMcpNameFact; source: AshMcpSource } | { why: string };

/**
 * 几份来源合起来,这家 CLI **最终看到的**是哪一条登记,以及它出自哪一份。
 *
 * 判据(真 opencode 实测,上一轮审查 F4):**声明了这个名字的来源里,优先级最高的那份说了算** ——
 * 高优先级那份只写 `{"enabled": false}` 也算声明,它会合到低优先级那条上、把它关掉(实测:
 * 真 CLI 报 `ash disabled`,而更早一版「任一来源 present 就 present」报的是已接好,于是这家
 * 执行器一路跑到交卷才发现工具根本不在)。
 *
 * **逐个兼容名各算一次**(本轮审查 F3):`ash` 和 `harness` 是两条独立登记。上一版先把每份
 * 来源压成一个四态结论、再按优先级选赢家,两个名字的事实在第一步就混成了一个 —— 于是
 * 「高优先级那份里 `ash` 关着、低优先级那份里 `harness` 开着」被判成 disabled(预检硬拒),
 * 而真 CLI 那边工具明明连得上。先按名字各自定下最终登记,再在这几条之上找开着的那条。
 *
 * 三处一律回 unknown(看不准就不写、也不拦起跑):
 *  · **这家的合并语义本身没实测**(`sourcesMerge` 不为真)而几份结论不一致 —— 那时「present」
 *    和「absent」各是一种猜,两种猜错的代价都是实打实的;
 *  · **同一层**里同一个名字有两份不一致的写法 —— 同层谁覆盖谁没实测;
 *  · 有一份**整份读不准**、而且优先级不低于那条生效的登记 —— 它可能正把那条关掉。
 */
export function resolveAshMcp(
  sources: readonly AshMcpSource[],
  shape: AshMcpShape,
  merges: boolean,
): AshMcpEffective {
  if (!sources.length) return unknownState("算不出这家 CLI 会读哪几份配置");
  const read = sources.map((source) => ({ source, scan: sourceScan(source, shape) }));
  const folded = read.map((r) => foldScan(r.scan, r.source.label));
  if (read.length > 1 && !merges && new Set(folded.map((f) => f.state)).size > 1) {
    return unknownState("这家 CLI 会读好几份配置，而它们的结论不一致、合并规则 ash 没实测过："
      + folded.map((f, i) => f.detail
        || (f.state === "present" ? `${read[i]!.source.label} 里已经有 ash 登记` : f.state)).join("；"));
  }
  const picks: NamePick[] = [];
  for (const name of ASH_MCP_NAMES) {
    const declared = read.filter((r) => r.scan.names.has(name));
    if (!declared.length) continue;
    const top = Math.max(...declared.map((r) => r.source.level));
    const winners = declared
      .filter((r) => r.source.level === top)
      .map((r) => ({ name, fact: r.scan.names.get(name)!, source: r.source }));
    const unsure = winners.find((w) => w.fact.status === "doubt");
    if (unsure) {
      picks.push({ why: `${unsure.source.label}：${unsure.fact.detail}` });
      continue;
    }
    if (new Set(winners.map((w) => w.fact.status)).size > 1) {
      picks.push({
        why: `同一层里好几份配置都写了 ${name} 这条登记、结论还不一致、谁覆盖谁 ash 没实测过（`
          + winners.map((w) => `${w.source.label}：${w.fact.status === "on" ? "开着" : "关着"}`).join("；") + "）",
      });
      continue;
    }
    picks.push(winners[0]!);
  }
  const live = picks.find((p): p is Extract<NamePick, { name: string }> => "fact" in p && p.fact.status === "on");
  // 整份读不准的那些:它**可能声明任何名字**,包括把生效那条关掉 —— 但优先级比它低的影响不到。
  const blind = read.filter((r) => r.scan.doubt);
  const blindWhy = (over: typeof blind) => over.map((b) => foldScan(b.scan, b.source.label).detail).join("；");
  if (live) {
    const over = blind.filter((b) => b.source.level >= live.source.level);
    if (over.length) {
      return unknownState(`${live.source.label} 里有生效的 ${live.name} 登记，但 ${blindWhy(over)}`
        + " —— 那几份优先级不低于它、可能正把它关掉");
    }
    return { state: "present", serverName: live.name, detail: "", source: live.source, fact: live.fact };
  }
  if (blind.length) return unknownState(blindWhy(blind));
  const unsure = picks.filter((p): p is { why: string } => "why" in p);
  if (unsure.length) return unknownState(unsure.map((u) => u.why).join("；"));
  const off = picks.filter((p): p is Extract<NamePick, { name: string }> => "fact" in p);
  if (off.length) {
    return {
      state: "disabled",
      serverName: off[0]!.name,
      detail: off.map((o) => `${o.source.label}：${o.fact.detail}`).join("、"),
      source: off[0]!.source,
      fact: off[0]!.fact,
    };
  }
  // 一个名字都没声明 ⇒ 确实没有。措辞用**最后那份**(优先级最高的那份,也是写入落点)。
  return { ...folded.at(-1)!, source: read.at(-1)!.source };
}

/** `resolveAshMcp` 的四态投影(老调用方只要状态)。 */
export function effectiveConfigState(
  sources: readonly AshMcpSource[],
  shape: AshMcpShape,
  merges: boolean,
): AshMcpConfigState {
  return resolveAshMcp(sources, shape, merges);
}

/** 某个配置目录(隔离档给个人目录,宿主档走 `ashMcpHostFile`)里的那份配置文件。 */
function siteFileFor(agentType: string, dir: string, site: AshMcpConfigSite, env: NodeJS.ProcessEnv): string {
  // 指到文件的变量只在**宿主档**成立:隔离档是我们自己造的目录,调用方给的 dir 才是权威。
  if (site.dirEnvIsFile && dir === ashMcpConfigDir(agentType, env, homedir())) {
    return ashMcpHostFile(agentType, env) ?? ashMcpConfigFile(dir, site);
  }
  return ashMcpConfigFile(dir, site);
}

/**
 * 同一个配置目录里这家 CLI 也会读、而这个格式族读不了的那种文件(trae 的原生 YAML)。
 * 返回第一个**真实存在**的;没有就 null。语义与两条后果见 `AshMcpConfigSite.opaque`。
 */
export function ashMcpOpaqueSibling(dir: string, site: AshMcpConfigSite): string | null {
  for (const candidate of site.opaque ?? []) {
    const file = join(dir, ...candidate);
    if (existsSync(file)) return file;
  }
  return null;
}

/** 这家 CLI 的 ash MCP 登记状态(四态,语义见 `types.ts` 的 `AshMcpConfigState`)。 */
export function ashMcpStateIn(
  dir: string,
  agentType: string,
  env: NodeJS.ProcessEnv = process.env,
): AshMcpConfigState {
  const mechanism = ashMcpMechanism(agentType);
  if (!mechanism) return unknownState(`不认识的执行器 ${agentType}`);
  if (mechanism.kind === "none") return { state: "absent", serverName: null, detail: mechanism.why };
  if (mechanism.kind === "manual") {
    return unknownState(`${agentType} 的 MCP 配置 ash 不自动读写：${mechanism.howTo}`);
  }
  const file = siteFileFor(agentType, dir, mechanism.site, env);
  // 同目录有这家也读、而我们读不了格式的配置 ⇒ 不下结论(`AshMcpConfigSite.opaque`)。
  const opaque = ashMcpOpaqueSibling(dir, mechanism.site);
  if (opaque) return unknownState(`${opaque} 这份配置 ${agentType} 也读，而 ash 读不了它的格式`);
  // **先分清「没有这个文件」和「有但读不动」**:下面的读取路径会把异常吞成「空」,于是一次
  // EACCES / EIO 会被说成「没有登记」。absent 是个会被用来拦人的结论(`ash-mcp-reachability.ts`
  // 的「向放行开」),只有确实没有文件才配得上它。
  return fileConfigState(file, mechanism.shape);
}

const unknownState = (detail: string): AshMcpConfigState => ({ state: "unknown", serverName: null, detail });

/**
 * 「这家 CLI 的 MCP 机制本身够不够用」—— 预检拦/提示的措辞**只有这一份**。
 *
 * 两档分开:`refuse` 是表里按实测/文档写死的「确实没有 MCP」,拦得住才对;`hint` 是「有 MCP、
 * 只是 ash 不替他写」(trae 的 YAML),拦不得 —— 用户完全可能自己接好了,而我们读不了那种格式,
 * 「读不了」不是「没有」。返回 null = 这家归常规判据管(问 CLI 或读配置)。
 */
export function ashMcpUnsupported(
  agentType: string,
  mechanism: AshMcpMechanism | null,
): { tier: "refuse" | "hint"; why: string } | null {
  if (!mechanism) return null;
  if (mechanism.kind === "none") {
    return { tier: "refuse", why: `${agentType} 没有 MCP 机制：${mechanism.why} —— 这一轮跑完也上报不了结论` };
  }
  if (mechanism.kind === "manual") {
    return {
      tier: "hint",
      why: `${agentType} 的 ash MCP 登记 ash 不会自动写（${mechanism.howTo}）；若没接过，这一轮跑完上报会失败`,
    };
  }
  return null;
}

/** 补接的结果。`ok:false` 时 `why` 是**给用户看**的一句话(会进时间线和设置页)。 */
export type AshMcpRegisterResult = { ok: true; serverName: string } | { ok: false; why: string };

export interface AshMcpRegisterOptions {
  agentType: string;
  /** 要补的那个配置目录(隔离档给个人目录;宿主档给 `ashMcpConfigDir` 算出来的)。 */
  dir: string;
  /** 搬宿主那条登记时按哪个 home 找。**只为回归测试留**,产品代码走真 `homedir()`。 */
  hostHome?: string;
  /** 发布前把候选交给 CLI 本人读一遍。只有 codex 需要(见 `auth/codex-approve.ts`)。 */
  approve?: (candidate: string) => Promise<ApprovalVerdict>;
  env?: NodeJS.ProcessEnv;
}

/**
 * 缺了就补,补完把结果如实说出来。**幂等**:已经有了就只是两次文件读。
 *
 * 为什么是 async:codex 那一家要把候选交给 codex 本人解析一遍才敢发布,而那一次子进程必须
 * 走探测执行层(异步、带归属、收得回来),不能在事件循环里同步 spawn。
 */
export async function registerAshMcp(opts: AshMcpRegisterOptions): Promise<AshMcpRegisterResult> {
  const { agentType, dir } = opts;
  const env = opts.env ?? process.env;
  const hostHome = opts.hostHome ?? homedir();
  const mechanism = ashMcpMechanism(agentType);
  if (!mechanism) return { ok: false, why: `不认识的执行器 ${agentType}，没有 ash MCP 登记这一问` };
  if (mechanism.kind === "none") {
    return { ok: false, why: `${agentType} 没有 MCP 机制：${mechanism.why}` };
  }
  if (mechanism.kind === "manual") {
    return { ok: false, why: `ash 不自动写 ${agentType} 的 MCP 配置：${mechanism.howTo}` };
  }
  const file = siteFileFor(agentType, dir, mechanism.site, env);
  const fail = (why: string): AshMcpRegisterResult => ({ ok: false, why });
  // 同目录有我们读不了、而这家 CLI 也会读的那种配置(trae 的原生 YAML):**不写**。
  // ash 可能已经被写在那里面了,而同名登记同时来自两个来源、谁生效没有文档依据。
  const opaque = ashMcpOpaqueSibling(dir, mechanism.site);
  if (opaque) {
    return fail(`${opaque} 这份配置 ${agentType} 也会读，而 ash 读不了它的格式 —— `
      + `所以没有自动补写 ${file}（免得同一个 ash 登记在两份配置里各有一条）；`
      + "请在那份配置里自己加一条 ash 登记，或者把它挪开再重启");
  }
  // **写之前把这家 CLI 会读的其它来源看一眼**(本轮审查 R3)。只有宿主档会有这种事:隔离档
  // 是我们自己造的目录。任一来源已经有 ash ⇒ 不写(往更高优先级那份补一条会把它顶掉);
  // 看不准 ⇒ 也不写,如实说。
  if (resolve(dir) === resolve(ashMcpConfigDir(agentType, env, hostHome) ?? dir)) {
    const sources = ashMcpHostSources(agentType, env, hostHome);
    if (sources.length > 1) {
      // 判「最终生效的是哪一条」,不是「有没有任一份里有」:高优先级那份只写
      // `{"enabled": false}` 也会把低优先级那条关掉(真 opencode 实测,本轮审查 F4)。
      const state = effectiveConfigState(sources, mechanism.shape, mechanism.site.sourcesMerge === true);
      if (state.state === "present") return { ok: true, serverName: state.serverName ?? ASH_MCP_SERVER_NAME };
      if (state.state === "disabled") return fail(`${state.detail}，没有替你打开`);
      if (state.state === "unknown") {
        return fail(`看不准这家 CLI 到底有没有 ash MCP 登记（${state.detail}），所以没有自动补写 ——`
          + "你那几份配置一个字节都没动");
      }
    }
  }
  return await publishFresh<AshMcpRegisterResult>(file, async (read, commit) => {
    const found = mechanism.shape.read(read.text);
    if (found.state === "present") return { ok: true, serverName: found.serverName! };
    if (found.state === "disabled") return fail(`${file}：${found.detail}，没有替你打开`);
    // 「看不准」必须说成看不准,并且说明**什么都没写**:这一档最常见的两种是「配置正被 CLI
    // 写到一半」和「用户手工改坏了」,两种都不该靠猜去补 —— 判错成「没有」就会再写一份,
    // TOML 里是重复的表(CLI 整份拒载),JSON 里是把半截内容当底稿盖回去。
    if (found.state === "unknown") {
      return fail(`看不准 ${file} 里有没有 ash MCP 登记（${found.detail}），所以没有自动补写 ——`
        + `你那份配置一个字节都没动；手工修好它（或挪开它）再重启`);
    }
    const plan = composeEntry(mechanism, read.text, agentType, hostHome, env);
    if ("why" in plan) return fail(plan.why);
    if (opts.approve) {
      // 同一份原文 + 同一段要追加的内容,失败过就不再问第二遍:设置页每读一次、每条任务起跑
      // 都会走到这里,而问 CLI 本人要起一次进程。原文或那段一变,键就变了,自然重试。
      const key = fingerprint(file, read.text ?? "", plan.body);
      const cached = cachedFailure(key);
      if (cached) return fail(cached);
      const verdict = await opts.approve(plan.body);
      if (verdict.state !== "ok") {
        const hint = plan.block ? byHand(file, plan.block) : "，所以没有替你写进去（你那份配置一个字节都没动）";
        // 内容本身的毛病记死(内容一变键就变了);「问不出来」只记一小会儿 —— 见 failedWrites。
        return fail(remember(key, `${verdict.why}${hint}`, verdict.state === "bad" ? "content" : "transient"));
      }
    }
    const why = commit(read, plan.body);
    return why ? fail(why) : { ok: true, serverName: ASH_MCP_SERVER_NAME };
  }, fail);
}

/** 拼出要发布的全文。`block` 只有 TOML 族有(补接失败时给用户的「这段你手工加」要用它)。 */
function composeEntry(
  mechanism: Extract<AshMcpMechanism, { kind: "file" }>,
  current: string | null,
  agentType: string,
  hostHome: string,
  env: NodeJS.ProcessEnv,
): { body: string; block?: string } | { why: string } {
  const { shape } = mechanism;
  const opts: AshMcpComposeOpts = {
    enabled: mechanism.writeEnabled === true,
    ...(mechanism.writeType ? { type: mechanism.writeType } : {}),
  };
  const hostText = hostConfigText(agentType, hostHome, env);
  if (blockShape(shape)) {
    // 宿主那段原样搬(连子表一起),没有就按一条登记现渲染一段。
    const fromHost = hostText ? shape.hostBlock(hostText) : null;
    let block = fromHost;
    if (!block) {
      const entry = builtinEntry();
      if (!entry) return { why: NO_SOURCE };
      block = shape.blockFor(entry, opts);
    }
    const composed = shape.appendBlock(current, block);
    return "why" in composed ? composed : { body: composed.body, block };
  }
  // 宿主那条**原值照搬**(规范名落地:即使它在宿主那边叫历史名 harness,搬过来也按 ash 登记 ——
  // 两边都叫 ash 之后,提示词里那句「ash MCP」才对得上工具名)。
  //
  // 为什么不投影成 `{command,args,env}`:那样远程登记(`type:"http"` + url + headers)会变成
  // 「连本机 4317 的 stdio」、`cwd`/`timeout` 这些启动字段静默消失(本轮审查 R5 实测)。
  const hostValue = hostText ? shape.hostRaw(hostText) : null;
  if (hostValue && shape.composeRaw) return shape.composeRaw(current, hostValue);
  const entry = builtinEntry();
  if (!entry) return { why: NO_SOURCE };
  return shape.compose(current, entry, opts);
}

/**
 * 「整段原文照搬」那一路成不成立 —— 只有 TOML 族有(`blockFor`/`appendBlock` 要么都有、
 * 要么都没有,见 `types.ts`)。不看 `hostBlock`:它现在三族都有,JSON 两族恒为 null。
 */
function blockShape(shape: AshMcpShape): shape is AshMcpShape & Required<Pick<AshMcpShape, "blockFor" | "appendBlock">> {
  return !!shape.blockFor && !!shape.appendBlock;
}

/**
 * 宿主机那份同格式配置的全文(读不动就当没有 —— 它只是「有没有东西可搬」的来源)。
 *
 * 取的是**最终生效那条登记所在的那一份**,不是写入目标那一份(上一轮审查 F4):ash 可能写在
 * 全局那份、而落点是 `OPENCODE_CONFIG` 指的那个文件 —— 只读落点就会把「有东西可搬」看成
 * 「没有」,于是隔离档里拿默认模板重新渲染一条,用户自己调过的启动参数当场丢掉。
 *
 * 「哪一份说了算」**问解析层**(本轮审查 F3):上一版在这里自己按 present 过滤再取最后一个,
 * 跟 `resolveAshMcp` 的优先级算法各一套 —— 两套判据迟早分叉,而分叉的后果是搬错那一条。
 */
function hostConfigText(agentType: string, hostHome: string, env: NodeJS.ProcessEnv): string {
  const mechanism = ashMcpMechanism(agentType);
  if (mechanism?.kind !== "file") return "";
  const sources = ashMcpHostSources(agentType, env, hostHome);
  const found = resolveAshMcp(sources, mechanism.shape, mechanism.site.sourcesMerge === true);
  const live = found.state === "present" ? found.source : undefined;
  if (live) return live.file ? readForWrite(live.file)?.text ?? "" : live.text ?? "";
  const dir = ashMcpConfigDir(agentType, env, hostHome);
  if (!dir) return "";
  return readForWrite(siteFileFor(agentType, dir, mechanism.site, env))?.text ?? "";
}

/**
 * 写失败过的「文件 + 原文 + 要追加的那段」指纹 → 当时的原因，和它还算到什么时候。
 *
 * **两种失败的有效期不一样**（本轮审查 N6）：内容本身的毛病（codex 说这份 TOML 读不通、
 * 扫描器自己都读不通）记死就好 —— 内容一变键就变了，自然重试；而「问不出来」（查询超时、
 * CLI 一时起不来、归属一时建不成）是环境问题，上一版把它也记死，于是环境修好之后只要配置
 * 没变就永远不再试，只能重启 ash。
 */
const failedWrites = new Map<string, { why: string; until: number }>();

/** 「问不出来」记这么久:短到环境修好能自己恢复,长到设置页连点几下不会反复起进程。 */
const TRANSIENT_FAILURE_MS = 60_000;

function remember(key: string, why: string, kind: "content" | "transient"): string {
  failedWrites.set(key, { why, until: kind === "content" ? Infinity : Date.now() + TRANSIENT_FAILURE_MS });
  return why;
}

function cachedFailure(key: string): string | null {
  const hit = failedWrites.get(key);
  if (!hit) return null;
  if (hit.until >= Date.now()) return hit.why;
  failedWrites.delete(key);
  return null;
}

const fingerprint = (file: string, current: string, block: string): string =>
  createHash("sha256").update(`${file}\u0000${current}\u0000${block}`).digest("hex");