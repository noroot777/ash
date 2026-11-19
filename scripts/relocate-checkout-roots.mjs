// 本地目录迁移涉及的全部资源根，统一在这里解析：navi 的库与 runs、各家执行器的配置目录与数据目录、
// 配置文件清单。所有来自环境变量、库里登记、命令行 --db 的路径都过同一个换算 now()：树已经搬了，
// 写着旧位置的换到新位置；还没搬，写着新位置的换回旧位置。清点、真做、重跑、加锁、核对拿的都是这一份，
// 所以一个资源根落在树里（XDG_DATA_HOME 指进仓库、个人档、显式 --db）时，搬前搬后找到的是同一个东西。
//
// 配置文件清单照 server/src/mcp-registry/catalog.ts 的 NAVI_MCP_TABLE（各家的 dirEnv / defaultDir / relative），
// 外加 claude 的 settings 文件。脚本要在没有构建产物的检出里裸跑，导不了那份 .ts，所以在这里照抄一份。
import { dirname, join, relative, resolve } from "node:path";
import { LEGACY_DB_FILE, LEGACY_ENV_PREFIXES } from "./legacy-names.mjs";
import { isUnder, mapPath } from "./relocate-checkout-paths.mjs";
import { isDirNoFollow, lexists, listDir } from "./relocate-checkout-fs.mjs";

/** 一条路径此刻在哪（p 写的是哪一侧都行）。 */
export const currentPath = (p, { from, to, moved }) => (moved ? mapPath(p, from, to) ?? p : mapPath(p, to, from) ?? p);
/** 一条路径搬完之后在哪。 */
export const afterPath = (p, { from, to }) => mapPath(p, from, to) ?? p;

/** 库文件：数据目录里 navi.db 在就用它，不然用旧库名（与 scripts/server-control.mjs 同口径）。 */
export function dbFileIn(dataRoot) {
  const navi = join(dataRoot, "navi.db");
  return lexists(navi) ? navi : join(dataRoot, LEGACY_DB_FILE);
}

/**
 * 服务端的存储类环境变量（NAVI_DATA_DIR / NAVI_DB / NAVI_RUNS_DIR，旧前缀也认），与
 * shared/src/env-names.ts 的 readStorageEnv 同口径：几代名字同时设了且不一致就报错，不猜。
 */
function storageEnv(env, name, errors) {
  const keys = [name, ...LEGACY_ENV_PREFIXES.map((p) => p + name.slice("NAVI_".length))];
  const set = keys.map((k) => [k, env[k]?.trim()]).filter(([, v]) => v);
  if (new Set(set.map(([, v]) => v)).size > 1) errors.push(`${set.map(([k, v]) => `${k}=${v}`).join(" 和 ")} 同时设了、指向不同的地方`);
  return set[0]?.[1] ?? null;
}

/** 指定资源位置的环境变量：服务端的存储变量（三代名字）与各家 CLI 的配置 / 数据目录变量（照 catalog.ts）。 */
const ROOT_ENV = [
  ...["NAVI_DATA_DIR", "NAVI_DB", "NAVI_RUNS_DIR"].flatMap((n) => [n, ...LEGACY_ENV_PREFIXES.map((p) => p + n.slice("NAVI_".length))]),
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "GEMINI_CLI_HOME", "KIMI_CODE_HOME",
  "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "QWEN_HOME", "COPILOT_HOME", "KILO_CONFIG", "PI_CODING_AGENT_DIR",
];

/**
 * 此刻环境里写着树里旧位置的资源变量：[{ name, value, next }]。脚本自己按树此刻的位置换算着用，但服务和
 * 各家 CLI 照原值读 —— 不改的话，不留链接或拆了链接之后，它们会去旧位置找（或在那儿新建一份空的）。
 * 脚本改不了启动它的 shell，也看不见别的终端、启动脚本里设的值，只能列出来交给人。
 */
export function staleEnv(env, { from, to }) {
  return ROOT_ENV.flatMap((name) => {
    const value = env[name]?.trim();
    const next = value && mapPath(resolve(value), from, to);
    return next ? [{ name, value, next }] : [];
  });
}

const kindOf = (file) => (file.endsWith(".toml") ? "toml" : file.endsWith(".jsonc") ? "jsonc" : "json");

/**
 * root 是树此刻所在的位置。dbDirs 是库里会话登记的配置目录（{ claude: [], codex: [] }，写的可能是搬前的路径）。
 * 返回的路径全是此刻的位置。
 */
export function resolveRoots({ home, env, from, to, root, dbExplicit, dbDirs = {}, errors }) {
  const moved = root === to;
  const now = (p) => currentPath(resolve(p), { from, to, moved });
  const e = (name) => env[name]?.trim() || null;
  const xdgConfig = now(e("XDG_CONFIG_HOME") ?? join(home, ".config"));
  const xdgData = now(e("XDG_DATA_HOME") ?? join(home, ".local", "share"));
  const dataRoot = now(storageEnv(env, "NAVI_DATA_DIR", errors) ?? join(root, "data"));
  const dbEnv = storageEnv(env, "NAVI_DB", errors);
  const runsEnv = storageEnv(env, "NAVI_RUNS_DIR", errors);
  const dbFile = dbExplicit ? now(dbExplicit) : dbEnv ? now(dbEnv) : dbFileIn(dataRoot);
  const userCli = join(dataRoot, "user-cli");
  const personal = (agent) => listDir(userCli, errors).map((u) => join(userCli, u, agent)).filter(isDirNoFollow);
  const uniq = (xs) => [...new Set(xs.filter(Boolean).map(now))];
  const defaultClaude = now(join(home, ".claude"));
  const claude = uniq([join(home, ".claude"), e("CLAUDE_CONFIG_DIR"), ...(dbDirs.claude ?? []), ...personal("claude")]);
  const codex = uniq([e("CODEX_HOME") ?? join(home, ".codex"), ...(dbDirs.codex ?? []), ...personal("codex")]);
  const grokHome = now(e("GROK_HOME") ?? join(home, ".grok"));

  const files = [];
  const add = (...parts) => files.push(now(join(...parts)));
  for (const d of claude) {
    // 默认位置的 .claude.json 在家目录下；CLAUDE_CONFIG_DIR 指定的目录（含个人档）里它跟着目录走。
    add(d === defaultClaude ? home : d, ".claude.json");
    add(d, "settings.json");
    add(d, "settings.local.json");
  }
  for (const d of codex) add(d, "config.toml");
  add(e("GEMINI_CLI_HOME") ?? home, ".gemini", "settings.json");
  add(home, ".gemini", "config", "mcp_config.json");
  add(grokHome, "config.toml");
  add(e("KIMI_CODE_HOME") ?? join(home, ".kimi-code"), "mcp.json");
  if (e("OPENCODE_CONFIG")) add(e("OPENCODE_CONFIG"));
  if (e("OPENCODE_CONFIG_DIR")) for (const f of ["opencode.json", "opencode.jsonc"]) add(e("OPENCODE_CONFIG_DIR"), f);
  for (const f of ["config.json", "opencode.json", "opencode.jsonc"]) add(xdgConfig, "opencode", f);
  for (const f of ["opencode.json", "opencode.jsonc"]) add(home, ".opencode", f);
  add(home, ".cursor", "mcp.json");
  add(e("QWEN_HOME") ?? join(home, ".qwen"), "settings.json");
  add(home, e("QODER_CONFIG_DIR_NAME") ?? ".qoder", "mcp.json");
  add(e("COPILOT_HOME") ?? join(home, ".copilot"), "mcp-config.json");
  add(home, ".kiro", "settings", "mcp.json");
  add(e("KILO_CONFIG") ?? join(xdgConfig, "kilo", "kilo.json"));
  add(e("PI_CODING_AGENT_DIR") ?? join(home, ".pi", "agent"), "mcp.json");
  add(home, ".trae", "mcp.json");

  return {
    moved,
    dbFile,
    dataRoot,
    // 服务端的资源键是「库文件 + runs 目录」（resourceKeysFor）。runs 默认在数据根下；显式给了库时
    // 库旁边那份也锁上（不知道那份库配的是哪个 runs，多锁不出错，少锁就是没锁）。
    runsDirs: [...new Set([runsEnv ? now(runsEnv) : join(dataRoot, "runs"), join(dirname(dbFile), "runs")])],
    claude,
    codex,
    defaultClaude,
    grokSessions: join(grokHome, "sessions"),
    opencodeDb: join(xdgData, "opencode", "opencode.db"),
    configFiles: [...new Set(files)].map((file) => ({ file, kind: kindOf(file) })),
  };
}

/**
 * claude 配置目录在文本里可能的写法：搬前、搬后两种绝对路径，以及家目录下的 `~/…`。dir 是搬后的规范位置，
 * 会话目录映射（`<dir>/projects/<旧名>` → 新名）按它做键。
 */
export function claudePrefixes(dirs, { from, to, home }) {
  const out = [];
  for (const d of dirs) {
    const dir = afterPath(d, { from, to });
    for (const p of new Set([dir, mapPath(dir, to, from) ?? dir])) {
      out.push({ text: p, dir });
      if (home && isUnder(p, home) && p !== home) out.push({ text: `~/${relative(home, p)}`, dir });
    }
  }
  return out;
}
