// 把 navi MCP 登记进这台机器上装了的各家 CLI(agent 靠它交卷),改名之前的登记(`ash`、更早的 `harness`)
// 顺手迁成规范名。setup.mjs(装机)和 upgrade.mjs(升级)共用这一份。
//
// 幂等:已有 navi 条目的不动,不会重复写配置。
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WINDOWS, runCli, which } from "./platform.mjs";
import { HOST_SITES, registerHostMcp } from "./mcp-hosts.mjs";
import { parseCodexList, registerCodexMcp } from "./codex-mcp.mjs";
import { LEGACY_MCP_SERVER_NAMES } from "./legacy-names.mjs";

// 必须能在声明支持的 Node 22.16 上裸跑；那一版不能无 flag 导入 .ts。
// 运行时代码的同名常量在 shared/src/mcp.ts，回归测试会把两边钉成同一个。
// 改名之前的登记在这里迁成规范名：Navi 起 claude/codex 时注入的是规范名，
// 用户级配置里再留一条旧名，那两家每一回合都会多挂一套同样的工具。
export const NAVI_MCP_SERVER_NAME = "navi";

/** ok / warn / say 是调用方的三种输出(✓ / ⚠ / 原样一行)。 */
export function registerNaviMcp({ repo, port, ok, warn, say }) {
  const URL_BASE = `http://localhost:${port}`;
  const mcpEntry = join(repo, "mcp", "dist", "index.js");
  // ── claude ────────────────────────────────────────────────────────────────
  if (which("claude")) {
    const listed = runCli("claude", ["mcp", "list"]);
    if (new RegExp(`^${NAVI_MCP_SERVER_NAME}:`, "m").test(listed.stdout)) {
      ok("claude:Navi 已注册,不动它");
    } else {
      const legacy = LEGACY_MCP_SERVER_NAMES.filter((old) => new RegExp(`^${old}:`, "m").test(listed.stdout));
      const added = runCli("claude", [
        "mcp", "add", NAVI_MCP_SERVER_NAME, "--scope", "user", "-e", `NAVI_URL=${URL_BASE}`, "--", "node", mcpEntry,
      ]);
      if (added.status === 0) {
        if (legacy.length) {
          const left = legacy.filter((old) => runCli("claude", ["mcp", "remove", old, "--scope", "user"]).status !== 0);
          if (!left.length) ok(`claude:旧 ${legacy.join(" / ")} 条目已迁移为 Navi`);
          else warn(`claude:Navi 已接好,但旧 ${left.join(" / ")} 条目没删掉;可手动执行 ${left.map((old) => `claude mcp remove ${old} --scope user`).join("、")}`);
        } else {
          ok("claude:已注册 Navi(user 作用域,编排别的仓库时也在)");
        }
      }
      else {
        warn("claude mcp add 失败,手动跑:");
        say(`      claude mcp add ${NAVI_MCP_SERVER_NAME} --scope user -e NAVI_URL=${URL_BASE} -- node ${mcpEntry}`);
      }
    }
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
    if (r.action === "kept") {
      if (r.enabled) ok(`codex:Navi 已在 ${codexCfg} 里,不动它`);
      else warn(`codex:${codexCfg} 里的 Navi 写着 enabled = false,没有替你打开`);
    } else if (r.action === "foreignChange") {
      warn(`codex:${r.why}${r.backup ? `(补写前的备份在 ${r.backup})` : ""};先看一眼 ${codexCfg} 现在的内容,再决定要不要重跑 setup`);
    } else if (r.action === "blocked") {
      // 现在「批准」发生在写之前(整条迁移在沙盘里做),所以没写成只有一种收场:一个字节都没动。
      warn(`codex:${r.why};没有动 ${codexCfg};先跑 codex mcp list 看它报什么、修好再重跑 setup`);
    } else if (r.legacyLeft) {
      warn(`codex:已写入 Navi,但旧条目(${LEGACY_MCP_SERVER_NAMES.join(" / ")} 之一)没删掉(几个名字都能用);可手动执行 codex mcp remove <旧名>`);
    } else {
      ok(`codex:${r.action === "migrated" ? "旧条目已迁移为 Navi" : "已写入"} ${codexCfg}${r.backup ? "(原文件备份在同名 .bak-navi-setup)" : ""}`);
    }
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
    try {
      const result = registerHostMcp({ agentType, mcpEntry, url: URL_BASE });
      if (result.added) ok(`${agentType}:已注册 Navi MCP (${result.file})`);
      else warn(`${agentType}:${result.why || "没有写入"}`);
    } catch (error) {
      warn(`${agentType} MCP 注册失败：${error.message}；手动接入见 docs/install.md`);
    }
  }
}
