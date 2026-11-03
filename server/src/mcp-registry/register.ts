// 按 `catalog.ts` 那张表,给任意一家 CLI 的配置目录补上 ash MCP 登记 —— **一份通用实现**。
//
// 原来只有 claude 和 codex 两条写死的路(`auth/user-cli-mcp.ts` 里两个 ensureXxx),所以
// 另外十三家执行器一行注册逻辑都没有,换它们跑任务全是 failed。现在的分工:
//
//   catalog.ts   哪家写在哪、什么形状(声明)
//   shapes.ts    怎么拼出新内容(纯函数,不碰文件)
//   sources.ts   这家会读哪几份、合起来生效的是哪一条(读和判那一半,三个消费者共用)
//   这个文件     一次补接的流程:读 → 看状态 → 拼 → (codex 多一问) → 发布
//   config-publish.ts  怎么安全地落盘(就地写、失败回写、写完读回来比对)
//
// 三条边界照旧,全是审查打出来的:
//  · **只补 ash 这一条**,不搬宿主的其它 MCP(隔离档的意义是抹掉宿主的订阅和凭证);
//  · **已有登记一律不覆盖**,含历史名 `harness`(用户可能自己改过 URL 或路径);
//  · **「读不出来」绝不当成「没有」**:读不动、解析不了一律如实报,不写 —— 拿它当空去写,
//    就是一份只剩 MCP 登记的新文件把用户整份配置盖掉。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { byHand, type ApprovalVerdict } from "../auth/codex-approve.js";
import { publishFresh } from "../auth/config-publish.js";
import { currentListeningPort } from "../listening-port.js";
import { REPO_DIR } from "../paths.js";
import { ashMcpConfigDir, ashMcpMechanism } from "./catalog.js";
import {
  ashMcpHostSources, ashMcpOpaqueSibling, effectiveConfigState, readingFor, resolveAshMcp, siteFileFor,
} from "./sources.js";
import type {
  AshMcpComposeOpts, AshMcpEntry, AshMcpMechanism, AshMcpNameFact, AshMcpShape,
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

/**
 * 「要手工接的话加哪一段、加到哪」—— 只读,不碰文件。只有 TOML 族给得出整段(JSON 族靠
 * `registerAshMcp` 自己就写得进去,轮不到手工)。仓库里还没 build 出 MCP 产物时也给不出。
 *
 * 谁要它:执行器列表那一行的只读诊断。注册那一下没写成的原因里本来就带着这一段
 * (`byHand`),刷新之后也得照样抄得到,不然用户只剩一句「没有登记」。
 */
export function ashMcpHandBlock(
  agentType: string,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; block: string } | null {
  const mechanism = ashMcpMechanism(agentType);
  if (mechanism?.kind !== "file" || !blockShape(mechanism.shape)) return null;
  const entry = builtinEntry();
  if (!entry) return null;
  const block = mechanism.shape.blockFor(entry, {
    enabled: mechanism.writeEnabled === true,
    ...(mechanism.writeType ? { type: mechanism.writeType } : {}),
  });
  return { file: siteFileFor(agentType, dir, mechanism.site, env), block };
}

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
      const state = effectiveConfigState(sources, readingFor(mechanism));
      if (state.state === "present") return { ok: true, serverName: state.serverName ?? ASH_MCP_SERVER_NAME };
      if (state.state === "disabled") return fail(`${state.detail}，没有替你打开`);
      if (state.state === "unknown") {
        return fail(`看不准这家 CLI 到底有没有 ash MCP 登记（${state.detail}），所以没有自动补写 ——`
          + "你那几份配置一个字节都没动");
      }
    }
  }
  return await publishFresh<AshMcpRegisterResult>(file, async (read, commit) => {
    const found = mechanism.shape.read(read.text, mechanism.switches);
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
  const host = hostFact(agentType, hostHome, env);
  if (blockShape(shape)) {
    // 宿主那段原样搬(连子表一起),没有就按一条登记现渲染一段。
    let block = host?.block ?? null;
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
  const hostValue = host?.raw ?? null;
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
 * 宿主机上**最终生效**那条 ash 登记的事实(没有生效的那条就 null) —— 搬运的唯一来源。
 *
 * 为什么是「事实」而不是「某一份配置的全文」(本轮审查 F1):上一版取的是赢家那一份的全文、
 * 再按名字在里面重新找一遍,于是
 *  · 跟解析层各算一次「选哪条」,两套判据迟早分叉(上一轮 F3 就是这么漏的);
 *  · **跨来源继承来的字段整个丢掉** —— 全局那份写着完整启动命令、`OPENCODE_CONFIG` 那份
 *    只写 `{"enabled": true}` 时,真 CLI 用的是合起来那一条,而按赢家那一份搬过去的只有
 *    一个 `enabled` 键:注册报成功,隔离档里真 CLI 打印 `No MCP servers configured`。
 *
 * 现在直接用 `resolveAshMcp` 算出来的那条 `fact`:JSON 两族读它的 `raw`(合完的原值)、
 * TOML 族读它的 `block`(整段原文),判定、诊断、搬运因此永远是同一条。
 */
function hostFact(agentType: string, hostHome: string, env: NodeJS.ProcessEnv): AshMcpNameFact | null {
  const mechanism = ashMcpMechanism(agentType);
  if (mechanism?.kind !== "file") return null;
  const sources = ashMcpHostSources(agentType, env, hostHome);
  const found = resolveAshMcp(sources, readingFor(mechanism));
  return found.state === "present" ? found.fact ?? null : null;
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