// 安装器那一侧的回归:`scripts/mcp-hosts.mjs` + `scripts/config-publish.mjs`(裸 Node)。
//
// 为什么跟 `test-ash-mcp-registry.ts` 分开:那边测的是 server 里那条通用补接链(TS),
// 这边测的是 **setup 在裸 Node 上跑的那一份**。同一条规矩在这个仓库里有两份实现(setup
// 跑在 `npm run setup` 时,那会儿还没 build,导不进 TS),所以这里盯两件事:
//
//   ① **两边不许漂** —— 落点、变量、格式族、要不要 `type`/`enabled` 逐项比对;
//   ② **写盘那一步不许把用户配置留成半截** —— 本轮审查 R1 实测到的那个:上一版直接
//      `writeFileSync`,注入一次 ENOSPC 之后活动配置只剩 `{\n  "userSetting": "k`,
//      备份完整但 CLI 读的是活动那份。有备份 ≠ 失败安全。
//
// 跑:`npm -w server run test:ash-mcp-registry`(它串起这两条 + kimi 那条)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_TYPES, type AgentType } from "@ash/shared";
import { cliSpec } from "../src/executors/catalog/index.js";
import { ASH_MCP_TABLE, ashMcpConfigDir, canRegisterAshMcp } from "../src/mcp-registry/catalog.js";
import { ashMcpConfigFile } from "../src/mcp-registry/register.js";
import { REPO_DIR } from "../src/paths.js";

type HostSite = {
  bins: string[]; dirEnv: string | null; dirEnvIsFile?: boolean;
  relative: string[]; alternates?: string[][]; opaque?: string[][];
  shape: string; type?: string; enabled?: boolean;
  dir: (env: NodeJS.ProcessEnv, home: string) => string;
};

const hosts = await import(pathToFileURL(join(REPO_DIR, "scripts", "mcp-hosts.mjs")).href) as {
  HOST_SITES: Record<string, HostSite>;
  hostMcpFile: (agentType: string, opts: { env: NodeJS.ProcessEnv; home: string }) => string | null;
  registerHostMcp: (opts: {
    agentType: string; mcpEntry: string; url: string; nodeBin?: string;
    env?: NodeJS.ProcessEnv; home?: string;
  }) => { file: string; added: boolean; why?: string; backup?: string | null };
};

const publish = await import(pathToFileURL(join(REPO_DIR, "scripts", "config-publish.mjs")).href) as {
  readForWrite: (file: string) => { file: string; text: string | null } | null;
  publishConfirmed: (opts: {
    file: string; previous: string | null; body: string; backupSuffix?: string;
    write?: (file: string, body: string, enc: string) => void;
  }) => { ok: true; backup: string | null } | { ok: false; why: string };
};

const root = mkdtempSync(join(tmpdir(), "ash-mcp-installer-"));
let done = 0;
const group = (name: string) => { done++; process.stdout.write(`  ✓ ${name}\n`); };

/** 一个干净的假 HOME。安装器写的是「宿主机那份」,所以沙盘就是整个 home。 */
const home = (name: string): string => {
  const dir = join(root, `${name}-${done}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const ENTRY = "/repo/mcp/dist/index.js";
const URL_BASE = "http://127.0.0.1:4317";
const install = (agentType: string, h: string, env: NodeJS.ProcessEnv = {}) =>
  hosts.registerHostMcp({ agentType, mcpEntry: ENTRY, url: URL_BASE, nodeBin: "node", env, home: h });

try {
  // ── ① 两份实现不许漂(TS 表 ↔ 裸 Node 那份)──────────────────────────────
  {
    const SHAPE_ID: Record<string, string> = {
      mcpServers: "mcp-servers-json", opencode: "opencode-json", toml: "mcp-servers-toml",
    };
    // claude 走它自己的 `mcp add`(那是它的原生入口),codex 走 `codex-mcp.mjs`(发布前要
    // codex 本人点头)—— 其余每一家都必须在裸 Node 那份表里有落点。
    const expected = AGENT_TYPES.filter((t) => canRegisterAshMcp(t) && t !== "claude" && t !== "codex");
    assert.deepEqual(Object.keys(hosts.HOST_SITES).sort(), [...expected].sort(), "两边覆盖的家数要一致");
    for (const [type, site] of Object.entries(hosts.HOST_SITES)) {
      const mechanism = ASH_MCP_TABLE[type as AgentType];
      assert.equal(mechanism.kind, "file", `${type}:裸 Node 那份只该有能自动写的`);
      if (mechanism.kind !== "file") continue;
      assert.equal(SHAPE_ID[site.shape], mechanism.shape.id, `${type}:格式族要对上`);
      assert.equal(site.dirEnv, mechanism.site.dirEnv, `${type}:配置目录变量要对上`);
      assert.equal(!!site.dirEnvIsFile, !!mechanism.site.dirEnvIsFile, `${type}:变量指文件还是目录要对上`);
      assert.deepEqual(site.relative, [...mechanism.site.relative], `${type}:文件位置要对上`);
      for (const key of ["alternates", "opaque"] as const) {
        assert.deepEqual(
          (site[key] ?? []).map((a) => [...a]),
          (mechanism.site[key] ?? []).map((a) => [...a]),
          `${type}:${key} 要对上`,
        );
      }
      // `type` 是**字面值**,不是开关:cursor 写 stdio、copilot 写 local,互相套用就错。
      assert.equal(site.type, mechanism.writeType, `${type}:type 的值要对上`);
      assert.equal(!!site.enabled, !!mechanism.writeEnabled, `${type}:要不要写 enabled 得一致`);
      // 默认目录也要算出同一个路径(QODER_CONFIG_DIR_NAME / XDG 这些分支都在里面),
      // 外加每家自己那个覆盖变量 —— qwen 那一条就是只测默认值看不出来的(审查 R3)。
      const envs: NodeJS.ProcessEnv[] = [{}, { XDG_CONFIG_HOME: "/xdg" }, { QODER_CONFIG_DIR_NAME: ".qq" }];
      if (mechanism.site.dirEnv) envs.push({ [mechanism.site.dirEnv]: "/profile" });
      for (const env of envs) {
        assert.equal(
          hosts.hostMcpFile(type, { env, home: "/h" }),
          mechanism.site.dirEnvIsFile && env[mechanism.site.dirEnv ?? ""]
            ? env[mechanism.site.dirEnv ?? ""]
            : ashMcpConfigFile(ashMcpConfigDir(type, env, "/h")!, mechanism.site),
          `${type}:路径要算出同一个(env=${JSON.stringify(env)})`,
        );
      }
      // 命令名也不许漂:裸 Node 那边靠它判「这台机器装没装」。
      for (const bin of site.bins) {
        assert.ok(cliSpec(type as AgentType).bins.includes(bin), `${type}:${bin} 不在执行器目录的 bins 里`);
      }
    }
    group("TS 表与裸 Node 那份逐项对齐(含覆盖变量那一层)");
  }

  // ── ② 写到一半失败:活动配置必须还是原来那份(本轮审查 R1)──────────────────
  {
    const h = home("partial");
    const file = join(h, "config.json");
    const before = `${JSON.stringify({ userSetting: "keep-me", mcpServers: { other: { command: "x" } } }, null, 2)}\n`;
    writeFileSync(file, before, "utf8");
    const read = publish.readForWrite(file)!;
    // 注入一次「写了 21 个字节就抛」—— 审查那次 ENOSPC 复现出来的就是这个形状。
    let wrote = 0;
    const flaky = (target: string, body: string) => {
      if (wrote++ === 0) {
        writeFileSync(target, body.slice(0, 21), "utf8");
        const e = new Error("no space left on device") as Error & { code?: string };
        e.code = "ENOSPC";
        throw e;
      }
      writeFileSync(target, body, "utf8");
    };
    const r = publish.publishConfirmed({ file, previous: read.text, body: "{}\n", write: flaky });
    assert.ok(!r.ok, "写失败要如实说");
    assert.match(r.ok ? "" : r.why, /原样放回去/, "而且要说清原文已经回去了");
    assert.equal(readFileSync(file, "utf8"), before, "活动配置必须还是原来那份(不许留半截)");
    assert.ok(existsSync(`${file}.bak-ash-setup`), "备份也还在");

    // 原来**没有**这个文件:写失败就不该留下一个半截的新文件。
    const h2 = home("partial-new");
    const file2 = join(h2, "sub", "config.json");
    let tries = 0;
    const r2 = publish.publishConfirmed({
      file: file2,
      previous: null,
      body: "{}\n",
      write: (target, body) => {
        if (tries++ === 0) { writeFileSync(target, body.slice(0, 1), "utf8"); throw new Error("boom"); }
        writeFileSync(target, body, "utf8");
      },
    });
    assert.ok(!r2.ok, "写失败要如实说");
    assert.ok(!existsSync(file2), "原来没有这个文件 ⇒ 失败后也不许留下来");
    group("写到一半失败:原文回写、不留半截");
  }

  // ── ③ 提交前的新鲜度 + 写完读回来比对 ────────────────────────────────────
  {
    const h = home("fresh");
    const file = join(h, "config.json");
    writeFileSync(file, "{\n}\n", "utf8");
    const read = publish.readForWrite(file)!;
    writeFileSync(file, '{\n  "userJustSaved": true\n}\n', "utf8");   // 别的程序抢先存了一版
    const r = publish.publishConfirmed({ file, previous: read.text, body: "{}\n" });
    assert.ok(!r.ok && /被别的程序改过/.test(r.why), `过期快照不许盖下去:${r.ok ? "" : r.why}`);
    assert.equal(readFileSync(file, "utf8"), '{\n  "userJustSaved": true\n}\n', "那次改动要留着");

    // 写完读回来跟要写的不一样(有人同时也在写)⇒ 如实报,别说「已注册」。
    const h2 = home("readback");
    const file2 = join(h2, "config.json");
    writeFileSync(file2, "{\n}\n", "utf8");
    const read2 = publish.readForWrite(file2)!;
    const r2 = publish.publishConfirmed({
      file: file2, previous: read2.text, body: '{"mine":1}\n',
      write: (target) => writeFileSync(target, '{"someone-else":1}\n', "utf8"),
    });
    assert.ok(!r2.ok && /读回来跟要写的那份不一样/.test(r2.why), `读回来不一致要报:${r2.ok ? "" : r2.why}`);

    // 正常那一路:就地写,inode 不换(文件身份保住)。
    const h3 = home("inplace");
    const file3 = join(h3, "config.json");
    writeFileSync(file3, "{\n}\n", "utf8");
    const ino = Number(statSync(file3).ino);
    const read3 = publish.readForWrite(file3)!;
    const r3 = publish.publishConfirmed({ file: file3, previous: read3.text, body: '{"ok":1}\n' });
    assert.ok(r3.ok, r3.ok ? "" : r3.why);
    if (ino !== 0) assert.equal(Number(statSync(file3).ino), ino, "就地写:inode 不换");
    group("发布事务:过期快照不盖、落盘后读回来比对、就地写");
  }

  // ── ④ TOML:别人装过第三方 MCP 也要接得上(本轮审查 R6)────────────────────
  {
    const grokFile = (h: string) => join(h, ".grok", "config.toml");
    const seed = (h: string, body: string) => {
      mkdirSync(dirname(grokFile(h)), { recursive: true });
      writeFileSync(grokFile(h), body, "utf8");
      return grokFile(h);
    };

    // ① 只有别人那张表 ⇒ 必须追加(上一版见 `mcp_servers` 就跳过,于是永远接不上,
    //    而 grok 没有隔离档那条路可以后补)。
    const third = home("toml-third");
    const f = seed(third, '[mcp_servers.other]\ncommand = "other-mcp"\n');
    const r = install("grok", third);
    assert.ok(r.added, `第三方表在也要接上:${r.why ?? ""}`);
    const after = readFileSync(f, "utf8");
    assert.match(after, /\[mcp_servers\.other\]/, "别人那张表留着");
    assert.match(after, /\[mcp_servers\.ash\]\n/, "自己那张接上了");
    assert.match(after, /enabled = true/, "grok 那一行照它自己 mcp add 的写法");

    // ② 带引号的名字也算「已经有了」—— 认不出来就会追加一份重名表,CLI 整份拒载。
    for (const head of ['[mcp_servers."ash"]', "[mcp_servers.'harness']", "[ mcp_servers . ash ]"]) {
      const h = home("toml-quoted");
      const file = seed(h, `${head}\ncommand = "node"\n`);
      const before = readFileSync(file, "utf8");
      const skip = install("grok", h);
      assert.ok(!skip.added && /已经有/.test(skip.why ?? ""), `${head}:要认出来是已有登记`);
      assert.equal(readFileSync(file, "utf8"), before, `${head}:一个字节都不许动`);
    }

    // ③ 内联表 / 点号键 / 总表:判不准,一个字都不写(写错会让整份配置读不出来)。
    for (const body of [
      'mcp_servers = { other = { command = "x" } }\n',
      'mcp_servers.other.command = "x"\n',
      '[mcp_servers]\nother = { command = "x" }\n',
    ]) {
      const h = home("toml-doubt");
      const file = seed(h, body);
      const doubt = install("grok", h);
      assert.ok(!doubt.added, `判不准就不写:${body.trim()}`);
      assert.equal(readFileSync(file, "utf8"), body, "原文不许动");
    }

    // ④ 多行字符串里的示例不是事实:剔掉它之后这份配置就是「只有别人那张表」。
    const ml = home("toml-multiline");
    const mlFile = seed(ml, [
      "[mcp_servers.other]", 'command = "x"', "",
      "[mcp_servers.other.env]", 'NOTE = """', '[mcp_servers.ash]', 'mcp_servers = { }', '"""', "",
    ].join("\n"));
    const added = install("grok", ml);
    assert.ok(added.added, `多行字符串里的文本不该挡住追加:${added.why ?? ""}`);
    assert.match(readFileSync(mlFile, "utf8"), /\[mcp_servers\.ash\]\n/);

    // ⑤ 根级关掉了 ash ⇒ 不替他打开(`disabled_mcp_servers` 必须在表头之前才是根级)。
    const off = home("toml-off");
    const offFile = seed(off, 'disabled_mcp_servers = ["ash"]\n\n[mcp_servers.other]\ncommand = "x"\n');
    const offBefore = readFileSync(offFile, "utf8");
    const offR = install("grok", off);
    assert.ok(!offR.added && /disabled_mcp_servers/.test(offR.why ?? ""), `关着的要说清:${offR.why ?? ""}`);
    assert.equal(readFileSync(offFile, "utf8"), offBefore, "也不动它");
    group("TOML:第三方表在也接得上、重名认得出、判不准就不写");
  }

  // ── ⑤ JSON:注释不改写、已有不覆盖、值认不出来不覆盖 ──────────────────────
  {
    const qwenFile = (h: string) => join(h, ".qwen", "settings.json");

    // 新建那一路:父目录会建,写出来的就是表里那一层(审查 R3 的落点)。
    const fresh = home("json-fresh");
    const r = install("qwen", fresh);
    assert.ok(r.added, r.why ?? "");
    assert.equal(r.file, qwenFile(fresh), "qwen 的落点是 $QWEN_HOME/settings.json 这一层");
    const doc = JSON.parse(readFileSync(qwenFile(fresh), "utf8")) as
      { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    assert.deepEqual(doc.mcpServers.ash, { command: "node", args: [ENTRY], env: { ASH_URL: URL_BASE } });

    // 覆盖变量指到的目录就是最终配置目录(默认值路径正确掩盖不了这一条)。
    const over = home("json-override");
    const profile = join(over, "profile");
    const r2 = install("qwen", over, { QWEN_HOME: profile });
    assert.ok(r2.added, r2.why ?? "");
    assert.equal(r2.file, join(profile, "settings.json"), "QWEN_HOME 底下不许再接一层 .qwen");

    // 已有 ash/harness:一个字节都不动。
    for (const name of ["ash", "harness"]) {
      const h = home(`json-keep-${name}`);
      mkdirSync(dirname(qwenFile(h)), { recursive: true });
      const mine = `${JSON.stringify({ mcpServers: { [name]: { command: "mine" } } }, null, 2)}\n`;
      writeFileSync(qwenFile(h), mine, "utf8");
      const keep = install("qwen", h);
      assert.ok(!keep.added && /已经有/.test(keep.why ?? ""), `${name}:要认出来`);
      assert.equal(readFileSync(qwenFile(h), "utf8"), mine, `${name}:一个字节都不许动`);
    }

    // 值认不出来(null / 字符串):也算已有,不覆盖。
    for (const value of [null, "node /x.js"]) {
      const h = home("json-weird");
      mkdirSync(dirname(qwenFile(h)), { recursive: true });
      const mine = `${JSON.stringify({ mcpServers: { ash: value } }, null, 2)}\n`;
      writeFileSync(qwenFile(h), mine, "utf8");
      const keep = install("qwen", h);
      assert.ok(!keep.added, `${JSON.stringify(value)}:认不出来就不写`);
      assert.equal(readFileSync(qwenFile(h), "utf8"), mine, "一个字节都不许动");
    }

    // 有注释的配置:不改写(序列化会把注释丢掉),也不在旁边另建一份。
    const jsonc = home("jsonc");
    const dir = join(jsonc, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    const commented = '{\n  // 我自己写的注释\n  "theme": "dark"\n}\n';
    writeFileSync(join(dir, "opencode.jsonc"), commented, "utf8");
    const jr = install("opencode", jsonc);
    assert.ok(!jr.added && /注释/.test(jr.why ?? ""), `有注释要如实说:${jr.why ?? ""}`);
    assert.equal(readFileSync(join(dir, "opencode.jsonc"), "utf8"), commented, "注释一个字都不许丢");
    assert.ok(!existsSync(join(dir, "opencode.json")), "也不许另建一份 .json");
    group("JSON:落点对、覆盖变量对、已有/认不出的都不覆盖、注释不改写");
  }

  // ── ⑥ trae:同目录有它那份 YAML 时一个字都不写 ───────────────────────────
  {
    const h = home("trae-yaml");
    mkdirSync(join(h, ".trae"), { recursive: true });
    writeFileSync(join(h, ".trae", "traecli.yaml"), "mcp_servers:\n  - name: ash\n", "utf8");
    const r = install("trae", h);
    assert.ok(!r.added && /traecli\.yaml/.test(r.why ?? ""), `有那份 YAML 就不写:${r.why ?? ""}`);
    assert.ok(!existsSync(join(h, ".trae", "mcp.json")), "也不许另建一份 mcp.json");

    const clean = home("trae-clean");
    const ok = install("trae", clean);
    assert.ok(ok.added, ok.why ?? "");
    const doc = JSON.parse(readFileSync(join(clean, ".trae", "mcp.json"), "utf8")) as
      { mcpServers: Record<string, { type: string }> };
    assert.equal(doc.mcpServers.ash!.type, "stdio", "trae 的示例里 stdio 条目带 type");
    group("trae:撞上原生 YAML 就不写,干净时写标准 JSON");
  }

  // ── ⑦ 不认得的 agentType 要当场抛(静默跳过正是这轮在治的病)──────────────
  {
    assert.throws(() => install("nope", home("unknown")), /没有 nope 的 MCP 落点/);
    group("拼错执行器名字:当场抛，不静默跳过");
  }

  console.log(`✅ 安装器那一侧(裸 Node):${done} 组全过`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
