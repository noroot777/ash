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

  for (const invalid of ["{", "null", "[]", '{"mcpServers":null}', '{"mcpServers":[]}']) {
    writeFileSync(file, invalid);
    assert.throws(() => registerKimiMcp(options));
    assert.equal(readFileSync(file, "utf8"), invalid);
  }
  console.log("kimi MCP registration tests passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
