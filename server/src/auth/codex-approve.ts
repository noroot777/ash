// 「这份 TOML codex 自己读不读得通」—— 只有 codex 本人说了算,所以补写前问它一次。
//
// 从 `user-cli-mcp.ts` 搬出来的(内容没动):那边现在按 `mcp-registry` 那张表给十五家 CLI
// 通用地补登记,而「发布前先问 CLI 本人」这一关**只有 codex 有**(它的格式是 TOML,判官在
// 它进程里;JSON 那两族的真解析器就在我们手上,`JSON.parse` 认了就是对方也认)。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { probeCli, type ProbeOutcome } from "../ash-mcp-probe.js";
import { TMP_MODE } from "./config-publish.js";

/** 候选交给 CLI 本人读一遍的结论。`unasked` = **问不出来**,调用方据此不发布。 */
export type ApprovalVerdict = { state: "ok" | "bad" | "unasked"; why: string };

/**
 * 没补接成功时给的办法。**必须带上那段内容** —— 问不动 codex 的机器（macOS 上探测层如实
 * 弃权，见 `codexAccepts`）从此一律不自动补接，只剩这条路能让 agent 交得了卷。
 */
export const byHand = (file: string, block: string): string =>
  `，所以没有替你写进去（你那份配置一个字节都没动）。要手工接的话，把这段加到 ${file} 末尾：\n${block}`;

/** 问一次 codex 本人:给它一个只放着候选配置的 `CODEX_HOME`。**测试会换成替身**(见 `ensureAshMcp`)。 */
export type CodexAsk = (sandbox: string) => Promise<ProbeOutcome>;

/** 问 codex 本人花多久算问不动。它只是个只读子命令,本机实测几百毫秒。 */
const CODEX_ASK_MS = 10_000;

export const askCodexHere: CodexAsk = (sandbox) => probeCli(
  "codex",
  ["mcp", "list", "--json"],
  { ...process.env, CODEX_HOME: sandbox },
  // `cwd` 刻意也设成沙盘:`codex mcp list` 会把**项目级** `.codex/config.toml` 合进来,
  // 在仓库里问的话,别人项目配置里的毛病会算到这份候选头上,项目里的 ash 登记又会给一份
  // 其实不成立的候选背书。
  sandbox,
  CODEX_ASK_MS,
);

/**
 * 把**候选内容**交给 codex 本人解析一遍 —— 「这份 TOML 合不合法」只有它说了算。
 *
 * 为什么不能只拿我们自己的扫描器复核:它是个**结构**扫描器,看得出新表头落进了文件里,
 * 证不了这个表头在这份 TOML 上**合法**。`sealed` 把实测到的那一种挡在写之前了,但那是枚举;
 * 这一问才是真实解析。`scripts/codex-mcp.mjs` 里 setup 那条路也是这么问的,两边对「什么叫
 * 真的读通了」只有一个答案。
 *
 * 本轮审查改了两件事:
 *  ① **问的是沙盘里的一份副本,不是用户那个文件**(F1)。上一版先把候选写进用户的
 *    `config.toml` 再问,验不过才还原 —— 那期间盘上躺着的是一份 codex 整份拒载的配置
 *    (中间崩一次就留在那儿了),而还原本身又是第二次写,会盖掉别人同时存下的设置(N5)。
 *    候选和要发布的内容逐字节相同,而「这份 TOML 读不读得通」只取决于内容,所以沙盘里
 *    问出来的结论照样算。
 *  ② **走探测执行层**(`probeCli`),不自己 spawn(F2)。那是这台机器上唯一保证「起了进程
 *    就收得回来」的路:异步(不堵事件循环)、启动前先拿到内核圈定的归属、每条结束路径都
 *    现读成员集合下刀。上一版用的是 `spawnSync`,Windows 真机实测包装退出之后那个查询还
 *    活着(PID 25544 / 18208),而同步调用期间整个 server 的事件循环被堵满十秒。
 *
 * **「问不出来」不等于「可以发布」**(F1 的本体):超时、起不来、输出看不懂一律答 `unasked`,
 * 调用方据此**不发布**。拿不到安全归属的机器(macOS 弃权)于是一律不自动补接,改走
 * `byHand` 那条 —— 宁可如实说「没接上,这段你手工加」,也不留一份没人证过的配置,
 * 让 codex 连别人的 MCP 一起加载不了。
 */
export async function codexAccepts(
  candidate: string,
  ask: CodexAsk,
): Promise<ApprovalVerdict> {
  // 沙盘必须落在**任何项目配置的祖先链之外**(本轮审查 F2)。上一版把它放进 ash 自己的
  // `data/tmp`,那还在 ash 这个检出目录里 —— `codex mcp list` 会按 cwd 往上找项目级
  // `.codex/config.toml` 并合进来,于是真机上出现过:候选本身好得很,只因 ash 仓库的祖先
  // 配置里写了一句 `[mcp_servers.ash] enabled = false`,判决就成了「你的个人配置里 ash 是
  // 关着的」,一份本该发布的配置被拒掉。系统临时目录没有这条祖先链,同一份字节在那里问
  // 出来的才是候选自己的答案。
  //
  // (当初搬去 `data/tmp` 是为了躲 codex 在 `%TEMP%` 下那句「拒绝在临时目录里建 PATH
  // 别名」的告警 —— 那只是噪音,现在在下面按 `WARNING:` 滤掉,不该拿判决的正确性去换。)
  const sandbox = mkdtempSync(join(tmpdir(), "ash-mcp-ask-"));
  try {
    writeFileSync(join(sandbox, "config.toml"), candidate, { encoding: "utf8", mode: TMP_MODE });
    const outcome = await ask(sandbox);
    if (outcome.kind === "not-started") {
      return { state: "unasked", why: `这台机器上没法安全地起一次 codex 来确认这份配置读得通（${outcome.why}）` };
    }
    if (outcome.kind === "unqueryable") return { state: "unasked", why: "问了 codex，但它没给出一份能用的答案" };
    if (outcome.code !== 0) {
      const lines = `${outcome.stderr}\n${outcome.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
      // 告警不是原因:临时 `CODEX_HOME` 下 codex 会先喊一句「拒绝在临时目录里建 PATH 别名」,
      // 它跟这份配置读不读得通毫无关系,混进去只会把真正那句挤掉。滤完一句不剩才退回原话。
      const blamed = lines.filter((l) => !/^WARNING:/i.test(l));
      const said = (blamed.length ? blamed : lines).slice(0, 3).join(" / ");
      return { state: "bad", why: `codex 读不动补上那段之后的配置（退出码 ${outcome.code}）：${said}` };
    }
    let listed: unknown;
    try { listed = JSON.parse(outcome.stdout); } catch { return { state: "unasked", why: "codex mcp list 的输出看不懂" }; }
    if (!Array.isArray(listed)) return { state: "unasked", why: "codex mcp list 的输出不是列表" };
    const hit = listed.find((e) => (e as { name?: unknown } | null)?.name === ASH_MCP_SERVER_NAME) as
      { enabled?: unknown } | undefined;
    if (!hit) return { state: "bad", why: `codex 读完这份配置，仍然没列出 ${ASH_MCP_SERVER_NAME}` };
    if (hit.enabled === false) return { state: "bad", why: `codex 说这份配置里的 ${ASH_MCP_SERVER_NAME} 是关着的` };
    return { state: "ok", why: "" };
  } finally {
    await discardSandbox(sandbox);
  }
}

/**
 * 清掉问完的沙盘。**清不掉不许改判决**（本轮审查 N7）：Windows 真机上查询刚退出、句柄还
 * 没放，`rmSync` 会 EBUSY —— 上一版那一下直接把一个已经成立的「codex 收下了」变成「补写
 * 失败」，用户白跑一趟。所以这里只重试几次，仍然删不掉就留一句警告，结论照原样交回去。
 *
 * 两次重试之间那个 150ms **不许 unref**：事件循环里只剩它的时候（命令行脚本、回归测试）
 * unref 掉的 timer 不保活，整个进程当场退出，等它的那条 await 永远不结算 —— 调用方拿不到
 * 结论，也不会报错。多拖最多 300ms 换一条确定会走完的路，值。
 */
async function discardSandbox(dir: string): Promise<void> {
  for (let left = 3; left > 0; left--) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (left === 1) {
        console.warn(`[ash] 问 codex 用的临时目录没删掉（${(e as Error).message}），残留在 ${dir}；这次的结论不受影响`);
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
