import { isDeepStrictEqual } from "node:util";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AGENT_TYPES } from "@navi/shared";
import { publishFresh } from "../auth/config-publish.js";
import { CODE_DIR, DATA_DIR } from "../paths.js";
import { naviMcpMechanism } from "./catalog.js";
import { naviMcpHostSources } from "./sources.js";
import { parseJsonDoc } from "./json-edit.js";
import type { NaviMcpEntry, NaviMcpMechanism } from "./types.js";

function ownVersion(entry: NaviMcpEntry): string | null {
  if (entry.args.length !== 1) return null;
  const root = dirname(dirname(dirname(entry.args[0])));
  try {
    const store = realpathSync(join(DATA_DIR, ".runtimes"));
    if (dirname(realpathSync(root)) !== store || entry.command !== join(root, "node/bin/node")
      || entry.args[0] !== join(root, "mcp/dist/index.js")) return null;
    const envelope = JSON.parse(readFileSync(join(root, "runtime-manifest.json"), "utf8"));
    return envelope.id === basename(root) ? root : null;
  } catch { return null; }
}

export function migrateRuntimeEntry(text: string, mechanism: Extract<NaviMcpMechanism, { kind: "file" }>, wanted: NaviMcpEntry): string {
  const shape = mechanism.shape;
  const scan = shape.scan(text, mechanism.switches);
  const fact = scan.names.get("navi");
  if (scan.doubt || fact?.status !== "on" || typeof fact.launch?.command !== "string"
    || !Array.isArray(fact.launch.args) || fact.launch.args.some((arg) => typeof arg !== "string")) return text;
  const old: NaviMcpEntry = { command: fact.launch.command, args: fact.launch.args,
    env: { NAVI_URL: fact.launch.naviUrl ?? "" } };
  if (!ownVersion(old) || old.env.NAVI_URL !== wanted.env.NAVI_URL) return text;
  const opts = { enabled: mechanism.writeEnabled === true, ...(mechanism.writeType ? { type: mechanism.writeType } : {}) };
  const generated = shape.compose(null, old, opts);
  const next = shape.compose(null, wanted, opts);
  if ("why" in generated || "why" in next) return text;
  if (shape.id === "mcp-servers-toml") {
    const block = fact.block;
    const expected = shape.scan(generated.body).names.get("navi")?.block;
    const replacement = shape.scan(next.body).names.get("navi")?.block;
    if (!block || block !== expected || !replacement || !text.includes(block)
      || text.indexOf(block) !== text.lastIndexOf(block)) return text;
    return text.replace(block, replacement);
  }
  const expected = shape.scan(generated.body).names.get("navi")?.raw;
  const replacement = shape.scan(next.body).names.get("navi")?.raw;
  if (!replacement || !isDeepStrictEqual(fact.raw, expected)) return text;
  const container = shape.id === "opencode-json" ? "mcp" : "mcpServers";
  const member = parseJsonDoc(text)?.members?.filter((item) => item.key === container).at(-1);
  if (!member) return text;
  const object = text.slice(member.valueStart, member.valueEnd);
  const target = parseJsonDoc(object)?.members?.filter((item) => item.key === "navi").at(-1);
  if (!target) return text;
  const start = member.valueStart + target.valueStart;
  const end = member.valueStart + target.valueEnd;
  return text.slice(0, start) + JSON.stringify(replacement, null, 2) + text.slice(end);
}

export async function migrateHostRuntimes(wanted: NaviMcpEntry | null): Promise<void> {
  if (process.platform !== "darwin" || !wanted || wanted.args[0] === join(CODE_DIR, "mcp/dist/index.js")) return;
  let uncertain = false;
  const contents: string[] = [];
  for (const type of AGENT_TYPES) {
    const mechanism = naviMcpMechanism(type);
    if (mechanism?.kind !== "file") continue;
    for (const source of naviMcpHostSources(type)) {
      if (source.unprovable) { uncertain = true; continue; }
      if (!source.file) { contents.push(source.text ?? ""); continue; }
      if (!existsSync(source.file)) continue;
      const ok = await publishFresh(source.file, async (read, commit) => {
        if (read.text === null) return true;
        const next = migrateRuntimeEntry(read.text, mechanism, wanted);
        if (next !== read.text && commit(read, next)) return false;
        contents.push(next);
        return true;
      }, () => false);
      if (!ok) uncertain = true;
    }
  }
  if (uncertain) return;
  const store = join(DATA_DIR, ".runtimes");
  for (const pin of readdirSync(store).filter((name) => /^\.host-pin-[a-f0-9]{64}$/.test(name))) {
    const file = join(store, pin);
    const root = join(store, pin.slice(".host-pin-".length));
    if (readFileSync(file, "utf8") === "host MCP configuration\n" && !contents.some((text) => text.includes(root))) rmSync(file);
  }
}
