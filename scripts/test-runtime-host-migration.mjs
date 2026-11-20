import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const [runtime, home, data, origin] = process.argv.slice(2);
assert.ok(runtime && home && data && origin);
assert.equal(process.env.HOME, home);
const from = (file) => import(pathToFileURL(join(runtime, "server/dist", file)));
const { builtinEntry } = await from("mcp-registry/register.js");
const { setUpHostNaviMcp } = await from("mcp-registry/host-setup.js");
const { naviMcpMechanism } = await from("mcp-registry/catalog.js");
const { migrateRuntimeEntry } = await from("mcp-registry/runtime-migration.js");
const wanted = builtinEntry();
assert.equal(wanted.args[0], join(origin, "mcp/dist/index.js"));
assert.equal(wanted.command, join(origin, "node/bin/node"));
assert.equal(wanted.env.NAVI_DATA_DIR, data);
const old = { command: join(runtime, "node/bin/node"), args: [join(runtime, "mcp/dist/index.js")], env: { NAVI_URL: wanted.env.NAVI_URL } };
const paths = { claude: join(home, ".claude.json"), codex: join(home, ".codex/config.toml"),
  opencode: join(home, ".config/opencode/opencode.jsonc") };
for (const [type, file] of Object.entries(paths)) {
  const mechanism = naviMcpMechanism(type);
  const generated = mechanism.shape.compose(null, old, { enabled: mechanism.writeEnabled === true,
    ...(mechanism.writeType ? { type: mechanism.writeType } : {}) });
  assert.ok(generated.body);
  const text = type === "codex" ? '# keep this comment\nmodel = "untouched"\n' + generated.body
    : '// keep this comment\n' + generated.body.replace('{', '{"large":9007199254740993,');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const migrated = migrateRuntimeEntry(text, mechanism, wanted);
  assert.notEqual(migrated, text, type);
  assert.ok(migrated.includes("keep this comment"));
  if (type !== "codex") assert.ok(migrated.includes('"large":9007199254740993'));
  assert.equal(mechanism.shape.scan(migrated).names.get("navi").launch.command, wanted.command);
  const custom = type === "codex" ? text.replace('NAVI_URL =', 'CUSTOM = "keep"\nNAVI_URL =')
    : text.replace('"NAVI_URL":', '"CUSTOM":"keep", "NAVI_URL":');
  assert.equal(migrateRuntimeEntry(custom, mechanism, wanted), custom, "never rewrites user-customized entries");
  if (type === "codex") {
    const timeout = text.replace('command =', 'startup_timeout_sec = 90\ncommand =');
    assert.equal(migrateRuntimeEntry(timeout, mechanism, wanted), timeout, "preserves custom non-launch TOML fields");
  }
}
const pin = join(data, ".runtimes", `.host-pin-${basename(runtime)}`);
writeFileSync(pin, "host MCP configuration\n");
const customFile = join(home, ".gemini/settings.json");
mkdirSync(dirname(customFile), { recursive: true });
const customText = JSON.stringify({ mcpServers: { navi: { ...old, env: { ...old.env, CUSTOM: "keep" } } } });
writeFileSync(customFile, customText);
await setUpHostNaviMcp();
assert.ok(existsSync(pin), "custom references retain their original safety pin");
assert.equal(readFileSync(customFile, "utf8"), customText);
for (const [type, file] of Object.entries(paths)) {
  assert.equal(naviMcpMechanism(type).shape.scan(readFileSync(file, "utf8")).names.get("navi").launch.command, wanted.command);
}
rmSync(customFile);
const first = Object.values(paths).map((file) => readFileSync(file, "utf8"));
await setUpHostNaviMcp();
assert.equal(existsSync(pin), false, "unreferenced generated pins are removed after every known source is inspected");
assert.deepEqual(Object.values(paths).map((file) => readFileSync(file, "utf8")), first);
writeFileSync(pin, "unknown external owner\n");
await setUpHostNaviMcp();
assert.equal(readFileSync(pin, "utf8"), "unknown external owner\n");
rmSync(pin);
console.log("✓ stable host entry, generated JSON/JSONC/TOML migration, custom-config preservation and conservative pin cleanup");
