import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export async function checkPortableReachability(): Promise<void> {
  const { ashMcpReachability } = await import("../src/ash-mcp-reachability.js");
  assert.equal((await ashMcpReachability({ agentType: "grok" })).reachable, true, "别的执行器一律放行");

  const { reviewCwdCandidates } = await import("../src/free-review-round.js");
  const sessionsDesc = [
    { cwd: null, worktreePath: null },
    { cwd: "/w/new", worktreePath: "/wt/new" },
    { cwd: "/w/old", worktreePath: "/wt/old" },
    { cwd: "/w/new", worktreePath: null },
  ];
  assert.deepEqual(
    reviewCwdCandidates("/explicit", sessionsDesc, "/workspace"),
    ["/explicit", "/w/new", "/wt/new", "/w/old", "/wt/old", "/workspace"],
    "超集包含所有会话的两个目录字段，去重、丢空值",
  );
  assert.deepEqual(reviewCwdCandidates(undefined, [], "/workspace"), ["/workspace"],
    "一条会话都没有时也要有任务工作区兜底");
  const orchestrator = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
  const recorded = /const recorded = (opts\.cwd[^;]*);/.exec(orchestrator)?.[1];
  assert.ok(recorded, "orchestrator 里 recorded 的取值来源必须找得到");
  assert.deepEqual(recorded.split("||").map((value) => value.trim()),
    ["opts.cwd", "prev?.cwd", "prev?.worktreePath", "all[0]?.cwd", "all[0]?.worktreePath", '""'],
    "候选目录覆盖 recorded 的所有取值来源");
  assert.match(orchestrator.slice(orchestrator.indexOf("const recorded = opts.cwd")),
    /if \(!existsSync\(cwd\)\)[\s\S]{0,400}?taskWorkspace\(/,
    "失效目录的回退仍是候选超集末尾的任务工作区");
  console.log("✅ 平台无关预检：执行器放行与候选目录超集");

  for (const file of ["../src/ash-mcp-reachability.ts", "../src/ash-mcp-probe.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /import \{ resolveLaunch \} from "[^"]*bin-resolve\.js"/,
      `${file} 必须从 bin-resolve 取 resolveLaunch`);
    const code = source.split("\n").filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line)).join("\n");
    assert.ok(!/\bresolveBin\b/.test(code), `${file} 不使用只能判存在性的 resolveBin 启动进程`);
  }
  const judge = readFileSync(new URL("../src/ash-mcp-reachability.ts", import.meta.url), "utf8")
    .split("\n").filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line)).join("\n");
  assert.ok(!/\b(?:execFile|spawn|spawnSync|execFileSync)\b/.test(judge), "判据层不自行启动进程");
  assert.match(judge, /probeCli\(bin, \[\.\.\.extraArgs, "mcp", "list", "--json"\]/,
    "codex 探测原样传递归一后的整份 extraArgs");
  console.log("✅ 平台无关预检：启动计划依赖与探测层结构守卫");

  const { claudeMcpEvidence, codexMcpEvidence } = await import("../src/review-channel-gap.js");
  const init = (servers: unknown[]) => JSON.stringify({ type: "system", subtype: "init", mcp_servers: servers });
  const mixedServers = [{ name: "ash", status: "failed" }, { name: "harness", status: "connected" }];
  for (const servers of [mixedServers, [...mixedServers].reverse()]) {
    const evidence = claudeMcpEvidence(init(servers));
    assert.equal(evidence?.connected, true, "任一兼容登记连上都不能诊断成断开");
    assert.match(evidence?.detail ?? "", /2 份兼容登记/);
  }
  assert.equal(claudeMcpEvidence(init([
    { name: "ash", status: "failed" }, { name: "harness", status: "failed" },
  ]))?.connected, false, "两份都没连上才算没连上");
  assert.equal(claudeMcpEvidence(init([{ name: "linear", status: "connected" }]))?.connected, false);
  assert.equal(claudeMcpEvidence("not json\n{}"), null);

  const unrelated = "WARN MCP client for linear failed: OAuth authorization required";
  for (const text of ["", "ordinary stderr", unrelated, `${unrelated}\nERROR mcp server github failed`]) {
    assert.equal(codexMcpEvidence(text), null, "其它 MCP 的报错不能作为 ash 断开的证据");
  }
  for (const name of ["ash", "harness"]) {
    const text = `\u001b[31mERROR mcp client for '${name}' failed: handshake closed\u001b[0m`;
    const evidence = codexMcpEvidence(`${unrelated}\n${text}\n${unrelated}`);
    assert.equal(evidence?.connected, false, "点名 ash 或历史名的 MCP 报错才可作证");
    assert.match(evidence?.detail ?? "", /handshake closed/);
    assert.doesNotMatch(evidence?.detail ?? "", /linear|OAuth|\u001b/);
  }
  const limited = codexMcpEvidence("ERROR mcp ash failed: first\nWARN mcp ash failed: second\nERROR mcp ash failed: third");
  assert.doesNotMatch(limited?.detail ?? "", /first/);
  assert.match(limited?.detail ?? "", /second\n.*third/);
  console.log("✅ 平台无关预检：claude 集合诊断与 codex 错误归属、去色、限量");
}
