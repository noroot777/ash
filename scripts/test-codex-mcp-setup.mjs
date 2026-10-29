import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexList, registerCodexMcp } from "./codex-mcp.mjs";
import { IS_WINDOWS, which } from "./platform.mjs";

const directory = mkdtempSync(join(tmpdir(), "ash-codex-mcp-setup-"));
const file = join(directory, "config.toml");
const base = { configFile: file, mcpEntry: "C:\\ash\\mcp\\dist\\index.js", url: "http://localhost:4317", name: "ash", legacyName: "harness" };
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

  // 只有历史名 → 迁移成规范名。
  writeFileSync(file, `[mcp_servers.harness]\ncommand = "node"\n\n[mcp_servers.harness.env]\nASH_URL = "u"\n[other]\nk = 1\n`);
  assert.equal(registerCodexMcp({ ...base, listServers: answers(listed("harness"), listed("ash")) }).action, "migrated");
  const migrated = readFileSync(file, "utf8");
  assert.ok(!migrated.includes("[mcp_servers.harness") && migrated.includes("[other]") && migrated.includes("[mcp_servers.ash]"));

  // 审查复现的原样形状,问真 codex:带引号的登记它认得 → 不追加;重复定义它读不动 → 不动。
  const codex = which("codex");
  if (codex) {
    const home = join(directory, "home");
    const real = () => {
      const shell = IS_WINDOWS && /\.(cmd|bat)$/i.test(codex);
      const res = spawnSync(shell ? `"${codex}"` : codex, ["mcp", "list", "--json"], {
        encoding: "utf8", windowsHide: true, shell, cwd: tmpdir(), timeout: 60_000, env: { ...process.env, CODEX_HOME: home },
      });
      return parseCodexList(res.status ?? 1, res.stdout ?? "");
    };
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
  } else {
    console.log("⚠ 没装 codex,跳过问真 codex 那两条");
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("✅ setup 给 codex 接 ash MCP:先问 codex 本人、读不动不写、写坏回滚");
