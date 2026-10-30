// setup 给 codex 接 ash MCP 的那一步。
//
// 「已经接过没有」**问 codex 本人**，不自己读 TOML。setup 得在 Node 22.16 上裸跑、导入不了
// server 那份结构扫描器（`server/src/codex-toml.ts`），而再写一份正则就是第五份判据 —— 上一版
// 就是 `^\[mcp_servers\.ash\]`：`[mcp_servers."ash"]` 它看不见，于是再追加一份同名表，TOML 里
// 那是重复定义，codex 整份配置解析失败（`duplicate key`），别的 MCP 一起没了（新链第 4 轮审查
// 第 2 条）。而「跑一次 npm run setup」正是派审预检给的补救办法。
//
// 所以：codex 读不动现在这份配置就不写；写完再问一遍，读不动了就原样还回去。迁移历史名时
// 删旧条目也交给 codex 自己（`codex mcp remove`）—— 上一版按行首表头字面量删，
// `[mcp_servers.harness.tools.*]` 这类子表留成一条没有 command 的孤儿，codex 整份拒载，
// 迁移必然回滚，还把一份本来健康的配置说成「读不出来」（新链第 5 轮审查第 2 条）。
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

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

/**
 * 同目录临时文件 + rename：codex 读到的要么是旧的、要么是写完的，没有半截。
 *
 * **换上去的那个文件得跟原来那个是同一身份**(审查第 3 轮 F2 —— 替换式写入是本任务引入的,
 * 之前是直接往原路径 `writeFileSync`,这三样本来都不会丢):
 *
 * ① 原路径是**软链**(dotfiles、集中管理的配置常这么接)就写它指向的那份。直接 rename
 *    会把链接本身换成一个普通文件,用户以后改原目标,codex 读的已经不是那份了。
 * ② **权限照抄**原文件。临时文件按 umask 建出来多半是 0644,原来 0600 的私密配置(里头
 *    可能有 key)会当场对同机器上别的账号放开。
 * ③ **硬链接**(nlink > 1)那一种:rename 换的是 inode,关联会断。这时放弃原子性、就地写回
 *    那个 inode —— 用户显式接起来的关联比「不会读到半截」更要紧,也正是改成替换式之前的行为。
 *
 * 多层悬空软链(指向的目标不存在、而且不止一层)只跟一层;所有者没抄(配置在谁的 HOME 里就
 * 该由谁跑 setup)。
 */
function writeAtomic(file, body) {
  let target = file;
  try {
    target = realpathSync(file);
  } catch {
    // 不存在,或者是条指向不存在目标的软链 —— 后者按它指的那个路径写。
    try { target = resolve(dirname(file), readlinkSync(file)); } catch { /* 真的还没有 */ }
  }
  let had = null;
  try { had = statSync(target); } catch { /* 新建 */ }
  if (had && had.nlink > 1) { writeFileSync(target, body); return; }
  const tmp = `${target}.ash-tmp`;
  writeFileSync(tmp, body);
  // `writeFileSync` 的 mode 会被 umask 削,所以建完再 chmod 一次。
  if (had) chmodSync(tmp, had.mode & 0o777);
  renameSync(tmp, target);
}

/**
 * @param listServers 问 codex 本人：`() => parseCodexList(...)` 的结果
 * @param removeServer 让 codex 本人删掉一条登记（`codex mcp remove <名>`），成功回 true
 * @returns action ∈ kept（已有，不动）| blocked（codex 读不动现有配置，没写）| added | migrated
 *          | rolledBack（这一步没成,我们自己那段改动已撤销）| foreignChange（没成,而文件已经
 *          不是我们动手前那一版,撤不干净,所以原样留着）；added 带 legacyLeft = 历史名没删掉
 */
export function registerCodexMcp({ configFile, mcpEntry, url, name, legacyName, listServers, removeServer }) {
  const before = listServers();
  if (!before.ok) return { action: "blocked", why: before.why };
  const current = before.servers.find((s) => s.name === name);
  if (current) return { action: "kept", enabled: current.enabled };
  const legacy = before.servers.some((s) => s.name === legacyName);

  const existing = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
  mkdirSync(dirname(configFile), { recursive: true });
  // 先备份再写:改的是用户自己的配置文件,出错要能一键还原。
  const backup = `${configFile}.bak-ash-setup`;
  if (existing !== null) copyFileSync(configFile, backup);
  const backupPath = () => (existing !== null ? backup : null);
  const nowOnDisk = () => (existsSync(configFile) ? readFileSync(configFile, "utf8") : null);
  // 保留现场,一个字不改。
  const leaveAsIs = (why) => ({ action: "foreignChange", why, backup: backupPath() });

  // 删不掉就留着：两个名字 ash 都认，名字不同不会重复定义；下面如实报「没删掉」。
  let legacyRemoved = false;
  if (legacy) {
    legacyRemoved = removeServer(legacyName);
    // 删失败、而文件已经不是动手前那一版:可能是 codex 删到一半,也可能这期间有人存了新
    // 内容 —— **两者分不开**,而「还原成动手前那一版」会把后者一起抹掉(审查第 3 轮 F1:
    // 恢复只能撤销自己那次改动;分不清归属就保留现场、如实报)。
    if (!legacyRemoved && nowOnDisk() !== existing) {
      return leaveAsIs(`codex mcp remove ${legacyName} 失败，而 ${configFile} 已经不是动手前那一版了`
        + `（删到一半，或者这期间有人存过新内容）—— 分不清哪些该撤，所以原样留着没有还原`);
    }
  }
  // 从这里往下,「我们动手前那一版」是 base,不是 existing：删旧登记那段时间里别人可能已经
  // 存过新模型、新 MCP,它们都在 base 里。
  const hadFile = existsSync(configFile);
  const base = hadFile ? readFileSync(configFile, "utf8") : "";
  // TOML 的字符串是转义的,Windows 路径里的 `\` 必须成对写,否则 `\d`、`\n`
  // 会被当转义序列吞掉 —— 装完看着成功,codex 起 MCP 时才报路径不存在。
  const written = `${base}\n[mcp_servers.${name}]\ncommand = "node"\nargs = [${JSON.stringify(mcpEntry)}]\n\n`
    + `[mcp_servers.${name}.env]\nASH_URL = "${url}"\n`;
  writeAtomic(configFile, written);

  const after = listServers();
  if (!after.ok || !after.servers.some((s) => s.name === name)) {
    const why = after.ok ? `写完 codex 仍看不到 ${name}` : after.why;
    // 盘上得还是我们刚写出去的那一版,否则别人又存过东西,撤销就会盖掉它。
    if (nowOnDisk() !== written) {
      return leaveAsIs(`${why}；而 ${configFile} 在这期间被别的程序改过，所以没有还原（免得盖掉那次改动）`);
    }
    // 撤销的只有**我们追加的那一段** ⇒ 回到 base,不是回到 existing(审查第 3 轮 F1)。
    if (hadFile) writeAtomic(configFile, base);
    else rmSync(configFile, { force: true });
    return {
      action: "rolledBack",
      // 旧登记是 codex 自己删的,它改了什么我们不知道,这一步撤不回来 —— 如实说,别让人
      // 以为「已原样还回」就等于一切照旧。
      why: legacyRemoved
        ? `${why}；我们追加的那段已撤销，但旧登记 ${legacyName} 已经由 codex 删掉，这一步撤不回来`
        : why,
      backup: backupPath(),
    };
  }
  const legacyLeft = after.servers.some((s) => s.name === legacyName);
  if (legacy && !legacyLeft) return { action: "migrated", backup: backupPath() };
  return { action: "added", backup: backupPath(), legacyLeft };
}
