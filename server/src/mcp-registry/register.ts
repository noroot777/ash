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
import type { AshMcpComposeOpts, AshMcpConfigSite, AshMcpConfigState, AshMcpEntry, AshMcpMechanism, AshMcpShape } from "./types.js";

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
  const mechanism = ashMcpMechanism(agentType);
  if (mechanism?.kind !== "file") return null;
  const { site } = mechanism;
  const override = site.dirEnv ? env[site.dirEnv]?.trim() : "";
  if (override && site.dirEnvIsFile) return override;
  const dir = ashMcpConfigDir(agentType, env, home);
  return dir ? ashMcpConfigFile(dir, site) : null;
}

/**
 * 这家 CLI 在宿主机上**会读的全部配置文件**,低优先级在前、写入目标在最后。
 *
 * 为什么不是一个文件(本轮审查 R3,真 opencode 实测):`OPENCODE_CONFIG` 不是「取代配置目录」,
 * 而是**再加一份**配置 —— 全局那份里的 ash 照样生效。上一版只认变量指的那一份,于是那种
 * 「全局放 MCP、另给一份模型设置」的正常分拆:预检说「没接好」把派审硬拒了,安装器还会往更高
 * 优先级那份里补一条、把本来连得上的那条 URL 顶掉。
 */
export function ashMcpHostSources(
  agentType: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const mechanism = ashMcpMechanism(agentType);
  if (mechanism?.kind !== "file") return [];
  const { site } = mechanism;
  const target = ashMcpHostFile(agentType, env, home);
  if (!target) return [];
  // 默认位置那份要用 `defaultDir` 直接算:`ashMcpConfigDir` 在变量指到文件时返回的是**那个
  // 文件所在的目录**,拿它拼只会又得到同一份,全局那份照样看不见。
  const fallback = ashMcpConfigFile(site.defaultDir(env, home), site);
  // 变量指到文件的那几家:默认位置那份也是来源之一(谁优先、合不合并见 `envFileMerges`)。
  if (site.dirEnvIsFile && resolve(fallback) !== resolve(target)) return [fallback, target];
  return [target];
}

/** 一份文件里的登记状态(先分清「没有这个文件」和「有但读不动」,见 `ashMcpStateIn`)。 */
export function fileConfigState(file: string, shape: AshMcpShape): AshMcpConfigState {
  const probe = fileState(file);
  if (probe === "unreadable") return unknownState(`${file} 读不出来`);
  if (probe === "missing") return { state: "absent", serverName: null, detail: `${file} 还不存在` };
  try {
    const found = shape.read(readFileSync(file, "utf8"));
    return { ...found, detail: found.detail ? `${file}：${found.detail}` : "" };
  } catch (e) {
    return unknownState(`读 ${file} 的 ash MCP 登记失败：${(e as Error).message}`);
  }
}

/**
 * 把同一家 CLI 几份来源的判定合成一个结论。
 *
 * - 任一来源 present ⇒ present(合并来源下它就是 CLI 真看到的那条);
 * - 否则任一 disabled ⇒ disabled;任一 unknown ⇒ unknown;
 * - **合并语义没实测过、而几份来源结论不一致 ⇒ unknown**:这时「present」和「absent」各是一种
 *   猜,两种猜错的代价都是实打实的(见 `envFileMerges`),所以只说看不准、不写;
 * - 全部确认没有 ⇒ absent(只有这一档配得上「可以自动补写」)。
 */
export function combineConfigStates(
  states: readonly AshMcpConfigState[],
  merges: boolean,
): AshMcpConfigState {
  if (states.length === 1) return states[0]!;
  // **先判「几份结论一致吗」**:合并语义没实测时,不一致的那一档既不能说有也不能说没有
  // (说有 ⇒ 真要是取代语义,那就是没接上还报接上了;说没有 ⇒ 真要是合并语义,预检会硬拒
  // 一个本来连得上的执行器、安装器还会再写一条顶掉它)。所以只说看不准。
  if (!merges && new Set(states.map((s) => s.state)).size > 1) {
    return unknownState("这家 CLI 会读好几份配置，而它们的结论不一致、合并规则 ash 没实测过："
      + states.map((s) => s.detail || (s.state === "present" ? "其中一份里已经有 ash 登记" : s.state)).join("；"));
  }
  const present = states.find((s) => s.state === "present");
  if (present) return present;
  const unsure = states.find((s) => s.state === "unknown");
  if (unsure) return unsure;
  const off = states.find((s) => s.state === "disabled");
  if (off) return off;
  return states[0]!;
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
    const others = ashMcpHostSources(agentType, env, hostHome)
      .filter((f) => resolve(f) !== resolve(file));
    for (const other of others) {
      const state = combineConfigStates(
        [fileConfigState(other, mechanism.shape), fileConfigState(file, mechanism.shape)],
        mechanism.site.envFileMerges === true,
      );
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
  const hostValue = hostText ? shape.hostRaw?.(hostText) : null;
  if (hostValue && shape.composeRaw) return shape.composeRaw(current, hostValue);
  const entry = builtinEntry();
  if (!entry) return { why: NO_SOURCE };
  return shape.compose(current, entry, opts);
}

/** TOML 那一族(三位要么都有、要么都没有,见 `types.ts`)。 */
function blockShape(shape: AshMcpShape): shape is AshMcpShape & Required<Pick<AshMcpShape, "hostBlock" | "blockFor" | "appendBlock">> {
  return !!shape.hostBlock && !!shape.blockFor && !!shape.appendBlock;
}

/** 宿主机那份同格式配置的全文(读不动就当没有 —— 它只是「有没有东西可搬」的来源)。 */
function hostConfigText(agentType: string, hostHome: string, env: NodeJS.ProcessEnv): string {
  const dir = ashMcpConfigDir(agentType, env, hostHome);
  const mechanism = ashMcpMechanism(agentType);
  if (!dir || mechanism?.kind !== "file") return "";
  const read = readForWrite(siteFileFor(agentType, dir, mechanism.site, env));
  return read?.text ?? "";
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