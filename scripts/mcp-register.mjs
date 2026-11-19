// 把 navi MCP 登记进这台机器上装了的各家 CLI(agent 靠它交卷),改名之前的登记(`ash`、更早的 `harness`)
// 顺手迁成规范名。setup.mjs(装机)和 upgrade.mjs(升级)共用这一份。
//
// 幂等:已有 navi 条目的不重复写;但还留着的旧名条目(起的是 Navi 的 MCP 脚本)照样收掉 —— 不然每一回合
// 两套一模一样的工具同时挂着。claude / codex 走它们自己的 CLI,其余各家见 mcp-legacy-retire.mjs。
// 同名却起着别的程序的,是用户自己的东西,不动,报一句。
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WINDOWS, runCli, which } from "./platform.mjs";
import { HOST_SITES, registerHostMcp } from "./mcp-hosts.mjs";
import { parseCodexList, pointsAtNaviMcp, registerCodexMcp } from "./codex-mcp.mjs";
import { LEGACY_MCP_SERVER_NAMES } from "./legacy-names.mjs";
import { retireLegacyHostMcp } from "./mcp-legacy-retire.mjs";

// 必须能在声明支持的 Node 22.16 上裸跑；那一版不能无 flag 导入 .ts。
// 运行时代码的同名常量在 shared/src/mcp.ts，回归测试会把两边钉成同一个。
// 改名之前的登记在这里迁成规范名：Navi 起 claude/codex 时注入的是规范名，
// 用户级配置里再留一条旧名，那两家每一回合都会多挂一套同样的工具。
export const NAVI_MCP_SERVER_NAME = "navi";

/**
 * `claude mcp list` 的输出(每条一行 `<名字>: <命令行或地址> - <连通状态>`)→ navi 登记过没有、
 * 还在的旧名里哪些起的是 Navi 的 MCP 脚本(该删)、哪些同名却是别的东西(不动)。
 */
export function claudeEntries(stdout) {
  const line = (name) => String(stdout ?? "").split(/\r?\n/).find((l) => l.startsWith(`${name}: `));
  const olds = LEGACY_MCP_SERVER_NAMES.filter((old) => line(old) !== undefined);
  return {
    registered: line(NAVI_MCP_SERVER_NAME) !== undefined,
    legacy: olds.filter((old) => pointsAtNaviMcp(line(old))),
    foreign: olds.filter((old) => !pointsAtNaviMcp(line(old))),
  };
}

/** ok / warn / say 是调用方的三种输出(✓ / ⚠ / 原样一行)。 */
export function registerNaviMcp({ repo, port, ok, warn, say }) {
  const URL_BASE = `http://localhost:${port}`;
  const mcpEntry = join(repo, "mcp", "dist", "index.js");
  // ── claude ────────────────────────────────────────────────────────────────
  if (which("claude")) {
    const listed = runCli("claude", ["mcp", "list"]);
    const { registered, legacy, foreign } = claudeEntries(listed.stdout);
    // 旧名条目删不掉的留着(两个名字都能用),如实报出来、给出手动删的命令;不算失败。
    const removeLegacy = () => legacy.filter((old) => runCli("claude", ["mcp", "remove", old, "--scope", "user"]).status !== 0);
    const legacyWarn = (left, lead) =>
      warn(`claude:${lead},但旧 ${left.join(" / ")} 条目没删掉(每一回合会多挂一套同样的工具);可手动执行 ${left.map((old) => `claude mcp remove ${old} --scope user`).join("、")}`);
    if (registered) {
      if (!legacy.length) ok("claude:Navi 已注册,不动它");
      else {
        const left = removeLegacy();
        if (!left.length) ok(`claude:Navi 已注册;旧 ${legacy.join(" / ")} 条目已删掉(和 Navi 是同一套工具,留着每一回合会多挂一套)`);
        else legacyWarn(left, "Navi 已注册");
      }
    } else {
      const added = runCli("claude", [
        "mcp", "add", NAVI_MCP_SERVER_NAME, "--scope", "user", "-e", `NAVI_URL=${URL_BASE}`, "--", "node", mcpEntry,
      ]);
      if (added.status === 0) {
        if (legacy.length) {
          const left = removeLegacy();
          if (!left.length) ok(`claude:旧 ${legacy.join(" / ")} 条目已迁移为 Navi`);
          else legacyWarn(left, "Navi 已接好");
        } else {
          ok("claude:已注册 Navi(user 作用域,编排别的仓库时也在)");
        }
      }
      else {
        warn("claude mcp add 失败,手动跑:");
        say(`      claude mcp add ${NAVI_MCP_SERVER_NAME} --scope user -e NAVI_URL=${URL_BASE} -- node ${mcpEntry}`);
      }
    }
    if (foreign.length) say(`  · claude:${foreign.join(" / ")} 这个名字的条目起的不是 Navi 的 MCP 脚本,是别的东西,没动它`);
  } else {
    warn("没装 claude CLI,跳过它的 MCP 注册");
  }

  // ── codex ─────────────────────────────────────────────────────────────────
  const codexCfg = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  if (which("codex")) {
    // 在临时目录里问:codex 会把 cwd 那份项目级 `.codex/config.toml` 也合进来,这里只关心用户级。
    // 给了 home 就是在问(或改)沙盘里那份副本 —— cwd 也设成它,免得把谁的项目配置合进来。
    const listServers = (home) => {
      const res = runCli("codex", ["mcp", "list", "--json"], {
        cwd: home ?? tmpdir(), timeout: 60_000,
        ...(home ? { env: { ...process.env, CODEX_HOME: home } } : {}),
      });
      return parseCodexList(res.status, res.stdout);
    };
    // 删历史名只在沙盘里做(审查第 4 轮 F2):让 codex 去改用户真文件,它自己的 temp+rename
    // 会断掉硬链接,删到一半失败还会把那份配置留在中间状态。
    const removeServer = (name, home) =>
      runCli("codex", ["mcp", "remove", name], {
        cwd: home, timeout: 60_000, env: { ...process.env, CODEX_HOME: home },
      }).status === 0;
    const r = registerCodexMcp({
      configFile: codexCfg, mcpEntry, url: URL_BASE,
      name: NAVI_MCP_SERVER_NAME, legacyNames: LEGACY_MCP_SERVER_NAMES, listServers, removeServer,
    });
    const legacyHint = (left) => `旧 ${left.join(" / ")} 条目没删掉(每一回合会多挂一套同样的工具);可手动执行 ${left.map((old) => `codex mcp remove ${old}`).join("、")}`;
    if (r.action === "kept") {
      if (!r.enabled) warn(`codex:${codexCfg} 里的 Navi 写着 enabled = false,没有替你打开`);
      else if (!r.legacyLeft.length) ok(`codex:Navi 已在 ${codexCfg} 里,不动它`);
      if (r.legacyLeft.length) warn(`codex:Navi 已在 ${codexCfg} 里,但${legacyHint(r.legacyLeft)}`);
    } else if (r.action === "foreignChange") {
      warn(`codex:${r.why}${r.backup ? `(补写前的备份在 ${r.backup})` : ""};先看一眼 ${codexCfg} 现在的内容,再决定要不要重跑 setup`);
    } else if (r.action === "blocked") {
      // 现在「批准」发生在写之前(整条迁移在沙盘里做),所以没写成只有一种收场:一个字节都没动。
      warn(`codex:${r.why};没有动 ${codexCfg};先跑 codex mcp list 看它报什么、修好再重跑 setup`);
    } else if (r.legacyLeft.length) {
      warn(`codex:${r.action === "cleaned" ? "Navi 已在" : "已写入 Navi"} ${codexCfg},但${legacyHint(r.legacyLeft)}`);
    } else {
      const done = { cleaned: "Navi 已在,删掉了还留着的旧条目", migrated: "旧条目已迁移为 Navi", added: "已写入" }[r.action];
      ok(`codex:${done} ${codexCfg}${r.backup ? `(原文件备份在 ${r.backup})` : ""}`);
    }
    if (r.foreign?.length) say(`  · codex:${r.foreign.join(" / ")} 这个名字的条目起的不是 Navi 的 MCP 脚本,是别的东西,没动它`);
  } else {
    warn("没装 codex CLI,跳过它的 MCP 注册");
  }

  // ── 其余各家 ───────────────────────────────────────────────────────────────
  //
  // 一张表走完(`mcp-host-sources.mjs` 的 `HOST_SITES`,`mcp-hosts.mjs` 转一手):claude 走它自己的 `mcp add`(那是它的
  // 原生入口),codex 走 `codex-mcp.mjs`(发布前要让 codex 本人读一遍),**其余十二家都在
  // 这里**。2026-10-30 之前这里只有 kimi 一家,所以换别的 agent 跑任务一律交不了卷。
  //
  // 只给**这台机器上真装了**的那几家写:没装就建目录等于在用户家里乱留垃圾。
  for (const [agentType, site] of Object.entries(HOST_SITES)) {
    const bin = site.bins.map((b) => which(b)).find(Boolean)
      // kimi 的安装器不往 PATH 里放,官方装法是 `~/.kimi-code/bin`。
      || (agentType === "kimi" && !IS_WINDOWS
        ? which(join(process.env.KIMI_INSTALL_DIR || join(homedir(), ".kimi-code"), "bin", "kimi"))
        : null);
    if (!bin) continue;
    // 先把旧名登记收成 navi(mcp-legacy-retire.mjs):已有 navi 就删旧名,没有就原地改名;收不了只报一句。
    try {
      const retired = retireLegacyHostMcp({ agentType });
      for (const c of retired.changed) {
        const what = [c.renamed && `旧 ${c.renamed} 条目原地改名为 navi`, c.removed.length && `删掉旧 ${c.removed.join(" / ")} 条目(和 navi 是同一套工具)`].filter(Boolean).join(",");
        ok(`${agentType}:${what}(${c.file}${c.backup ? `,原文件备份在 ${c.backup}` : ""})`);
        if (c.renamed && c.launch && !c.launch.includes(mcpEntry)) {
          say(`  · ${agentType}:改名的那条起的是 ${c.launch.slice(0, 160)},不是这份检出的 ${mcpEntry};要换成这份,删掉它再跑一次 npm run upgrade`);
        }
      }
      if (retired.skipped) warn(`${agentType}:旧名登记没收成 navi —— ${retired.skipped}`);
      if (retired.foreign.length) say(`  · ${agentType}:${retired.foreign.join(" / ")} 这个名字的条目起的不是 Navi 的 MCP 脚本,是别的东西,没动它`);
      if (retired.unsure.length) say(`  · ${agentType}:${retired.unsure.join(" / ")} 这个名字的条目认不准起的是什么(启动命令的写法读不通),没动它;是 Navi 的就自己删掉`);
      for (const label of retired.readonly) say(`  · ${agentType}:${label} 里还有起着 Navi 脚本的旧名登记,那份 Navi 改不了,自己去掉它`);
    } catch (error) {
      warn(`${agentType}:收拾旧名登记时出错:${error.message}`);
    }
    try {
      const result = registerHostMcp({ agentType, mcpEntry, url: URL_BASE });
      if (result.added) ok(`${agentType}:已注册 Navi MCP (${result.file})`);
      else warn(`${agentType}:${result.why || "没有写入"}`);
    } catch (error) {
      warn(`${agentType} MCP 注册失败：${error.message}；手动接入见 docs/install.md`);
    }
  }
}
