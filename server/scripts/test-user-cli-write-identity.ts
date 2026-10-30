/**
 * 个人 CLI 配置的写入器:**换上去那份要跟原来那份同身份**（审查第 3 轮 F2）。
 *
 * 和安装器那份(`scripts/test-codex-mcp-setup.mjs`)钉的是同一条:软链要写它指向的那份、
 * 权限照抄、硬链接就地写。两边各有一份写入器是因为 setup 在裸 Node 上跑、导不进 TS。
 *
 * 单独一个文件而不是塞进 `test-user-cli-mcp.ts`:那份已经 663 行,贴着单文件 700 行的上限。
 */
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbeOutcome } from "../src/ash-mcp-probe.js";
import { ensureAshMcp } from "../src/auth/user-cli-mcp.js";

// 不用临时库:这条 import 链(写入器 → 探测层 / TOML 扫描器 / 端口)一个字都不碰数据库,
// 要是在这里 `releaseTmpDb()` 反而会把真的 data/ash.db 连上。
const stage = mkdtempSync(join(tmpdir(), "ash-write-identity-"));
process.on("exit", () => rmSync(stage, { recursive: true, force: true }));

/** 「codex 收下了」—— 这几格钉的是**写出来那个文件的身份**,不是 codex 的判决。 */
const LISTS_ASH: ProbeOutcome = {
  kind: "answer", code: 0, stdout: JSON.stringify([{ name: "ash", enabled: true }]), stderr: "",
};
const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
const BEFORE = `model = "gpt"\n`;

let seq = 0;
function bench() {
  const root = join(stage, `case-${++seq}`);
  const host = join(root, "home");
  const dir = join(root, "user-cli");
  mkdirSync(join(host, ".codex"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(host, ".codex", "config.toml"), HOST, "utf8");
  return { host, dir };
}
const ensure = (dir: string, host: string) => ensureAshMcp(dir, "codex", host, async () => LISTS_ASH);

if (process.platform === "win32") {
  // Windows 上就地写：rename 换上去的新文件 ACL 继承父目录，原文件单独收紧过的 DACL 会当场
  // 消失（审查第 4 轮 F1 真机实测到 Everyone 进了 DACL），而 Node 没有读写 ACL 的接口。
  const { host, dir } = bench();
  const file = join(dir, "config.toml");
  writeFileSync(file, BEFORE, "utf8");
  const ino = Number(statSync(file).ino);
  const state = await ensure(dir, host);
  assert.equal(state.configured, true);
  assert.match(readFileSync(file, "utf8"), /\[mcp_servers\.ash\]/);
  if (ino !== 0) assert.equal(Number(statSync(file).ino), ino, "就地写：不许换文件");
  assert.equal(existsSync(`${file}.ash-tmp`), false, "就地写不该产生临时副本");
} else {
  // ① 0600 的配置写完还得是 0600：临时文件按 umask 建出来是 0644，rename 上去就把私密
  //    配置对同机器上别的账号放开了。
  {
    const { host, dir } = bench();
    const file = join(dir, "config.toml");
    writeFileSync(file, BEFORE, "utf8");
    chmodSync(file, 0o600);
    const state = await ensure(dir, host);
    assert.equal(state.configured, true, "该接上的照样接上");
    assert.equal(statSync(file).mode & 0o777, 0o600, "0600 不许被放宽");
    assert.match(readFileSync(file, "utf8"), /\[mcp_servers\.ash\]/);
  }
  // ② 配置是条软链（集中管理 dotfiles 的常见做法）：写它指向的那份，链接本身别换掉。
  {
    const { host, dir } = bench();
    const managed = join(dir, "managed.toml");
    const file = join(dir, "config.toml");
    writeFileSync(managed, BEFORE, "utf8");
    chmodSync(managed, 0o600);
    symlinkSync(managed, file);
    const state = await ensure(dir, host);
    assert.equal(state.configured, true);
    assert.ok(lstatSync(file).isSymbolicLink(), "软链还得是软链");
    assert.match(readFileSync(managed, "utf8"), /\[mcp_servers\.ash\]/, "写的是它指向的那份");
    assert.ok(readFileSync(managed, "utf8").startsWith(BEFORE), "原文照旧在前面");
    assert.equal(statSync(managed).mode & 0o777, 0o600, "目标的权限也不许动");
  }
  // ③ 多层软链、最后一层悬空：写它最终指的那个路径,别把中间那条链接换成普通文件。
  {
    const { host, dir } = bench();
    const file = join(dir, "config.toml");
    const hop = join(dir, "hop.toml");
    const dangling = join(dir, "not-there.toml");
    symlinkSync(dangling, hop);
    symlinkSync(hop, file);
    const state = await ensure(dir, host);
    assert.equal(state.configured, true);
    assert.ok(lstatSync(file).isSymbolicLink() && lstatSync(hop).isSymbolicLink(), "两层链接都还在");
    assert.match(readFileSync(dangling, "utf8"), /\[mcp_servers\.ash\]/, "写到最终那个路径上");
  }
  // ④ 硬链接：rename 换 inode 会断开用户显式接起来的关联,这一种就地写。
  {
    const { host, dir } = bench();
    const file = join(dir, "config.toml");
    const twin = join(dir, "twin.toml");
    writeFileSync(file, BEFORE, "utf8");
    linkSync(file, twin);
    const ino = statSync(file).ino;
    const state = await ensure(dir, host);
    assert.equal(state.configured, true);
    assert.equal(statSync(file).ino, ino, "inode 不许换");
    assert.match(readFileSync(twin, "utf8"), /\[mcp_servers\.ash\]/, "另一端跟着更新");
  }
  // ⑤ 原来没有这个文件：新建那一路照旧(没有可抄的权限,按 umask 来)。
  {
    const { host, dir } = bench();
    const file = join(dir, "config.toml");
    const state = await ensure(dir, host);
    assert.equal(state.configured, true);
    assert.match(readFileSync(file, "utf8"), /\[mcp_servers\.ash\]/, "原来没有就新建一份");
    assert.equal(statSync(file).mode & 0o777, 0o666 & ~process.umask(), "新建的按 umask 来,跟基线一致");
  }
  // ⑥ 临时副本的名字被占住(上一次崩在半路留下的目录)：异常如实报出来,用户那份不动,
  //    也不留下一份宽权限的残骸。
  {
    const { host, dir } = bench();
    const file = join(dir, "config.toml");
    writeFileSync(file, BEFORE, "utf8");
    chmodSync(file, 0o600);
    mkdirSync(`${file}.ash-tmp`); // rmSync(force) 删不掉目录 ⇒ 建临时副本必然失败
    const state = await ensure(dir, host);
    assert.equal(state.configured, false, "写不成就不许报「已接好」");
    assert.equal(readFileSync(file, "utf8"), BEFORE, "用户那份一个字节都不许动");
    assert.equal(statSync(file).mode & 0o777, 0o600, "权限也不许动");
    rmSync(`${file}.ash-tmp`, { recursive: true, force: true });
  }
}

console.log("test-user-cli-write-identity: ✅ 写入器的文件身份(权限/软链/硬链接/新建/失败出口)通过");
