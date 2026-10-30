import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexList, registerCodexMcp } from "./codex-mcp.mjs";
import { IS_WINDOWS, which } from "./platform.mjs";

const directory = mkdtempSync(join(tmpdir(), "ash-codex-mcp-setup-"));
const file = join(directory, "config.toml");
const base = {
  configFile: file, mcpEntry: "C:\\ash\\mcp\\dist\\index.js", url: "http://localhost:4317",
  name: "ash", legacyName: "harness", removeServer: () => assert.fail("不该去删任何登记"),
};
/** 按顺序吐出预先写好的「codex 本人的回答」。第二问起问的是沙盘,`home` 这里不关心。 */
const answers = (...seq) => () => seq.shift() ?? assert.fail("多问了一次 codex");
const listed = (...names) => ({ ok: true, servers: names.map((name) => ({ name, enabled: true })) });
/** codex 在**沙盘**里删掉旧名:它永远不该碰用户那份。 */
const removesInSandbox = (left, watch) => (name, home) => {
  if (watch) watch.seen.push(readFileSync(watch.file, "utf8"));
  writeFileSync(join(home, "config.toml"), left);
  return true;
};

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

  // **批准在写之前**:拼完那份 codex 读不动(或者仍看不到 ash) → 用户那份一个字节都没动,
  // 也不留备份、不留临时副本。上一版是「先写进去、读不动再还原」,审查第 2/3 轮的 F1 都出在
  // 那条还原路径上;整条迁移挪进沙盘之后,「没写成」只剩这一种收场。
  for (const [why, second] of [
    ["codex 读不动补完那段的配置", { ok: false, why: "codex mcp list 退出码 1" }],
    ["补完仍看不到 ash", listed()],
  ]) {
    const before = `model = "y"\n`;
    writeFileSync(file, before);
    rmSync(`${file}.bak-ash-setup`, { force: true });
    const r = registerCodexMcp({ ...base, listServers: answers(listed(), second) });
    assert.equal(r.action, "blocked", why);
    assert.equal(readFileSync(file, "utf8"), before, `${why}:一个字节都不许动`);
    assert.equal(existsSync(`${file}.bak-ash-setup`), false, `${why}:没写就不该留备份`);
    assert.equal(existsSync(`${file}.ash-tmp`), false, `${why}:不留临时副本`);
  }
  // 原来没有这个文件 → 批准不过就不该凭空造一个。
  rmSync(file, { force: true });
  assert.equal(registerCodexMcp({ ...base, listServers: answers(listed(), listed()) }).action, "blocked");
  assert.equal(existsSync(file), false, "原来没有的文件不许留下半截");

  // 批准那一问期间别人存过新内容 → **不写**(写就是把那次改动抹掉)。同一条不变量在 server
  // 侧是 publishFresh 的「只替换我们读到的那一版」(审查第 2 轮 F1)。
  {
    writeFileSync(file, `model = "mine"\n`);
    rmSync(`${file}.bak-ash-setup`, { force: true });
    const foreign = `model = "someone-else"\n[mcp_servers.user_added]\ncommand = "x"\n`;
    let asked = 0;
    const r = registerCodexMcp({
      ...base,
      listServers: () => {
        if (++asked === 1) return listed();
        writeFileSync(file, foreign); // 批准这一问期间,别的程序把这份文件整个换掉了
        return listed("ash");
      },
    });
    assert.equal(r.action, "foreignChange", "被别人改过就不该写");
    assert.match(r.why, /被别的程序改过/);
    assert.equal(readFileSync(file, "utf8"), foreign, "别人那次改动必须原样留着");
    assert.equal(r.backup, null, "我们一个字节都没动它,给备份路径只会让人以为改了");
    assert.equal(existsSync(`${file}.bak-ash-setup`), false);
  }

  // 只有历史名 → 让 codex 在**沙盘**里删旧的,再在那份结果上补规范名。
  {
    const original = `[mcp_servers.harness]\ncommand = "node"\n[other]\nk = 1\n`;
    writeFileSync(file, original);
    const watch = { file, seen: [] };
    const mig = registerCodexMcp({
      ...base,
      listServers: answers(listed("harness"), listed("ash")),
      removeServer: removesInSandbox(`[other]\nk = 1\n`, watch),
    });
    assert.equal(mig.action, "migrated");
    const migrated = readFileSync(file, "utf8");
    assert.ok(migrated.startsWith(`[other]\nk = 1\n`) && migrated.includes("[mcp_servers.ash]"), "在 codex 删完的那份上追加");
    assert.deepEqual(watch.seen, [original], "删旧名那一步 codex 碰的是副本,用户那份还没动（审查第 4 轮 F2）");
  }
  // codex 删不掉(沙盘里那份没变) → 两个名字并存也能用,如实报「没删掉」,不说「已迁移」。
  writeFileSync(file, `[mcp_servers.harness]\ncommand = "node"\n`);
  const kept = registerCodexMcp({
    ...base,
    listServers: answers(listed("harness"), listed("harness", "ash")),
    removeServer: () => false,
  });
  assert.equal(kept.action, "added");
  assert.equal(kept.legacyLeft, true);
  assert.equal(kept.backup, `${file}.bak-ash-setup`, "真写了就把备份在哪交出来");

  // **换上去那份要跟原来那份同身份**(审查第 3/4 轮 F2)。Windows 的权限/链接语义不同,各自钉。
  if (IS_WINDOWS) {
    // Windows 上就地写:文件本身(连同它的 DACL)不换 —— rename 换上去的新文件会继承父目录
    // 权限,原来单独收紧过的访问边界当场消失(审查第 4 轮 F1,真机实测 Everyone 进了 DACL)。
    const w = join(directory, "win-inplace.toml");
    writeFileSync(w, `model = "w"\n`);
    const ino = Number(statSync(w).ino);
    assert.equal(registerCodexMcp({ ...base, configFile: w, listServers: answers(listed(), listed("ash")) }).action, "added");
    assert.match(readFileSync(w, "utf8"), /\[mcp_servers\.ash\]/);
    if (ino !== 0) assert.equal(Number(statSync(w).ino), ino, "就地写:不许换文件");
    assert.equal(existsSync(`${w}.ash-tmp`), false, "就地写不该产生临时副本");
  } else {
    // ① 0600 的私密配置不许被放宽成 0644;那份备份也一样(它装着同一份内容)。
    const priv = join(directory, "priv.toml");
    writeFileSync(priv, `model = "p"\ndummy_secret = "s"\n`);
    chmodSync(priv, 0o600);
    assert.equal(registerCodexMcp({ ...base, configFile: priv, listServers: answers(listed(), listed("ash")) }).action, "added");
    assert.equal(statSync(priv).mode & 0o777, 0o600, "写完还得是 0600");
    assert.equal(statSync(`${priv}.bak-ash-setup`).mode & 0o777, 0o600, "备份也不许比原文件宽");
    // ② 软链(dotfiles/集中管理)要写它指向的那份,别把链接换成普通文件。
    const managed = join(directory, "managed.toml");
    const link = join(directory, "linked.toml");
    writeFileSync(managed, `model = "m"\n`);
    chmodSync(managed, 0o600);
    symlinkSync(managed, link);
    assert.equal(registerCodexMcp({ ...base, configFile: link, listServers: answers(listed(), listed("ash")) }).action, "added");
    assert.ok(lstatSync(link).isSymbolicLink(), "软链还得是软链");
    assert.match(readFileSync(managed, "utf8"), /\[mcp_servers\.ash\]/, "写的是它指向的那份");
    assert.equal(statSync(managed).mode & 0o777, 0o600, "目标的权限也不许动");
    // ③ 多层软链、最后一层还悬空:要写它最终指的那个路径,不许把中间那条链接换成普通文件。
    const hop = join(directory, "hop.toml");
    const far = join(directory, "far.toml");
    const dangling = join(directory, "not-there.toml");
    symlinkSync(dangling, far);
    symlinkSync(far, hop);
    assert.equal(registerCodexMcp({ ...base, configFile: hop, listServers: answers(listed(), listed("ash")) }).action, "added");
    assert.ok(lstatSync(hop).isSymbolicLink() && lstatSync(far).isSymbolicLink(), "两层链接都还在");
    assert.match(readFileSync(dangling, "utf8"), /\[mcp_servers\.ash\]/, "写到最终那个路径上");
    // ④ 硬链接:rename 换 inode 会把用户显式接起来的关联断掉,这一种就地写。
    const hardA = join(directory, "hard-a.toml");
    const hardB = join(directory, "hard-b.toml");
    writeFileSync(hardA, `model = "h"\n`);
    linkSync(hardA, hardB);
    const ino = statSync(hardA).ino;
    assert.equal(registerCodexMcp({ ...base, configFile: hardA, listServers: answers(listed(), listed("ash")) }).action, "added");
    assert.equal(statSync(hardA).ino, ino, "inode 不许换");
    assert.match(readFileSync(hardB, "utf8"), /\[mcp_servers\.ash\]/, "另一端跟着更新");
    // ⑤ **带旧名的硬链接迁移**(审查第 4 轮 F2 的本体):上一版让 codex 直接去删用户那份里的
    //    旧名,它自己的 temp+rename 在那一步就把 inode 换了,我们后面的 nlink 检查只看得到
    //    新 inode —— 另一端停在旧内容,安装器却报「迁移成功」。
    const migA = join(directory, "mig-a.toml");
    const migB = join(directory, "mig-b.toml");
    const original = `[mcp_servers.harness]\ncommand = "node"\n[other]\nk = 1\n`;
    writeFileSync(migA, original);
    linkSync(migA, migB);
    const migIno = statSync(migA).ino;
    const watch = { file: migA, seen: [] };
    const r = registerCodexMcp({
      ...base, configFile: migA,
      listServers: answers(listed("harness"), listed("ash")),
      removeServer: removesInSandbox(`[other]\nk = 1\n`, watch),
    });
    assert.equal(r.action, "migrated");
    assert.equal(statSync(migA).ino, migIno, "迁移也不许换 inode");
    const other = readFileSync(migB, "utf8");
    assert.match(other, /\[mcp_servers\.ash\]/, "另一端跟着更新");
    assert.ok(!other.includes("harness"), "另一端的旧名也没了");
    assert.deepEqual(watch.seen, [original], "删旧名那一步用户那份还是原样");
  }

  // 审查复现的原样形状,问真 codex:带引号的登记它认得 → 不追加;重复定义它读不动 → 不动。
  const codex = which("codex");
  if (codex) {
    const home = join(directory, "home");
    const askCodex = (args, where) => {
      const shell = IS_WINDOWS && /\.(cmd|bat)$/i.test(codex);
      return spawnSync(shell ? `"${codex}"` : codex, args, {
        encoding: "utf8", windowsHide: true, shell, cwd: where, timeout: 60_000,
        env: { ...process.env, CODEX_HOME: where },
      });
    };
    const real = (where) => {
      const res = askCodex(["mcp", "list", "--json"], where ?? home);
      return parseCodexList(res.status ?? 1, res.stdout ?? "");
    };
    const realRemove = (name, where) => askCodex(["mcp", "remove", name], where).status === 0;
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
    // 审查第 2 条的原样形状:历史名带 `tools.*` 子表(本机真实配置就是这样)。上一版按表头
    // 字面量删,子表留成孤儿登记,codex 整份拒载、迁移必然回滚。带引号、缩进的表头同样要迁得过去。
    const shapes = [
      `model = "x"\n\n[mcp_servers.harness]\ncommand = "node"\nargs = ["/x.js"]\n\n[mcp_servers.harness.env]\nASH_URL = "u"\n\n`
        + `[mcp_servers.harness.tools.get_task]\napproval_mode = "approve"\n\n[mcp_servers.kb]\ncommand = "uv"\n`,
      `  [mcp_servers."harness"]\n  command = "node"\n[mcp_servers."harness".env]\nASH_URL = "u"\n[mcp_servers.kb]\ncommand = "uv"\n`,
    ];
    for (const shape of shapes) {
      writeFileSync(cfg, shape);
      const r = registerCodexMcp({ ...base, configFile: cfg, listServers: real, removeServer: realRemove });
      assert.equal(r.action, "migrated", `真 codex 下迁得过去：${JSON.stringify(shape)}`);
      const names = real().servers.map((x) => x.name).sort();
      assert.deepEqual(names, ["ash", "kb"], "旧名整条没了、别的 server 原样在");
    }
    // 真 codex 迁移 + 硬链接:删旧名那一步只碰沙盘,所以关联还在(审查第 4 轮 F2)。
    if (!IS_WINDOWS) {
      const twin = join(directory, "twin.toml");
      writeFileSync(cfg, `[mcp_servers.harness]\ncommand = "node"\nargs = ["/x.js"]\n\n[mcp_servers.kb]\ncommand = "uv"\n`);
      rmSync(twin, { force: true });
      linkSync(cfg, twin);
      const ino = statSync(cfg).ino;
      const r = registerCodexMcp({ ...base, configFile: cfg, listServers: real, removeServer: realRemove });
      assert.equal(r.action, "migrated", "真 codex 下的硬链接迁移");
      assert.equal(statSync(cfg).ino, ino, "真 codex 迁移也不许换 inode");
      assert.match(readFileSync(twin, "utf8"), /\[mcp_servers\.ash\]/, "另一端跟着更新");
      assert.ok(!readFileSync(twin, "utf8").includes("harness"), "另一端的旧名也没了");
    }
  } else {
    console.log("⚠ 没装 codex,跳过问真 codex 那几条");
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("✅ setup 给 codex 接 ash MCP:整条迁移在沙盘里做、批准了才写、写不改文件身份");
