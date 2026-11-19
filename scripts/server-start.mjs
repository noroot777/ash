// restart.mjs 与 upgrade.mjs 共用的「下线之后」那半截:起一个脱离本进程的 server 并认准它就绪,
// 再把旧代码的 navi MCP 子进程收掉。下线那半截在 server-control.mjs。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive, killPid, localJson, pidsRunningScript, sleep } from "./platform.mjs";
import { countOf, noVerdictReason, queryImpact } from "./server-control.mjs";

const START_DETACHED = fileURLToPath(new URL("./start-detached.mjs", import.meta.url));

/**
 * 起 server 并等它就绪。helper 自己退出后 child 归给 init/服务管理器,跟着完整继承 cwd 与 env
 * (理由见 start-detached.mjs 顶部)。端口此刻必须已经安静 —— 由调用方先过那道闸。
 *
 * 返回 { ok, pid, health } 就绪;{ ok:false, why } 没起来:
 *   spawn     启动命令本身没拉起
 *   impostor  端口上应答的是别的 pid(health.pid)
 *   timeout   等满 startTimeout 秒仍未就绪,但进程还活着
 *   exited    启动进程已经退了
 */
export async function launchServer({ port, log, serverNode, serverEntry, startTimeout, cwd = process.cwd(), env = process.env }) {
  const started = spawnSync(process.execPath, [START_DETACHED, log, serverNode, serverEntry], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
  const pid = Number((started.stdout || "").trim());
  if (started.status !== 0 || !Number.isInteger(pid) || pid <= 0) return { ok: false, why: "spawn" };

  let impostor = 0;
  const deadline = Date.now() + startTimeout * 1000;
  while (Date.now() < deadline) {
    const health = await localJson(port, "/api/health");
    // 认「就绪」之前先认人:health 带 pid 是为了让这里能分辨「新进程起来了」和「端口
    // 上还坐着另一个 navi」。旧版本 server 没有这个字段(undefined),那就退回只看通不通
    // —— 调用方那道「必须先安静」的闸已经保证了此刻端口上不会有别人。
    if (health && (!health.pid || health.pid === pid)) return { ok: true, pid, health };
    if (health?.pid) impostor = health.pid;
    // 启动进程已经退出就别傻等满超时；反之给迁移/重启接管留足时间。
    if (!isPidAlive(pid)) break;
    await sleep(200);
  }
  if (impostor) return { ok: false, why: "impostor", pid, impostor };
  return { ok: false, why: isPidAlive(pid) ? "timeout" : "exited", pid };
}

/**
 * 收掉跑旧 mcp/dist 的 navi MCP 子进程(各 Codex/Claude 会话自己 spawn 的 stdio 进程,不是常驻端口),
 * 客户端下次用到时会用新的 mcp/dist 重新拉起。
 *
 * **这一刀是唯一真能伤到正在干活的 agent 的地方**:通道一断,它那轮的 report_stage/complete_task 就撞
 * `Transport closed`。所以先在服务端重启完之后问「谁手里还握着 MCP」(restart-impact 的 mcpDisrupted),
 * 有人握着就默认跳过并说明;**问不到当作有人握着** —— 掐断在跑的 agent 是不可逆的,不知道就别掐。
 * (兜底另有一层:navi 会在回合结算时补录那些「确定没送达」的交卷调用,见 server/src/mcp-handoff.ts;
 * 但白名单只有三个工具,能不掐断还是不掐断。)
 */
export async function refreshMcp({ repo, port, lockFile, skip, force, say, command }) {
  const after = await queryImpact(port, lockFile);
  const why = noVerdictReason(after);
  const holders = countOf(after, "mcpDisrupted");
  if (skip) {
    say("  ⏭ SKIP_MCP:跳过——不动 MCP 子进程,正在用 Navi MCP 的会话不会被打断。");
    say("     (代价:这些会话仍跑旧 mcp/dist;只有改了 mcp/ 才需去掉 --skip-mcp / SKIP_MCP 再跑一次。)");
  } else if (why !== null && !force) {
    say(`  ⏭ 问不到「谁还握着 MCP 通道」(${why}),已跳过刷新 —— 宁可让旧会话跑旧 mcp,也不冒险掐断在跑的 agent。`);
    say(`     确定要刷新:  ${command("--force-mcp")}`);
  } else if (holders > 0 && !force) {
    // 刷新 MCP 的收益只是「旧会话用上新 mcp 代码」,代价却是它这一轮的交卷调用当场失败(2026-08-06 验证白跑)。
    say(`  ⏭ 有 ${holders} 个正在干活的 agent 手里握着 Navi MCP 通道,已跳过刷新以免掐断它们的交卷。`);
    for (const t of after.mcpDisrupted.slice(0, 8)) say(`     · ${t.title} (pid ${t.pid})`);
    say(`     (:${port} 已经是新代码;这些会话仍跑旧 mcp/dist。)`);
    say(`     改了 mcp/ 需要立刻生效:  ${command("--force-mcp")}`);
  } else {
    const stale = pidsRunningScript(join(repo, "mcp", "dist", "index.js"));
    if (stale.length) {
      if (holders > 0) say(`  ⚠ 强制刷新:${holders} 个在跑的 agent 手里的 MCP 通道会被掐断,它们这一轮的交卷调用会失败。`);
      for (const pid of stale) killPid(pid);
      say(`  ✓ 清掉 ${stale.length} 个旧 MCP 进程,下次会话/调用即用新代码`);
    } else {
      say("  (没有在跑的旧 MCP 进程;新会话会直接用新 mcp/dist)");
    }
  }
}
