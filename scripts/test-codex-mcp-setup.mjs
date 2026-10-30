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
/** 按顺序吐出预先写好的「codex 本人的回答」。 */
const answers = (...seq) => () => seq.shift() ?? assert.fail("多问了一次 codex");
const listed = (...names) => ({ ok: true, servers: names.map((name) => ({ name, enabled: true })) });

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

  // 写完 codex 读不动了 → 原样还回去;原本没有文件就删掉。
  const before = `model = "y"\n`;
  writeFileSync(file, before);
  const back = registerCodexMcp({ ...base, listServers: answers(listed(), { ok: false, why: "codex mcp list 退出码 1" }) });
  assert.equal(back.action, "rolledBack");
  assert.equal(readFileSync(file, "utf8"), before);
  rmSync(file);
  assert.equal(registerCodexMcp({ ...base, listServers: answers(listed(), listed()) }).action, "rolledBack");
  assert.equal(existsSync(file), false, "原来没有的文件不许留下半截");

  // 写完 codex 读不动,但这期间别人存过新内容 → **不还原**(还原就是把那次改动抹掉)。
  // 同一条不变量在 server 侧是 publishFresh 的「只替换我们读到的那一版」(审查第 2 轮 F1)。
  {
    writeFileSync(file, `model = "mine"\n`);
    const foreign = `model = "someone-else"\n[mcp_servers.user_added]\ncommand = "x"\n`;
    let asked = 0;
    const r = registerCodexMcp({
      ...base,
      listServers: () => {
        if (++asked === 1) return listed();
        // 问第二遍这期间,别的程序把这份文件整个换掉了。
        writeFileSync(file, foreign);
        return { ok: false, why: "codex mcp list 退出码 1" };
      },
    });
    assert.equal(r.action, "foreignChange", "被别人改过就不该报「已还原」");
    assert.match(r.why, /被别的程序改过/);
    assert.equal(readFileSync(file, "utf8"), foreign, "别人那次改动必须原样留着");
    assert.equal(readFileSync(`${file}.bak-ash-setup`, "utf8"), `model = "mine"\n`, "补写前的备份照旧给出来");
  }

  // 只有历史名 → 让 codex 删旧的、再补规范名。
  writeFileSync(file, `[mcp_servers.harness]\ncommand = "node"\n[other]\nk = 1\n`);
  const removed = [];
  const codexRemoves = (name) => { removed.push(name); writeFileSync(file, `[other]\nk = 1\n`); return true; };
  const mig = registerCodexMcp({ ...base, listServers: answers(listed("harness"), listed("ash")), removeServer: codexRemoves });
  assert.equal(mig.action, "migrated");
  assert.deepEqual(removed, ["harness"], "删旧条目交给 codex 本人");
  const migrated = readFileSync(file, "utf8");
  assert.ok(migrated.startsWith(`[other]\nk = 1\n`) && migrated.includes("[mcp_servers.ash]"), "在 codex 删完的那份上追加");
  // codex 删不掉(文件没动) → 两个名字并存也能用,如实报「没删掉」,不说「已迁移」。
  writeFileSync(file, `[mcp_servers.harness]\ncommand = "node"\n`);
  const kept = registerCodexMcp({ ...base, listServers: answers(listed("harness"), listed("harness", "ash")), removeServer: () => false });
  assert.equal(kept.action, "added");
  assert.equal(kept.legacyLeft, true);
  // 写完读不动 → 回滚,并把备份在哪交出来。
  writeFileSync(file, `model = "z"\n`);
  const rb = registerCodexMcp({ ...base, listServers: answers(listed(), { ok: false, why: "x" }) });
  assert.equal(rb.backup, `${file}.bak-ash-setup`);
  assert.equal(existsSync(`${file}.ash-tmp`), false, "原子写不留临时文件");

  // **恢复只能撤销自己那次改动**(审查第 3 轮 F1)。「现在这份还是我刚写的」只证明后面没人
  // 再动,证不出「最早那份快照里有中途该保留的东西」—— 删旧登记要几百毫秒,用户完全可能在
  // 这期间按了保存。
  //
  // ① 删旧登记失败、而文件已经变了:可能是 codex 删到一半,也可能是别人存了新内容,两者
  //    分不开 ⇒ 保留现场。上一版在这里无条件写回最初快照,两种改动一起没。
  {
    const mine = `model = "mine"\n[mcp_servers.harness]\ncommand = "node"\n`;
    writeFileSync(file, mine);
    const foreign = `model = "someone-else"\n[mcp_servers.harness]\ncommand = "node"\n`;
    const r = registerCodexMcp({
      ...base,
      listServers: answers(listed("harness")),
      removeServer: () => { writeFileSync(file, foreign); return false; }, // 删到一半失败了
    });
    assert.equal(r.action, "foreignChange", "分不清归属就不许报「已还原」");
    assert.match(r.why, /分不清哪些该撤/, `要说清为什么没还原：${r.why}`);
    assert.equal(readFileSync(file, "utf8"), foreign, "现场一个字都不许改");
    assert.equal(r.backup, `${file}.bak-ash-setup`, "动手前那一版还是要指给人");
  }
  // ② 旧登记删成功、这期间别人存了新模型和自己的 MCP,最后那问失败 ⇒ 只撤我们追加的那段,
  //    回到「我们动手前」那一版(含别人的新内容),不是回到迁移前的快照;codex 删掉的旧登记
  //    撤不回来,得说出来。
  {
    writeFileSync(file, `model = "old-model"\n[mcp_servers.harness]\ncommand = "node"\n`);
    const meanwhile = `model = "new-model"\n\n[mcp_servers.user_added]\ncommand = "uv"\n`;
    const r = registerCodexMcp({
      ...base,
      listServers: answers(listed("harness"), { ok: false, why: "codex mcp list 退出码 1" }),
      removeServer: () => { writeFileSync(file, meanwhile); return true; },
    });
    assert.equal(r.action, "rolledBack");
    assert.equal(readFileSync(file, "utf8"), meanwhile, "别人存的新模型、新 MCP 必须留着");
    assert.match(r.why, /撤不回来/, `旧登记是 codex 删的,要讲明撤不回来：${r.why}`);
  }

  // **换上去那份要跟原来那份同身份**(审查第 3 轮 F2)。替换式写入是本任务引入的,这三样
  // 以前(直接往原路径写)本来都不会丢。Windows 上权限/硬链接语义不同,只在 POSIX 上钉。
  if (!IS_WINDOWS) {
    // ① 0600 的私密配置不许被放宽成 0644(临时文件按 umask 建出来就是那样)。
    const priv = join(directory, "priv.toml");
    writeFileSync(priv, `model = "p"\n`);
    chmodSync(priv, 0o600);
    assert.equal(registerCodexMcp({ ...base, configFile: priv, listServers: answers(listed(), listed("ash")) }).action, "added");
    assert.equal(statSync(priv).mode & 0o777, 0o600, "写完还得是 0600");
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
    // ③ 硬链接:rename 换 inode 会把用户显式接起来的关联断掉,这一种就地写。
    const hardA = join(directory, "hard-a.toml");
    const hardB = join(directory, "hard-b.toml");
    writeFileSync(hardA, `model = "h"\n`);
    linkSync(hardA, hardB);
    const ino = statSync(hardA).ino;
    assert.equal(registerCodexMcp({ ...base, configFile: hardA, listServers: answers(listed(), listed("ash")) }).action, "added");
    assert.equal(statSync(hardA).ino, ino, "inode 不许换");
    assert.match(readFileSync(hardB, "utf8"), /\[mcp_servers\.ash\]/, "另一端跟着更新");
  }

  // 审查复现的原样形状,问真 codex:带引号的登记它认得 → 不追加;重复定义它读不动 → 不动。
  const codex = which("codex");
  if (codex) {
    const home = join(directory, "home");
    const askCodex = (args) => {
      const shell = IS_WINDOWS && /\.(cmd|bat)$/i.test(codex);
      return spawnSync(shell ? `"${codex}"` : codex, args, {
        encoding: "utf8", windowsHide: true, shell, cwd: tmpdir(), timeout: 60_000, env: { ...process.env, CODEX_HOME: home },
      });
    };
    const real = () => {
      const res = askCodex(["mcp", "list", "--json"]);
      return parseCodexList(res.status ?? 1, res.stdout ?? "");
    };
    const realRemove = (name) => askCodex(["mcp", "remove", name]).status === 0;
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
  } else {
    console.log("⚠ 没装 codex,跳过问真 codex 那几条");
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("✅ setup 给 codex 接 ash MCP:先问 codex 本人、读不动不写、写坏回滚");
