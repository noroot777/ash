// 安装时给各家 CLI 的**宿主机**配置补上 ash MCP 登记 —— 裸 Node 那一份。
//
// 为什么又有一份:`setup.mjs` 跑在裸 Node 上(npm run setup 时还没 build 过),导不进
// server 那边的 TypeScript。所以同一条规矩在这个仓库里有两份实现,靠回归测试钉着不漂:
// `server/scripts/test-ash-mcp-registry.ts` 会把这张表和 `mcp-registry/catalog.ts` 那张
// 逐项比对(路径、环境变量、格式族、要不要 enabled/type),对不上就红。
//
// 边界(用户 2026-10-30 的硬要求,这里是唯一会碰用户宿主配置的写入口):
//  · **只在缺 ash 条目时追加**,其它条目(含用户自己装的第三方 MCP)一个字节都不动;
//  · 已有 ash 或历史名 harness 一律不覆盖 —— 用户可能自己改过 URL 或路径;
//  · 读不出来、解析不了、有注释(序列化会丢注释)一律不写,如实回一句话;
//  · 落盘走 `config-publish.mjs` 那套**发布事务**(确认读到过 → 就地写 → 失败回写 → 写完
//    读回来比对)。本轮审查 R1:上一版直接 `writeFileSync`,注入一次 ENOSPC 就把用户整份
//    配置留成了半截 —— 有备份不等于失败安全,CLI 读的是活动那份。
//
// 「这家会读哪几份、合起来生效的是哪一条」拆到了 `mcp-host-sources.mjs`(站点表 + 来源 +
// 判定),这边只剩**拼内容 + 发布事务**。`HOST_SITES` 在这里再导出一次,`setup.mjs` 和
// 回归脚本的老导入路径照旧能用。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { publishConfirmed, readForWrite } from "./config-publish.mjs";
import { ASH, HOST_SITES, LEGACY, effectiveState, hostMcpFile, hostMcpSources } from "./mcp-host-sources.mjs";
import { readJsonLoose, spliceJsonMember } from "./json-edit.mjs";
import { scanTomlServers } from "./toml-scan.mjs";

export { HOST_SITES, hostMcpFile, hostMcpSources } from "./mcp-host-sources.mjs";

/**
 * 缺了就追加。返回 `{ file, added, why }`:`added:false` + `why` = 没写,原因如实说。
 *
 * 不认得的 agentType 直接抛 —— 调用方拼错名字该当场知道,不该静默跳过(静默正是这轮在治的病)。
 */
export function registerHostMcp({ agentType, mcpEntry, url, nodeBin = process.execPath, env = process.env, home = homedir() }) {
  const site = HOST_SITES[agentType];
  if (!site) throw new Error(`没有 ${agentType} 的 MCP 落点`);
  const file = hostMcpFile(agentType, { env, home });
  // 同目录有这家也读、而我们读不了格式的配置(trae 的原生 YAML)⇒ 一个字都不写:ash 可能
  // 已经写在那里面了,而同名登记同时来自两份配置、谁生效没有文档依据。
  const opaque = (site.opaque || []).map((parts) => join(dirname(file), ...parts)).find((f) => existsSync(f));
  if (opaque) {
    return {
      file,
      added: false,
      why: `${opaque} 这份配置 ${agentType} 也会读，而 ash 读不了它的格式，所以没动 ${file}`
        + "（请在那份配置里自己加一条 ash 登记，接法见 docs/install.md）",
    };
  }
  // **先看这家 CLI 会读的全部来源**(本轮审查 F4):判的是「最终生效的是哪一条」,不是
  // 「有没有任一份里有」—— 高优先级那份只写 `{"enabled": false}` 也会把低优先级那条关掉
  // (真 opencode 实测)。已经生效 ⇒ 不写(往别处补一条也顶不过它);关着 ⇒ 不替用户打开;
  // 看不准 ⇒ 不写,如实说。谁优先、合不合并见 `effectiveState` 与站点上的 `sourcesMerge`。
  //
  // **只读一份的家也走这里**(本轮审查 F2):上一版只在 `sources.length > 1` 时问它,于是
  // 「这家自己的启停策略」只有多来源那几家消费得到 —— gemini 的根级 `mcp.excluded:["ash"]`
  // 明明把那条登记打成了 `Blocked`,安装器照样 `added:true`,用户看到的是「已接好」,那一轮
  // 起来一个 ash 工具都没有。判定、设置检查、安装写入资格消费的必须是**同一份逐家结论**。
  const sources = hostMcpSources(agentType, { env, home });
  const state = effectiveState(sources, site);
  if (state.state === "present") {
    const also = sources.length > 1 ? `（${agentType} 也会读这份）` : "";
    return { file: state.label, added: false, why: `${state.label} 里已经有生效的 ${state.name} 登记${also}，不动它` };
  }
  if (state.state === "disabled") {
    return { file, added: false, why: `${state.why} —— 没有替你打开` };
  }
  if (state.state === "unsure") {
    return { file, added: false, why: `${state.why} —— 看不准就不写，你那几份配置一个字节都没动` };
  }
  // **先拿到一次成功的读**:读不动不是「空」(见 config-publish.mjs 的 readForWrite)。
  const read = readForWrite(file);
  if (!read) return { file, added: false, why: `${file} 读不出来，没有自动补写` };
  const entry = { command: nodeBin, args: [mcpEntry], env: { ASH_URL: url } };
  const written = site.shape === "toml"
    ? composeToml(read.text, entry, site)
    : composeJson(read.text, entry, site, file);
  if (!written.body) return { file, added: false, why: written.why };
  const published = publishConfirmed({ file, previous: read.text, body: written.body });
  if (!published.ok) return { file, added: false, why: published.why };
  return { file, added: true, backup: published.backup };
}

/** `mcpServers`(claude/gemini/kimi/cursor/qwen/qoder/copilot/kiro/antigravity/pi)与 opencode 的 `mcp`。 */
function composeJson(text, entry, site, file) {
  const container = site.shape === "opencode" ? "mcp" : "mcpServers";
  const doc = readJsonLoose(text);
  if (doc === undefined) return { why: `${file} 解析不了，没动它 —— 手工修好再重跑 setup` };
  const servers = doc === null ? undefined : doc[container];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    return { why: `${file} 的 ${container} 不是对象，没动它` };
  }
  const taken = [ASH, LEGACY].filter((n) => servers && Object.hasOwn(servers, n));
  if (taken.length) return { why: `${file} 里已经有 ${taken.join(" / ")} 登记，不动它` };
  const value = site.shape === "opencode"
    ? { type: "local", command: [entry.command, ...entry.args], environment: { ...entry.env }, enabled: true }
    : site.type ? { type: site.type, ...entry } : entry;
  // **文本插入,不重新序列化**(本轮审查 R4):大整数、`1e999`、`-0`、重复键、注释、键序、
  // 缩进全按字节留着 —— 上一版 `JSON.parse` → `JSON.stringify` 往返会悄悄改掉用户保存的值。
  // 也因此带注释的 `.jsonc` 现在能自动补接了(原来只能如实说一句、让用户自己加)。
  const spliced = spliceJsonMember(text, container, ASH, value);
  if (!spliced.body) return { why: `${file}：${spliced.why}` };
  // **发布前把候选自己再读一遍**(本轮审查 F5):「写进去了」不等于「生效的那条就是它」——
  // 同名容器重复时,生效的是最后一个(`JSON.parse` 语义)。编辑器现在也插在最后那个里,
  // 但前置条件要由这里独立确认一次:读不出来、或者读出来的不是我们这条,一律不写。
  // TOML 那一族同理(见 composeToml 末尾),两族都不许只凭「字节落盘了」报成功。
  const back = readJsonLoose(spliced.body);
  const live = back === null || back === undefined ? undefined : back[container];
  if (!live || typeof live !== "object" || Array.isArray(live) || !Object.hasOwn(live, ASH)) {
    return { why: `${file}：拼出来的配置里，生效的那个 ${container} 容器仍然没有 ash 登记，所以没写` };
  }
  return { body: spliced.body };
}

/** `[mcp_servers.ash]`(grok;codex 走 `codex-mcp.mjs` 那条带 CLI 批准的路)。 */
function composeToml(text, entry, site) {
  const current = text === null ? "" : text;
  const scan = scanTomlServers(current);
  // 判不准一律不写:TOML 里重复一张同名表会让 CLI 整份配置都读不出来,连用户别的 MCP 一起没了。
  if (scan.why) return { why: `${scan.why}，所以没敢自动追加（写重了会让整份配置读不出来）` };
  const taken = scan.names.filter((n) => n === ASH || n === LEGACY);
  if (taken.length) return { why: `配置里已经有 ${taken.join(" / ")} 这条登记了，不动它` };
  // 根级那个开关**只在声明了它的那家才算**(本轮审查 F2:grok 认、codex 不认,都是实测)。
  const rootKey = site.switches?.off?.length === 1 ? site.switches.off[0] : null;
  const rootOff = rootKey ? scan.rootArrays[rootKey] || [] : [];
  if (rootOff.some((n) => n === ASH || n === LEGACY)) {
    return { why: `配置里的 ${rootKey} 关掉了 ${rootOff.join(" / ")}，没有替你打开` };
  }
  const lines = [
    `[mcp_servers.${ASH}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
  ];
  if (site.enabled) lines.push("enabled = true");
  lines.push("", `[mcp_servers.${ASH}.env]`);
  for (const [k, v] of Object.entries(entry.env)) lines.push(`${k} = ${JSON.stringify(v)}`);
  const block = lines.join("\n");
  const body = current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`;
  // **发布前把候选自己再扫一遍**(本轮审查 R2):重复一张同名表会让 CLI 整份配置都读不出来,
  // 所以「拼完之后恰好一张 ash 表、而且还扫得准」是写出去的前置条件 —— 不能只信扫描器判对。
  const after = scanTomlServers(body);
  if (after.why) return { why: `拼出来的配置自己又读不准了（${after.why}），所以没写` };
  if (!after.names.includes(ASH)) return { why: "拼出来的配置自己又读不出那条 ash 登记，所以没写" };
  if (after.duplicateTables.includes(ASH)) {
    return { why: "拼出来的配置里有不止一张 ash 表（TOML 不许重复表，CLI 会整份拒载），所以没写" };
  }
  return { body };
}

