import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexList, registerCodexMcp } from "./codex-mcp.mjs";
import { IS_WINDOWS, which } from "./platform.mjs";

const directory = mkdtempSync(join(tmpdir(), "ash-codex-mcp-setup-"));
const file = join(directory, "config.toml");
const base = {
  configFile: file, mcpEntry: "C:\\ash\\mcp\\dist\\index.js", url: "http://localhost:4317",
  name: "ash", legacyName: "harness", removeServer: () => assert.fail("不该去删任何登记"),
};
/** 按顺序吐出预先写好的「codex 本人的回答」。 */
const answers = (...seq) => () => seq.shift() ?? assert.fail("多问了一次 codex");
const listed = (...names) => ({ ok: true, servers: names.map((name) => ({ name, enabled: true })) });

try {
  assert.deepEqual(parseCodexList(0, '[{"name":"ash","enabled":false}]'), { ok: true, servers: [{ name: "ash", enabled: false }] });
  assert.equal(parseCodexList(1, "").ok, false, "codex 自己报错退出 = 读不动");
  assert.equal(parseCodexList(0, "Error: x").ok, false);

  // codex 说已经有了(哪种拼法都一样) → 一个字都不写。
  const quoted = `[mcp_servers."ash"]\ncommand = "node"\n`;
  writeFileSync(file, quoted);
  assert.deepEqual(registerCodexMcp({ ...base, listServers: answers(listed("ash")) }), { action: "kept", enabled: true });
  assert.equal(readFileSync(file, "utf8"), quoted);
  assert.equal(existsSync(`${file}.bak-ash-setup`), false);

  // codex 读不动现在这份配置 → 不写、不备份(写了只会让它更坏)。
  const broken = `[mcp_servers.ash]\ncommand = "a"\n[mcp_servers.ash]\ncommand = "b"\n`;
  writeFileSync(file, broken);
  const blocked = registerCodexMcp({ ...base, listServers: answers({ ok: false, why: "codex mcp list 退出码 1" }) });
  assert.equal(blocked.action, "blocked");
  assert.equal(readFileSync(file, "utf8"), broken);
  assert.equal(existsSync(`${file}.bak-ash-setup`), false);

  // 确实没有 → 追加;Windows 路径的反斜杠要成对。
  writeFileSync(file, `model = "x"\n`);
  const added = registerCodexMcp({ ...base, listServers: answers(listed("kb"), listed("kb", "ash")) });
  assert.equal(added.action, "added");
  const written = readFileSync(file, "utf8");
  assert.ok(written.startsWith(`model = "x"\n`) && written.includes(`args = ["C:\\\\ash\\\\mcp\\\\dist\\\\index.js"]`));
  assert.equal(readFileSync(`${file}.bak-ash-setup`, "utf8"), `model = "x"\n`);

  // 写完 codex 读不动了 → 原样还回去;原本没有文件就删掉。
  const before = `model = "y"\n`;
  writeFileSync(file, before);
  const back = registerCodexMcp({ ...base, listServers: answers(listed(), { ok: false, why: "codex mcp list 退出码 1" }) });
  assert.equal(back.action, "rolledBack");
  assert.equal(readFileSync(file, "utf8"), before);
  rmSync(file);
  assert.equal(registerCodexMcp({ ...base, listServers: answers(listed(), listed()) }).action, "rolledBack");
  assert.equal(existsSync(file), false, "原来没有的文件不许留下半截");

  // 只有历史名 → 让 codex 删旧的、再补规范名。
  writeFileSync(file, `[mcp_servers.harness]\ncommand = "node"\n[other]\nk = 1\n`);
  const removed = [];
  const codexRemoves = (name) => { removed.push(name); writeFileSync(file, `[other]\nk = 1\n`); return true; };
  const mig = registerCodexMcp({ ...base, listServers: answers(listed("harness"), listed("ash")), removeServer: codexRemoves });
  assert.equal(mig.action, "migrated");
  assert.deepEqual(removed, ["harness"], "删旧条目交给 codex 本人");
  const migrated = readFileSync(file, "utf8");
  assert.ok(migrated.startsWith(`[other]\nk = 1\n`) && migrated.includes("[mcp_servers.ash]"), "在 codex 删完的那份上追加");
  // codex 删不掉(文件没动) → 两个名字并存也能用,如实报「没删掉」,不说「已迁移」。
  writeFileSync(file, `[mcp_servers.harness]\ncommand = "node"\n`);
  const kept = registerCodexMcp({ ...base, listServers: answers(listed("harness"), listed("harness", "ash")), removeServer: () => false });
  assert.equal(kept.action, "added");
  assert.equal(kept.legacyLeft, true);
  // 写完读不动 → 回滚,并把备份在哪交出来。
  writeFileSync(file, `model = "z"\n`);
  const rb = registerCodexMcp({ ...base, listServers: answers(listed(), { ok: false, why: "x" }) });
  assert.equal(rb.backup, `${file}.bak-ash-setup`);
  assert.equal(existsSync(`${file}.ash-tmp`), false, "原子写不留临时文件");

  // 审查复现的原样形状,问真 codex:带引号的登记它认得 → 不追加;重复定义它读不动 → 不动。
  const codex = which("codex");
  if (codex) {
    const home = join(directory, "home");
    const askCodex = (args) => {
      const shell = IS_WINDOWS && /\.(cmd|bat)$/i.test(codex);
      return spawnSync(shell ? `"${codex}"` : codex, args, {
        encoding: "utf8", windowsHide: true, shell, cwd: tmpdir(), timeout: 60_000, env: { ...process.env, CODEX_HOME: home },
      });
    };
    const real = () => {
      const res = askCodex(["mcp", "list", "--json"]);
      return parseCodexList(res.status ?? 1, res.stdout ?? "");
    };
    const realRemove = (name) => askCodex(["mcp", "remove", name]).status === 0;
    const cfg = join(home, "config.toml");
    const realQuoted = `model = "gpt-5"\n\n[mcp_servers."ash"]\ncommand = "node"\nargs = ["/x/y.js"]\n\n[mcp_servers."ash".env]\nASH_URL = "http://localhost:4317"\n`;
    mkdirSync(home, { recursive: true });
    writeFileSync(cfg, realQuoted);
    assert.equal(registerCodexMcp({ ...base, configFile: cfg, listServers: real }).action, "kept", "真 codex 认得带引号的登记");
    assert.equal(readFileSync(cfg, "utf8"), realQuoted, "认得就不追加 —— 追加了就是重复定义");
    const dup = `${realQuoted}\n[mcp_servers.ash]\ncommand = "node"\n`;
    writeFileSync(cfg, dup);
    assert.equal(registerCodexMcp({ ...base, configFile: cfg, listServers: real }).action, "blocked", "真 codex 读不动重复定义");
    assert.equal(readFileSync(cfg, "utf8"), dup);
    // 审查第 2 条的原样形状:历史名带 `tools.*` 子表(本机真实配置就是这样)。上一版按表头
    // 字面量删,子表留成孤儿登记,codex 整份拒载、迁移必然回滚。带引号、缩进的表头同样要迁得过去。
    const shapes = [
      `model = "x"\n\n[mcp_servers.harness]\ncommand = "node"\nargs = ["/x.js"]\n\n[mcp_servers.harness.env]\nASH_URL = "u"\n\n`
        + `[mcp_servers.harness.tools.get_task]\napproval_mode = "approve"\n\n[mcp_servers.kb]\ncommand = "uv"\n`,
      `  [mcp_servers."harness"]\n  command = "node"\n[mcp_servers."harness".env]\nASH_URL = "u"\n[mcp_servers.kb]\ncommand = "uv"\n`,
    ];
    for (const shape of shapes) {
      writeFileSync(cfg, shape);
      const r = registerCodexMcp({ ...base, configFile: cfg, listServers: real, removeServer: realRemove });
      assert.equal(r.action, "migrated", `真 codex 下迁得过去：${JSON.stringify(shape)}`);
      const names = real().servers.map((x) => x.name).sort();
      assert.deepEqual(names, ["ash", "kb"], "旧名整条没了、别的 server 原样在");
    }
  } else {
    console.log("⚠ 没装 codex,跳过问真 codex 那几条");
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("✅ setup 给 codex 接 ash MCP:先问 codex 本人、读不动不写、写坏回滚");
