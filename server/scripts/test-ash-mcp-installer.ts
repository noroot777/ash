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
import { checkPublishCases, type BarePublish } from "./mcp-publish-cases.js";

type HostSite = {
  bins: string[]; dirEnv: string | null; dirEnvIsFile?: boolean;
  altDirEnv?: string; contentEnv?: string; sourcesMerge?: boolean;
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

const publish = await import(
  pathToFileURL(join(REPO_DIR, "scripts", "config-publish.mjs")).href
) as unknown as BarePublish;

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
      // 来源那一组也不许漂:少一个变量 = 少看一份配置,而「少看一份」正是本轮 F4 的病根。
      assert.equal(site.altDirEnv, mechanism.site.altDirEnv, `${type}:再加一个目录的变量要对上`);
      assert.equal(site.contentEnv, mechanism.site.contentEnv, `${type}:整段配置那个变量要对上`);
      assert.equal(!!site.sourcesMerge, !!mechanism.site.sourcesMerge, `${type}:合并语义实测没实测要一致`);
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

  // ── ②③⑩⑪⑫ 发布事务那一层(在 `mcp-publish-cases.ts`)──────────────────────
  await checkPublishCases(publish, home, group);

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

  // ── ⑥b 同名容器重复 / 空容器里的注释(本轮审查 F5、N1)──────────────────────
  {
    // F5:`JSON.parse` 的语义是**最后一个同名键赢**,所以生效的容器是后面那个。上一版编辑器
    //     按 `.find()` 插进**第一个**,于是「写进去了」而最终生效的那个容器里仍然没有 ash,
    //     安装日志还报 added。两族(`mcpServers` / opencode 的 `mcp`)都算。
    const dup = home("dup-container");
    const file = join(dup, ".kimi-code", "mcp.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"mcpServers":{},"mcpServers":{"other":{"command":"tool"}}}\n', "utf8");
    const r = install("kimi", dup);
    assert.ok(r.added, `重复容器也该补得上:${r.why ?? ""}`);
    const text = readFileSync(file, "utf8");
    // 判据用 `JSON.parse` —— 它就是 CLI 看到的那一份。
    const live = (JSON.parse(text) as { mcpServers: Record<string, unknown> }).mcpServers;
    assert.ok(Object.hasOwn(live, "ash"), `生效的那个容器里必须有 ash:${text}`);
    assert.ok(Object.hasOwn(live, "other"), "用户原来那条也要还在");

    // opencode 那一族同理(容器叫 `mcp`)。
    const dup2 = home("dup-container-oc");
    const file2 = join(dup2, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(file2), { recursive: true });
    writeFileSync(file2, '{"mcp":{},"mcp":{"other":{"type":"local"}}}\n', "utf8");
    const r2 = install("opencode", dup2);
    assert.ok(r2.added, `重复容器也该补得上:${r2.why ?? ""}`);
    const live2 = (JSON.parse(readFileSync(file2, "utf8")) as { mcp: Record<string, unknown> }).mcp;
    assert.ok(Object.hasOwn(live2, "ash"), "生效的那个 mcp 容器里必须有 ash");

    // N1:**空容器里的注释也要留着**。上一版那条空对象分支把 `{` 和 `}` 之间的原文整段截掉,
    //     ash 能生效,但用户写在里面的说明没了 —— 补接的边界是「只插入,不删不改」。
    const keep = home("empty-comment");
    const file3 = join(keep, ".kimi-code", "mcp.json");
    mkdirSync(dirname(file3), { recursive: true });
    writeFileSync(file3, '{\n  "mcpServers": {\n    // 这里本来是空的，这句说明要留着\n  }\n}\n', "utf8");
    const r3 = install("kimi", keep);
    assert.ok(r3.added, `空容器也该补得上:${r3.why ?? ""}`);
    const text3 = readFileSync(file3, "utf8");
    assert.match(text3, /这句说明要留着/, `空容器里的注释不许被删:${text3}`);
    assert.ok(Object.hasOwn((JSON.parse(text3.replace(/^\s*\/\/.*$/gm, "")) as
      { mcpServers: Record<string, unknown> }).mcpServers, "ash"), "ash 也确实写进去了");

    // 根对象只有注释、连容器都没有的那一档(同一条分支的另一入口)。
    const keep2 = home("empty-root-comment");
    const file4 = join(keep2, ".kimi-code", "mcp.json");
    mkdirSync(dirname(file4), { recursive: true });
    writeFileSync(file4, '{\n  // 整份配置目前只有这句说明\n}\n', "utf8");
    const r4 = install("kimi", keep2);
    assert.ok(r4.added, `只有注释的根对象也该补得上:${r4.why ?? ""}`);
    assert.match(readFileSync(file4, "utf8"), /整份配置目前只有这句说明/, "根对象里的注释也不许被删");
    group("同名容器重复:插进生效那个;空容器/只有注释的根对象:注释一个字不丢");
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

    // ⒞ 高优先级那份只把同名 ash **关掉**:真 opencode 报 `ash disabled`(本轮实测)。
    //    上一版「任一份里有就算有」判成已接好 —— 执行器一路跑到交卷才发现工具根本不在。
    const h3 = home("merge-disabled");
    const g3 = join(h3, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(g3), { recursive: true });
    writeFileSync(g3, mk("http://127.0.0.1:54321"), "utf8");
    const off = join(h3, "custom.json");
    const offBody = `${JSON.stringify({ $schema: "x", mcp: { ash: { enabled: false } } }, null, 2)}\n`;
    writeFileSync(off, offBody, "utf8");
    const r3 = install("opencode", h3, { OPENCODE_CONFIG: off });
    assert.ok(!r3.added, "被关着就不该当成已接好、也不该替用户打开");
    assert.match(r3.why ?? "", /关着|没有替你打开/, `要说清是被关掉了:${r3.why ?? ""}`);
    assert.equal(readFileSync(off, "utf8"), offBody, "那份也不许被我们改");

    // ⒟ 默认目录里 `.json` 和 `.jsonc` **两份都读**(本轮实测):ash 在 `.json` 里,`.jsonc`
    //    不含 MCP ⇒ 真 CLI 报 connected。上一版「找到第一个 alternate 就只认它」只看
    //    `.jsonc`,判成没有、还往它里面再补一条,把本来生效那条顶掉。
    const h4 = home("merge-two-files");
    const dir4 = join(h4, ".config", "opencode");
    mkdirSync(dir4, { recursive: true });
    const g4 = join(dir4, "opencode.json");
    const body4 = mk("http://127.0.0.1:54321");
    writeFileSync(g4, body4, "utf8");
    const jsonc4 = join(dir4, "opencode.jsonc");
    writeFileSync(jsonc4, empty, "utf8");
    const r4 = install("opencode", h4, {});
    assert.ok(!r4.added, "另一份已经有生效的 ash 就不该再补");
    assert.equal(readFileSync(g4, "utf8"), body4, "`.json` 那份不许动");
    assert.equal(readFileSync(jsonc4, "utf8"), empty, "`.jsonc` 那份也不许被补一条");

    // ⒠ 只有 `OPENCODE_CONFIG_CONTENT` 里那整段 JSON 有 ash:真 CLI 报 connected,而它
    //    **没有文件可写** ⇒ 一个字都不许写(上一版判成没有、还去改全局文件)。
    const h5 = home("merge-inline");
    const g5 = join(h5, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(g5), { recursive: true });
    writeFileSync(g5, empty, "utf8");
    const r5 = install("opencode", h5, { OPENCODE_CONFIG_CONTENT: mk("http://127.0.0.1:54321") });
    assert.ok(!r5.added, "变量里那段已经有 ash 了就不该写");
    assert.equal(readFileSync(g5, "utf8"), empty, "全局那份一个字节都不许动");

    // ⒡ `OPENCODE_CONFIG_DIR` 再加一个目录、优先级高于默认目录(本轮实测):它里面关掉了
    //    ash ⇒ 最终就是关着的。
    const h6 = home("merge-altdir");
    const g6 = join(h6, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(g6), { recursive: true });
    writeFileSync(g6, mk("http://127.0.0.1:54321"), "utf8");
    const alt6 = join(h6, "altdir");
    mkdirSync(alt6, { recursive: true });
    writeFileSync(join(alt6, "opencode.json"), offBody, "utf8");
    const r6 = install("opencode", h6, { OPENCODE_CONFIG_DIR: alt6 });
    assert.ok(!r6.added, "更高优先级那个目录里关掉了 ⇒ 不许当成已接好");
    assert.match(r6.why ?? "", /关着|没有替你打开/, `要说清是被关掉了:${r6.why ?? ""}`);

    // ⒢ 合并语义**没实测过**的那家(kilo):几份结论不一致 ⇒ 只说看不准,一个字都不写。
    const h7 = home("merge-unmeasured");
    const g7 = join(h7, ".config", "kilo", "kilo.json");
    mkdirSync(dirname(g7), { recursive: true });
    const kiloBody = mk("http://127.0.0.1:54321");
    writeFileSync(g7, kiloBody, "utf8");
    const k7 = join(h7, "custom.json");
    writeFileSync(k7, empty, "utf8");
    const r7 = install("kilo", h7, { KILO_CONFIG: k7 });
    assert.ok(!r7.added, "没实测过合并语义、几份还不一致 ⇒ 不写");
    assert.match(r7.why ?? "", /看不准|没实测/, `要说清是看不准:${r7.why ?? ""}`);
    assert.equal(readFileSync(g7, "utf8"), kiloBody, "两份都不许动");
    assert.equal(readFileSync(k7, "utf8"), empty, "两份都不许动");
    group("会读好几份配置的那家:按「最终生效的是哪一条」判(关掉的、两份都读的、只在变量里的)");
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
      '{\n  "mcpServers": {\n    // 空容器里的说明\n  }\n}\n',       // N1:空容器的内文也不许删
      '{\n  /* 整份只有这句 */\n}\n',                                   // N1:根对象那一层同理
      '{"mcpServers":{},"mcpServers":{"other":{"command":"t"}}}\n',   // F5:生效的是后一个
      '{"mcpServers":{"other":1},"mcpServers":{}}\n',                 // F5:后一个还是空的
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
      // 以及「插在**最终生效**的那个容器里」(本轮审查 F5):同名容器重复时生效的是最后一个
      // (`JSON.parse` 语义),而编辑器原来按 `.find()` 插进第一个 —— 写进去了却接不上。
      if (a.body) {
        const back = edit.readJsonLoose(a.body) as Record<string, unknown> | null | undefined;
        const live = back && typeof back === "object" && !Array.isArray(back) ? back.mcpServers : undefined;
        assert.ok(
          live && typeof live === "object" && !Array.isArray(live) && Object.hasOwn(live, "ash"),
          `ash 没落在最终生效的那个容器里(${label})`,
        );
      }
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
