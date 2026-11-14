/**
 * 个人 CLI 配置的写入器:**换上去那份要跟原来那份同身份**（审查第 3 轮 F2）。
 *
 * 和安装器那份(`scripts/test-codex-mcp-setup.mjs`)钉的是同一条:**一律就地写**,所以 mode、
 * 扩展 ACL、软链、硬链接全都原样留着。两边各有一份写入器是因为 setup 在裸 Node 上跑、
 * 导不进 TS。
 *
 * 单独一个文件而不是塞进 `test-user-cli-mcp.ts`:那份已经 663 行,贴着单文件 700 行的上限。
 */
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CodexAskOutcome } from "../src/auth/codex-approve.js";
import { ensureAshMcp } from "../src/auth/user-cli-mcp.js";
import { REPO_DIR } from "../src/paths.js";

// 不用临时库:这条 import 链(写入器 → 探测层 / TOML 扫描器 / 端口)一个字都不碰数据库,
// 要是在这里 `releaseTmpDb()` 反而会把真的 data/ash.db 连上。
const stage = mkdtempSync(join(tmpdir(), "ash-write-identity-"));
process.on("exit", () => rmSync(stage, { recursive: true, force: true }));

/** 「codex 收下了」—— 这几格钉的是**写出来那个文件的身份**,不是 codex 的判决。 */
const LISTS_ASH: CodexAskOutcome = {
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

/**
 * ACL 怎么探测、怎么比,在 `scripts/acl-probe.mjs` 里只有一份 —— 安装器那一侧的
 * `test-codex-mcp-setup.mjs` 钉的是同一条不变量,而它在裸 Node 上跑、导不进 TS。
 *
 * 子进程只出现在**测试**里:被测的那个文件自己不许起进程(第 4 轮 F2,`test-user-cli-mcp.ts`
 * 第 ㉓ 组有结构断言钉着),所以写入器没法「读一下 ACL 再决定」,只能就地写把它整条留住。
 */
const { denyReadAcl } = await import(pathToFileURL(join(REPO_DIR, "scripts", "acl-probe.mjs")).href) as {
  denyReadAcl: (f: string) => { show: () => string; list: () => string[]; aces: string[] } | null;
};

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
  // ⑤ 原来没有这个文件：新建那一路**只给自己读**(0600)。这一档没有「原来那份」可抄,所以
  //    不是就地写那条规矩在管 —— 是「这个文件装着 MCP 接法,别按 umask 摊开给同机器上别的
  //    账号」。裸 Node 那侧(安装器)同口径,`mcp-publish-cases.ts` 第 ③ 组 ⒟ 和
  //    `test-ash-mcp-registry.ts` 第 ③ 组各钉着自己那一边。
  {
    const { host, dir } = bench();
    const file = join(dir, "config.toml");
    const state = await ensure(dir, host);
    assert.equal(state.configured, true);
    assert.match(readFileSync(file, "utf8"), /\[mcp_servers\.ash\]/, "原来没有就新建一份");
    assert.equal(statSync(file).mode & 0o777, 0o600, "新建的只给自己读,不按 umask 摊开");
  }
  // ⑥ **扩展 ACL 也得留下** —— mode 相等不等于有效权限相等(审查第 5 轮 F1:macOS 上
  //    `user:nobody deny read` 随 rename 消失,mode 还是 420,只比 mode 一点看不出来,而那
  //    一刻起原本被禁读的账号就能把 key 读走了)。
  {
    const { host, dir } = bench();
    const file = join(dir, "config.toml");
    writeFileSync(file, BEFORE, "utf8");
    const acl = denyReadAcl(file);
    if (!acl) {
      console.log("  ⑥ 跳过:这台机器设不上扩展 ACL");
    } else {
      const state = await ensure(dir, host);
      assert.equal(state.configured, true);
      assert.match(readFileSync(file, "utf8"), /\[mcp_servers\.ash\]/);
      assert.deepEqual(acl.list(), acl.aces, `那条禁读写完还得在:\n${acl.show()}`);
      // 顺手钉住**这个探测本身是灵敏的**:同一个路径被 rename 换掉时 ACL 会整条丢掉,那必须
      // 比出不一样。否则哪天 `ls -le` 换了格式、一条 ACE 都解析不出来,这一组会在「两边都是
      // 空」上静悄悄变成永远通过 —— 正是本轮要根治的那种坏法。探测是两份测试共用的
      // (`scripts/acl-probe.mjs`),所以这条灵敏度断言也只放一份,放在这里。
      const probe = join(dir, "probe.toml");
      writeFileSync(probe, BEFORE, "utf8");
      const canary = denyReadAcl(probe);
      if (canary) {
        const swap = join(dir, "probe-swap.toml");
        writeFileSync(swap, BEFORE, "utf8");
        renameSync(swap, probe);
        assert.notDeepEqual(canary.list(), canary.aces, "rename 换掉文件就该比出 ACL 已经丢了");
      }
    }
  }
  // ⑦ 软链跟满 8 层还没到头(成环/异常长)：定位不了就**不写**,别把中间那环换成普通文件
  //    (审查第 5 轮 N9:上一版返回当前这一环,于是 rename 把它替换掉了)。
  {
    const { host, dir } = bench();
    const chain = Array.from({ length: 9 }, (_, i) => join(dir, `deep-${i}.toml`));
    const never = join(dir, "deep-never.toml");
    symlinkSync(never, chain[8]!);
    for (let i = 7; i >= 0; i--) symlinkSync(chain[i + 1]!, chain[i]!);
    symlinkSync(chain[0]!, join(dir, "config.toml"));
    const state = await ensure(dir, host);
    assert.equal(state.configured, false, "定位不了就不许报「已接好」");
    assert.match(state.problem ?? "", /8 层/, "如实说是定位不了");
    assert.ok(chain.every((c) => lstatSync(c).isSymbolicLink()), "那条链一环都不许被换成文件");
    assert.equal(existsSync(never), false, "也别凭猜写出一个文件来");
  }
  // ⑧ 就地写失败(配置被设成只读)：如实报出来,用户那份一个字节不动 —— 截断之前就失败了。
  if (process.getuid?.() === 0) {
    console.log("  ⑧ 跳过:root 无视只读位");
  } else {
    const { host, dir } = bench();
    const file = join(dir, "config.toml");
    writeFileSync(file, BEFORE, "utf8");
    chmodSync(file, 0o400);
    const state = await ensure(dir, host);
    assert.equal(state.configured, false, "写不成就不许报「已接好」");
    assert.equal(readFileSync(file, "utf8"), BEFORE, "用户那份一个字节都不许动");
    assert.equal(statSync(file).mode & 0o777, 0o400, "权限也不许动");
  }
}

console.log("test-user-cli-write-identity: ✅ 写入器的文件身份(权限/扩展 ACL/软链/硬链接/新建/失败出口)通过");
