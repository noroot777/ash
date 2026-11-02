import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerKimiMcp } from "./kimi-mcp.mjs";

const directory = mkdtempSync(join(tmpdir(), "ash-kimi-mcp-"));
const file = join(directory, "mcp.json");
const options = { configDir: directory, mcpEntry: "/ash/mcp/dist/index.js", url: "http://localhost:4317" };
try {
  assert.equal(registerKimiMcp(options).added, true);
  const created = readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(created).mcpServers.ash, {
    command: process.execPath,
    args: [options.mcpEntry],
    env: { ASH_URL: options.url },
  });
  assert.equal(registerKimiMcp({ ...options, url: "http://localhost:9999" }).added, false);
  assert.equal(readFileSync(file, "utf8"), created);
  assert.equal(existsSync(`${file}.bak-ash-setup`), false);

  for (const name of ["ash", "harness"]) {
    const existing = JSON.stringify({ mcpServers: { [name]: { command: "custom", args: ["keep"] } } });
    writeFileSync(file, existing);
    assert.equal(registerKimiMcp(options).added, false);
    assert.equal(readFileSync(file, "utf8"), existing);
  }

  const original = JSON.stringify({ extra: true, mcpServers: { other: { url: "https://example.invalid/mcp" } } });
  writeFileSync(file, original);
  assert.equal(registerKimiMcp(options).added, true);
  assert.equal(readFileSync(`${file}.bak-ash-setup`, "utf8"), original);
  const merged = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(merged.extra, true);
  assert.deepEqual(merged.mcpServers.other, { url: "https://example.invalid/mcp" });
  assert.ok(merged.mcpServers.ash);

  // 读不通 / 根不是对象 / 容器不是对象:**不写 + 如实回一句**,文件一个字节不动。
  // (2026-10-31 统一到十五家同一个契约:原来这里是抛错,而 setup 全家都走 `registerHostMcp`
  // 的 `{ added, why }`,抛错那条路只有这份测试在用。)
  for (const invalid of ["{", "null", "[]", '{"mcpServers":null}', '{"mcpServers":[]}']) {
    writeFileSync(file, invalid);
    const r = registerKimiMcp(options);
    assert.equal(r.added, false, `${invalid}:不许写`);
    assert.ok((r.why || "").length > 0, `${invalid}:要如实说一句`);
    assert.equal(readFileSync(file, "utf8"), invalid, `${invalid}:一个字节都不许动`);
  }
  console.log("kimi MCP registration tests passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
