// setup 给 codex 接 ash MCP 的那一步。
//
// 「已经接过没有」**问 codex 本人**，不自己读 TOML。setup 得在 Node 22.16 上裸跑、导入不了
// server 那份结构扫描器（`server/src/codex-toml.ts`），而再写一份正则就是第五份判据 —— 上一版
// 就是 `^\[mcp_servers\.ash\]`：`[mcp_servers."ash"]` 它看不见，于是再追加一份同名表，TOML 里
// 那是重复定义，codex 整份配置解析失败（`duplicate key`），别的 MCP 一起没了（新链第 4 轮审查
// 第 2 条）。而「跑一次 npm run setup」正是派审预检给的补救办法。
//
// **用户那份配置只被我们在批准之后写一次**，codex 碰的全是沙盘里的副本（审查第 4 轮 F2）：
// 删历史名也交给 codex 自己（`codex mcp remove`，上一版按行首表头字面量删，
// `[mcp_servers.harness.tools.*]` 这类子表留成一条没有 command 的孤儿，codex 整份拒载 —— 新链
// 第 5 轮审查第 2 条），但它自己也是「写临时文件再 rename」：让它去改用户真文件，硬链接在那一步
// 就断了，我们后面再怎么保身份都来不及，删到一半失败还会把用户那份留在中间状态。
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** `codex mcp list --json` 的结果 → `{ ok, servers:[{name, enabled}] }` 或 `{ ok:false, why }`。 */
export function parseCodexList(status, stdout) {
  if (status !== 0) return { ok: false, why: `codex mcp list 退出码 ${status}` };
  try {
    const listed = JSON.parse(stdout);
    if (!Array.isArray(listed)) throw new Error("not an array");
    return { ok: true, servers: listed.map((e) => ({ name: String(e?.name), enabled: e?.enabled !== false })) };
  } catch {
    return { ok: false, why: "codex mcp list 的输出看不懂" };
  }
}

/** 临时副本一出生就只有自己能读 —— 它装着用户配置的全文。 */
const TMP_MODE = 0o600;

/** 跟到软链的尽头（最多 8 层，防环）；最终悬空就用它指的那个路径，别去改中间那条链接。 */
function resolveTarget(file) {
  let p = file;
  for (let left = 8; left > 0; left--) {
    try { return realpathSync(p); } catch { /* 不存在,或者这条链悬空 */ }
    let next;
    try { next = readlinkSync(p); } catch { return p; } // 不是软链 ⇒ 要写的就是它
    p = resolve(dirname(p), next);
  }
  // 跟满 8 层还没到头:成环,或者长到不正常。此刻 `p` 只是链条中间的一环,**写它就是把一条
  // 软链接换成普通文件**(审查第 5 轮 N9:上一版直接 `return p`)。定位不了就不写,如实报。
  throw new Error(`${file} 的软链接跟了 8 层还没到头，没法确定该写哪个文件`);
}

/**
 * 把内容发布到 `file`，**保住这个文件的身份** —— 它的有效访问边界、它的链接关系。
 *
 * **一律就地写。** 原来 POSIX 走「同目录临时副本 + rename」，那样换上去的是一个**新文件**，
 * 它只继承得到我们抄得过去的那几位，而这份文件里装着 key：
 *
 * · Windows 的 DACL 抄不了（Node 没有读写 ACL 的接口），原文件单独收紧过的访问边界当场消失
 *   —— 第 4 轮 F1 在真机上实测到 Everyone 读进了 DACL。
 * · POSIX 的扩展 ACL 同样抄不了，**mode 相等不等于有效权限相等**：第 5 轮 F1 实测 macOS 上
 *   `chmod +a 'user:nobody deny read'` 这条禁读会随 rename 消失（`-rw-r--r--+` 变回
 *   `-rw-r--r--`，mode 一模一样）。本机另测了 `copyFileSync`，它也不带这条 ACL 过去；带得过去
 *   的只有 `cp -p`/`ditto` 这类外部命令，而发布侧不许起子进程（server 那份有结构断言钉着）。
 * · 硬链接会被换掉 inode，断开用户显式接起来的关联。
 *
 * 代价是**失去原子替换**：截断到写完之间有个窗口，这期间 codex 读到的是空的或者半截的
 * （第 4/5 轮 N8，现在全平台都如此）。所以**恢复手段必须是明确的**：写出异常就把这一轮读到的
 * 那一版原样写回去（原来没有这个文件就把它删掉）；回写也失败、或者断电/进程被杀来不及回写时，
 * 还有下面那份 `.bak-ash-setup` 可以手工还原。
 *
 * 软链写它指向的那份（否则一写就把链接本身变成普通文件）。所有者（uid/gid）没抄 —— 配置在谁的
 * HOME 里就该由谁跑这个。
 */
function publishInPlace(file, body, previous) {
  const target = resolveTarget(file);
  try {
    writeFileSync(target, body);
  } catch (e) {
    try {
      if (previous === null) rmSync(target, { force: true });
      else writeFileSync(target, previous);
    } catch { /* 尽力:连回写都失败就只剩那份备份这条路了 */ }
    throw e;
  }
}

/**
 * @param listServers 问 codex 本人：`(home?) => parseCodexList(...)` 的结果。给了 home 就问
 *                    那个 `CODEX_HOME` 里的配置（沙盘），不给就问用户自己那份
 * @param removeServer 让 codex 本人在**沙盘**里删掉一条登记：`(name, home) => boolean`
 * @returns action ∈ kept（已有，不动）| blocked（codex 读不动 —— 现有的那份，或者补完那段的
 *          那份；两种都是一个字节都没写）| added | migrated | foreignChange（批准期间用户那份
 *          被别的程序改过，所以没写）；added 带 legacyLeft = 历史名没删掉
 */
export function registerCodexMcp({ configFile, mcpEntry, url, name, legacyName, listServers, removeServer }) {
  const before = listServers();
  if (!before.ok) return { action: "blocked", why: before.why };
  const current = before.servers.find((s) => s.name === name);
  if (current) return { action: "kept", enabled: current.enabled };
  const legacy = before.servers.some((s) => s.name === legacyName);

  const existing = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
  const sandbox = mkdtempSync(join(tmpdir(), "ash-setup-codex-"));
  const sandboxCfg = join(sandbox, "config.toml");
  try {
    // 迁移、追加、确认全在副本上做,用户那份这期间一个字节都不动。
    writeFileSync(sandboxCfg, existing ?? "", { mode: TMP_MODE });
    // 删不掉就留着：两个名字 ash 都认，名字不同不会重复定义；下面如实报「没删掉」。
    const legacyRemoved = legacy ? removeServer(legacyName, sandbox) : false;
    const base = readFileSync(sandboxCfg, "utf8");
    // TOML 的字符串是转义的,Windows 路径里的 `\` 必须成对写,否则 `\d`、`\n`
    // 会被当转义序列吞掉 —— 装完看着成功,codex 起 MCP 时才报路径不存在。
    const written = `${base}\n[mcp_servers.${name}]\ncommand = "node"\nargs = [${JSON.stringify(mcpEntry)}]\n\n`
      + `[mcp_servers.${name}.env]\nASH_URL = "${url}"\n`;
    writeFileSync(sandboxCfg, written, { mode: TMP_MODE });

    // 批准:拼完这份,codex 本人读得动吗、ash 真的列出来了吗。
    const after = listServers(sandbox);
    if (!after.ok) return { action: "blocked", why: `${after.why}（补上那段之后）` };
    if (!after.servers.some((s) => s.name === name)) {
      return { action: "blocked", why: `补上那段之后 codex 仍看不到 ${name}` };
    }

    // 批准过了才碰用户那份,而且只替换我们读到的那一版(问 codex 那一问是个子进程,这期间
    // 用户或另一个 setup 可能已经存过新内容,拿旧快照盖回去就是把它抹掉)。
    const now = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
    if (now !== existing) {
      return {
        action: "foreignChange",
        why: `${configFile} 在批准那一问期间被别的程序改过，所以这次没有写（免得盖掉那次改动）`,
        backup: null, // 它一个字节都没被我们动过,给备份路径只会让人以为我们改了
      };
    }
    mkdirSync(dirname(configFile), { recursive: true });
    // 真要写了才备份：改的是用户自己的配置文件,出错要能一键还原。`copyFileSync` 在 POSIX 上
    // 带着原权限建目标(所以 0600 的配置不会从备份这条路泄出去,回归里钉着这一条);Windows 的
    // DACL 它复制不了,那份备份仍继承父目录 —— 这个做法本任务开工前就是这样(审查第 4 轮 N11)。
    const backup = `${configFile}.bak-ash-setup`;
    if (existing !== null) copyFileSync(configFile, backup);
    publishInPlace(configFile, written, existing);
    const backupPath = existing !== null ? backup : null;
    const legacyLeft = after.servers.some((s) => s.name === legacyName);
    if (legacy && legacyRemoved && !legacyLeft) return { action: "migrated", backup: backupPath };
    return { action: "added", backup: backupPath, legacyLeft };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
