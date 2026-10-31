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
import * as edit from "../src/mcp-registry/json-edit.js";
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

/**
 * **只插入,没改没删**:新文本 = 原文公共前缀 + 插进去那一段 + 原文公共后缀。
 * 「只改我们那一条」的通用判据,不依赖插在哪儿、插了什么形状(本轮审查 R4)。
 */
function onlyInserted(before: string, after: string): boolean {
  let head = 0;
  while (head < before.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return head + tail === before.length && after.length >= before.length;
}

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

  // ── ② 写盘失败:活动配置必须还是原来那份(审查 R1 两轮)──────────────────────
  {
    const probeOf = (f: string) => `${f}.ash-publish-probe`;

    // ⒜ **持续**写不动(配额耗尽、设备 EIO、挂载转只读):第 2 轮审查注入持续 EIO 实测,上一版
    //    先截断活动文件、再靠「第二次写」回写,持续故障下回写同样失败 —— 盘上留下半截正文
    //    (`{"userSetting":"ke`),备份完整而 CLI 读的是活动那份。现在**预演先行**:同目录写个
    //    临时文件试一次,落不下去就在动用户那份之前收手。
    const hp = home("persistent");
    const file0 = join(hp, "config.json");
    const intact = `${JSON.stringify({ userSetting: "keep-me" }, null, 2)}\n`;
    writeFileSync(file0, intact, "utf8");
    let calls = 0;
    const r0 = publish.publishConfirmed({
      file: file0,
      previous: publish.readForWrite(file0)!.text,
      body: `${JSON.stringify({ ash: "x", userSetting: "keep-me" }, null, 2)}\n`,
      write: (target: string, body: string) => {
        calls++;
        if (typeof body === "string" && body.length > 18) writeFileSync(target, body.slice(0, 18), "utf8");
        const e = new Error("i/o error") as Error & { code?: string };
        e.code = "EIO";
        throw e;
      },
    });
    assert.ok(!r0.ok, "写不动要如实说");
    assert.match(r0.ok ? "" : r0.why, /什么都没写/, "而且要说清一个字节都没写");
    assert.equal(readFileSync(file0, "utf8"), intact, "活动配置必须逐字节还是原来那份");
    assert.equal(calls, 1, "预演那一次就收手了,活动文件根本没被碰");
    assert.ok(!existsSync(probeOf(file0)), "预演产物不许留下");
    assert.ok(!existsSync(`${file0}.bak-ash-setup`), "没动过就别留一份白备份");

    // ⒝ 预演过得去、**真写那一下**才失败(只读文件、文件被别人独占):这一档只能靠回写,
    //    所以仍要钉住「原文回去了 + 备份在」。
    const h = home("partial");
    const file = join(h, "config.json");
    const before = `${JSON.stringify({ userSetting: "keep-me", mcpServers: { other: { command: "x" } } }, null, 2)}\n`;
    writeFileSync(file, before, "utf8");
    const read = publish.readForWrite(file)!;
    let wrote = 0;
    const flaky = (target: string, body: string, opts?: unknown) => {
      // 预演照常放过(它写的是 `.ash-publish-probe`),真写那一下才抛。
      if (target.endsWith(".ash-publish-probe")) { writeFileSync(target, body, opts as never); return; }
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
    assert.ok(!existsSync(probeOf(file)), "预演产物不许留下");

    // ⒞ 原来**没有**这个文件:写失败就不该留下一个半截的新文件。
    const h2 = home("partial-new");
    const file2 = join(h2, "sub", "config.json");
    let tries = 0;
    const r2 = publish.publishConfirmed({
      file: file2,
      previous: null,
      body: "{}\n",
      write: (target: string, body: string, opts?: unknown) => {
        if (target.endsWith(".ash-publish-probe")) { writeFileSync(target, body, opts as never); return; }
        if (tries++ === 0) { writeFileSync(target, body.slice(0, 1), "utf8"); throw new Error("boom"); }
        writeFileSync(target, body, "utf8");
      },
    });
    assert.ok(!r2.ok, "写失败要如实说");
    assert.ok(!existsSync(file2), "原来没有这个文件 ⇒ 失败后也不许留下来");
    assert.ok(!existsSync(probeOf(file2)), "预演产物不许留下");

    // ⒟ 新建那一份只给自己读(kimi 原来的写入器就是 0600;改走通用发布器后别退成 umask)。
    const h3 = home("mode");
    const file3 = join(h3, "deep", "config.json");
    const r3 = publish.publishConfirmed({ file: file3, previous: null, body: "{}\n" });
    assert.ok(r3.ok, r3.ok ? "" : r3.why);
    assert.equal(statSync(file3).mode & 0o777, 0o600, "新建的配置只给自己读");
    group("写盘失败:持续故障在动手之前收手、真写失败回写原文、新建不留半截也不放宽权限");
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

    // ⑤ **注释里的三引号不是字符串定界符**(本轮审查 R2,实测复现过):上一版按行先找
    //     `"""` 再剔 `#`,顺序反了,于是夹在两行注释之间的真 `[mcp_servers.ash]` 被当成多行
    //     字符串正文吞掉 —— 安装器追加第二张同名表并报「已接好」,真 grok 那边 `duplicate key`
    //     让整份配置都读不出来(连用户自己的 MCP 一起),而它的退出码还是 0。
    {
      const h = home("toml-comment-quotes");
      const file = seed(h, '# 示例 """\n[mcp_servers.ash]\ncommand = "node"\nargs = ["/old.js"]\n# 结束 """\n');
      const before = readFileSync(file, "utf8");
      const r = install("grok", h);
      assert.ok(!r.added && /已经有/.test(r.why ?? ""), `注释里的三引号不该吞掉真表:${r.why ?? ""}`);
      assert.equal(readFileSync(file, "utf8"), before, "一个字节都不许动");
      assert.equal((readFileSync(file, "utf8").match(/\[mcp_servers\.ash\]/g) ?? []).length, 1, "不许多出一张同名表");

      // 同样的注释形状、但本来没有 ash:照样该接上(注释不是「判不准」)。
      const h2 = home("toml-comment-quotes-empty");
      const f2 = seed(h2, '# 示例 """\n[mcp_servers.other]\ncommand = "x"\n# 结束 """\n');
      const r2 = install("grok", h2);
      assert.ok(r2.added, `注释不该挡住追加:${r2.why ?? ""}`);
      const after = readFileSync(f2, "utf8");
      assert.equal((after.match(/\[mcp_servers\.ash\]/g) ?? []).length, 1, "恰好一张 ash 表");
      assert.match(after, /\[mcp_servers\.other\]/, "别人那张还在");
    }

    // ⑥ 根级关掉了 ash ⇒ 不替他打开(`disabled_mcp_servers` 必须在表头之前才是根级)。
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

    // 带注释的配置:**现在能补接了**,注释与原有键逐字节留着,也不在旁边另建一份
    // (上一版走 JSON 往返,只能靠「有注释就不改写」躲开 —— 本轮审查 R4)。
    const jsonc = home("jsonc");
    const dir = join(jsonc, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    const commented = '{\n  // 我自己写的注释\n  "theme": "dark"\n}\n';
    writeFileSync(join(dir, "opencode.jsonc"), commented, "utf8");
    const jr = install("opencode", jsonc);
    assert.ok(jr.added, `带注释也该补上:${jr.why ?? ""}`);
    const jsoncAfter = readFileSync(join(dir, "opencode.jsonc"), "utf8");
    assert.ok(onlyInserted(commented, jsoncAfter), `除了插进去那一段,一个字节都不许动：\n${jsoncAfter}`);
    assert.ok(!existsSync(join(dir, "opencode.json")), "也不许另建一份 .json");

    // 超出 JS 安全整数的原值、`1e999`、`-0`、尾逗号:全量往返会改掉它们,文本插入不会。
    const precise = home("precise");
    const pfile = qwenFile(precise);
    mkdirSync(dirname(pfile), { recursive: true });
    const exact = '{\n  "bigId": 9007199254740993,\n  "huge": 1e999,\n  "negZero": -0,\n}\n';
    writeFileSync(pfile, exact, "utf8");
    const pr = install("qwen", precise);
    assert.ok(pr.added, `该补上:${pr.why ?? ""}`);
    const pafter = readFileSync(pfile, "utf8");
    assert.match(pafter, /9007199254740993/, "大整数原值不许被改成 …992");
    assert.match(pafter, /1e999/, "`1e999` 不许变成 null");
    assert.ok(onlyInserted(exact, pafter), `除了插进去那一段,一个字节都不许动：\n${pafter}`);
    group("JSON:落点对、覆盖变量对、已有/认不出的都不覆盖、改写无损(注释与原值全留着)");
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

  // ── ⑦ 一家 CLI 会读好几份配置:判「有没有」要看全(本轮审查 R3)─────────────
  {
    const mk = (url: string) => `${JSON.stringify({
      mcp: { ash: { type: "local", command: ["node", "/old.js"], environment: { ASH_URL: url }, enabled: true } },
    }, null, 2)}\n`;
    const empty = '{\n  "$schema": "x"\n}\n';

    // ⒜ 全局那份已经有 ash、`OPENCODE_CONFIG` 那份没有:**不写**。那个变量是「再加一份」而
    //    不是「取代」(真 opencode 三组实测),全局那条照样生效 —— 往更高优先级那份补一条就是
    //    把它顶掉(上一版实测把 URL 从用户那条换成了默认那条)。
    const h = home("merge-global-has");
    const globalFile = join(h, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(globalFile), { recursive: true });
    const globalBody = mk("http://127.0.0.1:54321");
    writeFileSync(globalFile, globalBody, "utf8");
    const custom = join(h, "custom.json");
    writeFileSync(custom, empty, "utf8");
    const r = install("opencode", h, { OPENCODE_CONFIG: custom });
    assert.ok(!r.added, "全局那份已经有了就不该再写");
    assert.match(r.why ?? "", /也会读这份/, `要说清是哪一份已经有了:${r.why ?? ""}`);
    assert.equal(readFileSync(globalFile, "utf8"), globalBody, "全局那份一个字节都不许动");
    assert.equal(readFileSync(custom, "utf8"), empty, "变量那份也不许写");

    // ⒝ 两份都没有:写进变量指的那一份(落点仍然只有一个解析口)。
    const h2 = home("merge-none-has");
    const g2 = join(h2, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(g2), { recursive: true });
    writeFileSync(g2, empty, "utf8");
    const custom2 = join(h2, "custom.json");
    writeFileSync(custom2, empty, "utf8");
    const r2 = install("opencode", h2, { OPENCODE_CONFIG: custom2 });
    assert.ok(r2.added, `两份都没有就该补上:${r2.why ?? ""}`);
    assert.equal(r2.file, custom2, "写的就是变量指的那一份");
    assert.match(readFileSync(custom2, "utf8"), /"ash"/, "确实写进去了");
    assert.equal(readFileSync(g2, "utf8"), empty, "全局那份仍然不许动");
    group("会读好几份配置的那家:任一份已有就不写、都没有才写,全局那份只读");
  }

  // ── ⑧ 文本编辑器两侧不许漂(TS `json-edit.ts` ↔ 裸 Node `json-edit.mjs`)──────
  //
  // 为什么要两份:setup 跑在 `npm run setup`(那会儿还没 build,导不进 TS)。两份实现就
  // 一定会漂,所以逐字节钉住 —— 同一份输入,插出来的文本、读出来的值、剔掉注释后的样子
  // 三项都必须一模一样(本轮审查 R4 的同款理由:走到用户字节上的分支只许有一套语义)。
  {
    const corpus: string[] = [
      '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n',
      '{\n  // 用户的注释\n  "mcpServers": {\n    /* 块注释 */\n    "other": { "command": "x" }\n  }\n}\n',
      '{\n  "mcpServers": {}\n}\n',
      '{}\n',
      '{\n  "userSetting": "k",\n}\n',                               // 尾逗号
      '{\n  "big": 9007199254740993,\n  "inf": 1e999,\n  "neg": -0\n}\n', // 原值不许被序列化碾平
      '{\n  "dup": 1,\n  "dup": 2\n}\n',                             // 重复键
      '{\n  "mcpServers": {\n    "ash": { "command": "old" }\n  }\n}\n',  // 已有 ⇒ 两边都该拒
      '{\n  "mcpServers": [1, 2]\n}\n',                               // 容器不是对象 ⇒ 两边都该拒
      '[1, 2]\n',                                                      // 根不是对象
      '{ "a": 1 ',                                                      // 截断
      '{\n  "s": "带 } 和 // 的字符串"\n}\n',
      '',
      '   \n',
    ];
    const bare = await import(pathToFileURL(join(REPO_DIR, "scripts", "json-edit.mjs")).href) as typeof edit;
    const value = { command: "node", args: [ENTRY], env: { ASH_URL: URL_BASE } };
    for (const text of corpus) {
      const label = JSON.stringify(text.slice(0, 40));
      const a = edit.spliceJsonMember(text, "mcpServers", "ash", value);
      const b = bare.spliceJsonMember(text, "mcpServers", "ash", value);
      assert.deepEqual(b, a, `spliceJsonMember 两侧不一致(${label})`);
      const tag = (v: unknown) => (v === undefined ? "<undefined>" : JSON.stringify(v));
      assert.equal(tag(bare.readJsonLoose(text)), tag(edit.readJsonLoose(text)), `readJsonLoose 两侧不一致(${label})`);
      assert.equal(bare.stripTrivia(text), edit.stripTrivia(text), `stripTrivia 两侧不一致(${label})`);
      // 顺带钉住「只插入」:成功的那几份,原字节必须整段留在结果里。
      if (a.body && text.trim()) assert.ok(onlyInserted(text, a.body), `不是纯插入(${label})`);
    }
    group(`文本编辑器两侧逐字节对齐(${corpus.length} 份刁钻输入)`);
  }

  // ── ⑨ 不认得的 agentType 要当场抛(静默跳过正是这轮在治的病)──────────────
  {
    assert.throws(() => install("nope", home("unknown")), /没有 nope 的 MCP 落点/);
    group("拼错执行器名字:当场抛，不静默跳过");
  }

  console.log(`✅ 安装器那一侧(裸 Node):${done} 组全过`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
