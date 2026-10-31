// ash MCP 登记表 + 通用补接器的回归。
//
// 这一条盯的是 2026-10-30 那个病:claude / codex 之外的十三家执行器一行注册逻辑都没有,
// 换它们跑任务 MCP 调不到、卷交不了,界面上只看得到「失败」。所以除了「写得对」,这里更要
// 钉住**不许写坏**的那几条 —— 它们动的是用户宿主机上的真配置:
//
//   ① 已有登记一律不覆盖(含历史名 harness),第三方条目一个字节都不动;
//   ② 关着的不替他打开、有注释的不改写、读不动的不猜;
//   ③ 就地写:软链还是软链,inode 不换;
//   ④ 两份实现不许漂 —— TS 那张表和 `scripts/mcp-hosts.mjs`(setup 在裸 Node 上跑,导不进 TS)
//      逐项比对。
//
// 跑:`npm -w server run test:ash-mcp-registry`
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_TYPES, type AgentType } from "@ash/shared";
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { ensureAshMcp } from "../src/auth/user-cli-mcp.js";
import { cliSpec } from "../src/executors/catalog/index.js";
import { fileAshMcpVerdict } from "../src/ash-mcp-file.js";
import { ASH_MCP_TABLE, ashMcpConfigDir, canRegisterAshMcp } from "../src/mcp-registry/catalog.js";
import {
  ashMcpConfigFile, ashMcpHostFile, ashMcpStateIn, ashMcpUnsupported, registerAshMcp,
} from "../src/mcp-registry/register.js";
import { REPO_DIR } from "../src/paths.js";
import { checkSourceModel } from "./mcp-sources-cases.js";

const root = mkdtempSync(join(tmpdir(), "ash-mcp-registry-"));
let done = 0;
const group = (name: string) => { done++; process.stdout.write(`  ✓ ${name}\n`); };

/** 一个干净的沙盘:`dir` 当配置目录,`host` 当假 HOME(宿主那份永远不许被碰)。 */
function bench(name: string): { dir: string; host: string } {
  const base = join(root, `${name}-${done}-${Math.random().toString(36).slice(2, 8)}`);
  const dir = join(base, "cfg");
  const host = join(base, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(host, { recursive: true });
  return { dir, host };
}

const ENTRY = join(REPO_DIR, "mcp", "dist", "index.js");
/**
 * **仓库里没 build 过 MCP 产物时,通用补接器按设计会拒写**(不登记一个不存在的入口)。
 * 所以这些用例一律在假 HOME 里先放一份宿主登记 —— 那本来也是隔离档最常走的路:
 * 把宿主那条搬过来。
 */
const hostJson = (host: string, agentType: AgentType, entry: Record<string, unknown> = {
  command: "node", args: ["/host/mcp/index.js"], env: { ASH_URL: "http://127.0.0.1:4317" },
}): string => {
  const mechanism = ASH_MCP_TABLE[agentType];
  assert.equal(mechanism.kind, "file");
  const dir = ashMcpConfigDir(agentType, {}, host)!;
  const file = ashMcpConfigFile(dir, (mechanism as { site: Parameters<typeof ashMcpConfigFile>[1] }).site);
  mkdirSync(dirname(file), { recursive: true });
  const container = mechanism.kind === "file" && mechanism.shape.id === "opencode-json" ? "mcp" : "mcpServers";
  const body = container === "mcp"
    ? { mcp: { ash: { type: "local", command: ["node", "/host/mcp/index.js"], environment: { ASH_URL: "http://127.0.0.1:4317" }, enabled: true } } }
    : { mcpServers: { ash: entry } };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
};

const hostToml = (host: string, agentType: AgentType, extra = ""): string => {
  const mechanism = ASH_MCP_TABLE[agentType];
  assert.equal(mechanism.kind, "file");
  const dir = ashMcpConfigDir(agentType, {}, host)!;
  const file = join(dir, "config.toml");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `[mcp_servers.ash]\ncommand = "node"\nargs = ["/host/mcp/index.js"]\n${extra}`, "utf8");
  return file;
};

/** 一条启用着的 ash 登记(TOML 族)。根级开关的用例要在它**前面**插自己那一行。 */
const TOML_ASH = '[mcp_servers.ash]\ncommand = "node"\nargs = ["/x.js"]\n';

/**
 * **只插入,没改没删**:新文本 = 原文的公共前缀 + 插进去那一段 + 原文的公共后缀。
 *
 * 这是「只改我们那一条」的通用判据,不依赖插在哪儿、插了什么形状(本轮审查 R4)。
 */
function onlyInserted(before: string, after: string): boolean {
  let head = 0;
  while (head < before.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return head + tail === before.length && after.length >= before.length;
}

const register = (agentType: string, dir: string, host: string) =>
  registerAshMcp({ agentType, dir, hostHome: host, env: {} });

const fileIn = (agentType: AgentType, dir: string) => {
  const mechanism = ASH_MCP_TABLE[agentType];
  assert.equal(mechanism.kind, "file");
  return ashMcpConfigFile(dir, (mechanism as { site: Parameters<typeof ashMcpConfigFile>[1] }).site);
};

try {
  // ── ① 表自己要交代清楚 ──────────────────────────────────────────────────
  {
    for (const type of AGENT_TYPES) {
      const mechanism = ASH_MCP_TABLE[type];
      assert.ok(mechanism, `${type}:表里必须有一条`);
      assert.ok(mechanism.source.trim(), `${type}:依据(source)不能空`);
      if (mechanism.evidence === "docs") {
        // 未实测的一律要写明坑在哪 —— 不然「按文档写的」跟「实测过的」在界面上长一个样。
        assert.ok((mechanism.kind === "none" ? "" : mechanism.notes ?? "").trim(),
          `${type}:evidence=docs 必须有 notes`);
      }
      if (mechanism.kind === "file") {
        assert.ok(mechanism.site.relative.length, `${type}:要说清配置文件落在哪`);
        assert.ok(["mcp-servers-json", "opencode-json", "mcp-servers-toml"].includes(mechanism.shape.id));
      }
      if (mechanism.kind === "manual") assert.ok(mechanism.howTo.trim(), `${type}:manual 必须给 howTo`);
      // 身份走不了变量的那两档,都必须当场说给用户听(预检会把 caveat 显示出来):
      // `blocked` = 交不了卷;`path` = 改走 PATH 上那份文件、而那条桥本机没实测过。
      if (mechanism.kind === "file" && (mechanism.identity === "blocked" || mechanism.identity === "path")) {
        assert.ok(mechanism.caveat?.trim(), `${type}:identity=${mechanism.identity} 必须配 caveat`);
        assert.ok(mechanism.identityNote?.trim(), `${type}:identity=${mechanism.identity} 必须说清是哪一条机制挡的`);
      }
    }
    // 真机实测过的那几家别悄悄退档成 docs(退了要在提交信息里说清为什么)。
    const tested = AGENT_TYPES.filter((t) => ASH_MCP_TABLE[t].evidence === "tested");
    assert.deepEqual([...tested].sort(), ["claude", "codex", "gemini", "grok", "kimi", "opencode"]);
    group("表完整、依据齐、实测档没缩水");
  }

  // ── ② 三个格式族各写一遍 ─────────────────────────────────────────────────
  {
    // `mcpServers` 族,而且配置在子层(`.gemini/settings.json`)—— 顺带钉住「父目录会建」。
    const g = bench("gemini");
    hostJson(g.host, "gemini");
    const r = await register("gemini", g.dir, g.host);
    assert.ok(r.ok && r.serverName === ASH_MCP_SERVER_NAME, "gemini:该写进去");
    const doc = JSON.parse(readFileSync(fileIn("gemini", g.dir), "utf8")) as
      { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    assert.deepEqual(doc.mcpServers.ash, {
      command: "node", args: ["/host/mcp/index.js"], env: { ASH_URL: "http://127.0.0.1:4317" },
    }, "gemini:宿主那条原样搬过来");
    assert.equal(ashMcpStateIn(g.dir, "gemini", {}).state, "present");

    // opencode 族:容器叫 `mcp`、argv 是数组、环境变量键叫 `environment`。
    const o = bench("opencode");
    hostJson(o.host, "opencode");
    assert.ok((await register("opencode", o.dir, o.host)).ok);
    const oc = JSON.parse(readFileSync(join(o.dir, "opencode.json"), "utf8")) as
      { mcp: Record<string, { type: string; command: string[]; environment: Record<string, string>; enabled: boolean }> };
    assert.equal(oc.mcp.ash.type, "local");
    assert.deepEqual(oc.mcp.ash.command, ["node", "/host/mcp/index.js"]);
    assert.equal(oc.mcp.ash.environment.ASH_URL, "http://127.0.0.1:4317");
    assert.equal(oc.mcp.ash.enabled, true);
    assert.equal(ashMcpStateIn(o.dir, "opencode", {}).state, "present");

    // TOML 族(grok):整段原文照搬,连子表一起。
    const k = bench("grok");
    hostToml(k.host, "grok", '\n[mcp_servers.ash.env]\nASH_URL = "http://127.0.0.1:4317"\n\n[mcp_servers.ash.tools.get_task]\napproval_mode = "approve"\n');
    assert.ok((await register("grok", k.dir, k.host)).ok);
    const toml = readFileSync(join(k.dir, "config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers\.ash\]/);
    assert.match(toml, /\[mcp_servers\.ash\.tools\.get_task\]/, "TOML:子表不许丢");
    assert.equal(ashMcpStateIn(k.dir, "grok", {}).state, "present");

    // 搬宿主那条是**原值照搬**,所以不会凭空多出一个 type(本轮审查 R5)。
    const c = bench("cursor-host");
    hostJson(c.host, "cursor");
    assert.ok((await register("cursor", c.dir, c.host)).ok);
    const cur = JSON.parse(readFileSync(join(c.dir, "mcp.json"), "utf8")) as
      { mcpServers: Record<string, Record<string, unknown>> };
    assert.equal(cur.mcpServers.ash!.type, undefined, "搬宿主那条:原值照搬,不加字段");
    assert.equal(doc.mcpServers.ash!.type, undefined, "gemini:没人要求就不塞 type");
    group("三个格式族 + 子层目录 + 子表/原值都写对");
  }

  // ── ②' 宿主没登记时自己渲染那条:`type` 按表里的字面值写 ───────────────────
  {
    // 没得可搬才走 `builtinEntry()`,它要求仓库里 build 过 MCP 产物。
    if (existsSync(ENTRY)) {
      for (const [type, expect] of [["cursor", "stdio"], ["copilot", "local"], ["kimi", undefined]] as const) {
        const b = bench(`type-${type}`);
        assert.ok((await register(type, b.dir, b.host)).ok, `${type}:该写进去`);
        const doc = JSON.parse(readFileSync(fileIn(type as AgentType, b.dir), "utf8")) as
          { mcpServers: Record<string, Record<string, unknown>> };
        // copilot 的本地服务在文件里叫 `local`、cursor 叫 `stdio` —— 值不许互相套用。
        assert.equal(doc.mcpServers.ash!.type, expect, `${type}:type 得是 ${expect ?? "不写"}`);
        assert.deepEqual(doc.mcpServers.ash!.args, [ENTRY], `${type}:登记的是本仓那个入口`);
      }
      group("自己现渲染那条:type 按各家文档的字面值写");
    } else {
      group("(跳过)没 build 过 mcp/dist/index.js，自己渲染那条测不了");
    }
  }

  // ── ③ 幂等:第二遍一个字节都不动 ──────────────────────────────────────────
  {
    const b = bench("idem");
    hostJson(b.host, "kimi");
    assert.ok((await register("kimi", b.dir, b.host)).ok);
    const file = fileIn("kimi", b.dir);
    const first = readFileSync(file, "utf8");
    const ino = Number(statSync(file).ino);
    const again = await register("kimi", b.dir, b.host);
    assert.ok(again.ok && again.serverName === ASH_MCP_SERVER_NAME);
    assert.equal(readFileSync(file, "utf8"), first, "第二遍不改内容");
    if (ino !== 0) assert.equal(Number(statSync(file).ino), ino, "也不换文件");
    // **新建的那一份只给自己读**:它装着 MCP 接法。裸 Node 那份(安装器)同口径,
    // 两边都由回归钉着 —— 一边退成 umask 另一边没退,正是这种事上一轮漏掉的。
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600, "ash 新建的配置文件只给本人读");
    }
    group("幂等:补过了就只是读;新建那份权限 0600");
  }

  // ── ④ 已有登记一律不覆盖,第三方条目一个字节不动 ───────────────────────────
  {
    for (const name of ["ash", "harness"]) {
      const b = bench(`keep-${name}`);
      const file = fileIn("qwen", b.dir);
      mkdirSync(dirname(file), { recursive: true });
      const mine = `${JSON.stringify({
        mcpServers: {
          [name]: { command: "my-node", args: ["/my/entry.js"], env: { ASH_URL: "http://127.0.0.1:9999" } },
          other: { command: "third-party" },
        },
      }, null, 2)}\n`;
      writeFileSync(file, mine, "utf8");
      const r = await register("qwen", b.dir, b.host);
      assert.ok(r.ok, `${name}:已有就算接好了`);
      assert.equal(r.ok && r.serverName, name, `${name}:报的是实际那个名字`);
      assert.equal(readFileSync(file, "utf8"), mine, `${name}:一个字节都不许动`);
    }
    // 没有 ash、但有别人的 server:补一条进去,别人的原样留着。
    const b = bench("keep-third-party");
    hostJson(b.host, "qoder");
    const file = fileIn("qoder", b.dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ extra: true, mcpServers: { other: { command: "third-party" } } }, null, 2)}\n`, "utf8");
    assert.ok((await register("qoder", b.dir, b.host)).ok);
    const doc = JSON.parse(readFileSync(file, "utf8")) as
      { extra: boolean; mcpServers: Record<string, unknown> };
    assert.equal(doc.extra, true, "别的顶层键留着");
    assert.deepEqual(doc.mcpServers.other, { command: "third-party" }, "别人的 server 留着");
    assert.ok(doc.mcpServers.ash, "自己那条补上了");
    group("不覆盖已有(含 harness)、不碰第三方条目");
  }

  // ── ⑤ 关着的不替他打开 ──────────────────────────────────────────────────
  {
    const b = bench("disabled-json");
    const file = fileIn("copilot", b.dir);
    mkdirSync(dirname(file), { recursive: true });
    const off = `${JSON.stringify({ mcpServers: { ash: { command: "node", args: ["/x.js"], disabled: true } } }, null, 2)}\n`;
    writeFileSync(file, off, "utf8");
    const r = await register("copilot", b.dir, b.host);
    assert.ok(!r.ok && /没有替你打开/.test(r.why), `关着的要如实说:${r.ok ? "" : r.why}`);
    assert.equal(readFileSync(file, "utf8"), off, "关着的也不动它");
    assert.equal(ashMcpStateIn(b.dir, "copilot", {}).state, "disabled");

    // grok 的两种关法都要认出来,而且说清是哪一种(用户照着去改的就是那一行)。
    // 根级那个开关**必须写在所有表头之前** —— TOML 里写在表头之后就属于那张表,不是根级事实。
    for (const [body, expect] of [
      [`${TOML_ASH}enabled = false\n`, /enabled = false/],
      [`disabled_mcp_servers = ["ash"]\n\n${TOML_ASH}`, /disabled_mcp_servers/],
      // 多行写法也要读得出来(上一版那条单行正则漏读它 ⇒ 当成「开着」)。
      [`disabled_mcp_servers = [\n  "ash",\n]\n\n${TOML_ASH}`, /disabled_mcp_servers/],
    ] as const) {
      const g = bench("disabled-toml");
      writeFileSync(join(g.dir, "config.toml"), body, "utf8");
      const gr = await register("grok", g.dir, g.host);
      assert.ok(!gr.ok && expect.test(gr.why), `TOML 关法要说清:${gr.ok ? "" : gr.why}`);
    }
    group("关着的登记:不打开、说清哪一行");
  }

  // ── ⑤' 根级开关的作用域(本轮审查 R7)──────────────────────────────────────
  {
    // 判据必须认得表作用域和多行字符串:上一版拿全文正则扫,下面这两份都会把一条**启用着**的
    // ash 判成「已关闭」,而 disabled 在派审预检里是硬拒。
    const multiline = [
      `${TOML_ASH}`,
      '[mcp_servers.other]',
      'command = "x"',
      '',
      '[mcp_servers.other.env]',
      'NOTE = """',
      'disabled_mcp_servers = ["ash"]',
      '"""',
      '',
    ].join("\n");
    const fakes = [
      // ① 别人的 env 里有个三引号多行字符串,里面恰好有这么一行
      multiline,
      // ② 同一行写在表头**之后** ⇒ 它是那张表的字段,不是根级开关
      `${TOML_ASH}disabled_mcp_servers = ["ash"]\n`,
    ];
    for (const body of fakes) {
      const g = bench("root-scope");
      writeFileSync(join(g.dir, "config.toml"), body, "utf8");
      const state = ashMcpStateIn(g.dir, "grok", {});
      assert.equal(state.state, "present", `不许把文本当成根级事实:${state.detail}`);
    }
    group("TOML 根级开关:只认根级、不认字符串里的同名行");
  }

  // ── ⑥ 改写是**文本插入**:除了插进去那一条,其余字节原样(本轮审查 R4) ────────
  {
    // 带注释的 `.jsonc`:现在能自动补接了 —— 注释、缩进、键序一个字都不动,也不另建一份。
    // (上一版走 `JSON.parse` → `JSON.stringify` 往返,只能靠「有注释就不改写」躲开。)
    const b = bench("jsonc");
    const file = join(b.dir, "opencode.jsonc");
    const commented = '{\n  // 这是我自己写的注释\n  "$schema": "https://opencode.ai/config.json"\n}\n';
    writeFileSync(file, commented, "utf8");
    hostJson(b.host, "opencode");
    const r = await register("opencode", b.dir, b.host);
    assert.ok(r.ok, `带注释也该补上:${r.ok ? "" : r.why}`);
    const after = readFileSync(file, "utf8");
    assert.match(after, /\/\/ 这是我自己写的注释/, "注释一个字都不许丢");
    assert.match(after, /"\$schema": "https:\/\/opencode\.ai\/config\.json"/, "原有键原样");
    assert.ok(!existsSync(join(b.dir, "opencode.json")), "也不许在旁边另建一份 .json");

    assert.ok(onlyInserted(commented, after), `插入点之外一个字节都不许动：\n${after}`);

    // 超出 JS 安全整数的原值:往返会写成另一个数字,文本插入不会。
    const n = bench("lossless");
    const nf = join(n.dir, "opencode.json");
    const precise = '{\n  "bigId": 9007199254740993,\n  "huge": 1e999,\n  "negZero": -0\n}\n';
    writeFileSync(nf, precise, "utf8");
    hostJson(n.host, "opencode");
    const r2 = await register("opencode", n.dir, n.host);
    assert.ok(r2.ok, `该补上:${r2.ok ? "" : r2.why}`);
    const doc = readFileSync(nf, "utf8");
    assert.match(doc, /9007199254740993/, "大整数原值不许被改成 …992");
    assert.match(doc, /1e999/, "`1e999` 不许变成 null");
    assert.match(doc, /-0/, "`-0` 不许变成 0");
    assert.ok(onlyInserted(precise, doc), `除了插进去那一段,原文一个字节都不许动：\n${doc}`);
    group("改写是文本插入:注释/大整数/键序全原样,只多出 ash 那一条");
  }

  // ── ⑦ 就地写:软链还是软链 ───────────────────────────────────────────────
  {
    const b = bench("symlink");
    const real = join(b.dir, "real-settings.json");
    writeFileSync(real, `${JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2)}\n`, "utf8");
    const link = fileIn("kiro", b.dir);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link);
    const ino = Number(statSync(real).ino);
    hostJson(b.host, "kiro");
    assert.ok((await register("kiro", b.dir, b.host)).ok);
    assert.ok(lstatSync(link).isSymbolicLink(), "软链还得是软链");
    if (ino !== 0) assert.equal(Number(statSync(real).ino), ino, "写的是它指的那份,inode 不换");
    assert.ok((JSON.parse(readFileSync(real, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.ash);
    group("就地写:软链不被换成普通文件");
  }

  // ── ⑧ 隔离档那条路(`ensureAshMcp`)对新家也成立 ──────────────────────────
  {
    const b = bench("isolated");
    hostJson(b.host, "gemini");
    const state = await ensureAshMcp(b.dir, "gemini", b.host);
    assert.equal(state.configured, true, state.problem ?? "");
    assert.equal(state.serverName, ASH_MCP_SERVER_NAME);
    assert.ok(existsSync(fileIn("gemini", b.dir)), "个人目录里真写出来了");
    group("隔离档起跑补齐:十三家也走同一条路");
  }

  // ── ⑨ 能力分档:现在十五家全都能自动写,两档措辞仍要分得开 ─────────────────
  {
    assert.deepEqual(
      AGENT_TYPES.filter((t) => !canRegisterAshMcp(t)),
      [],
      "十五家都该能自动登记 ash MCP(新增一家不能写的,要在这里登记并说明为什么)",
    );
    // 所以两档措辞只能拿合成的机制驱动(表里暂时没有 none / manual 这两档)。
    const none = ashMcpUnsupported("fakecli", {
      kind: "none", why: "它压根没有 MCP", evidence: "tested", source: "实测",
    });
    assert.equal(none?.tier, "refuse");
    assert.match(none!.why, /上报不了结论/);
    const manual = ashMcpUnsupported("fakecli", {
      kind: "manual", howTo: "自己往 x.yaml 里加一条", evidence: "docs", source: "文档",
    });
    assert.equal(manual?.tier, "hint", "有 MCP、只是我们不写 ⇒ 不许拦");
    assert.equal(ashMcpUnsupported("gemini", ASH_MCP_TABLE.gemini), null, "能写的归常规判据管");
    group("能力分档:十五家全能写,none 拦得住、manual 只提示");
  }

  // ── ⑨' trae:写标准 JSON;同目录有它那份 YAML 时一个字都不写 ────────────────
  {
    const b = bench("trae");
    hostJson(b.host, "trae");
    assert.ok((await register("trae", b.dir, b.host)).ok, "trae:该写进 ~/.trae/mcp.json");
    assert.equal(join(b.dir, "mcp.json"), fileIn("trae", b.dir));
    assert.equal(ashMcpStateIn(b.dir, "trae", {}).state, "present");

    // 它的原生 YAML 我们读不了 —— 存在就不许写,也不许据此说「没有」。
    const y = bench("trae-yaml");
    hostJson(y.host, "trae");
    writeFileSync(join(y.dir, "traecli.yaml"), "mcp_servers:\n  - name: ash\n    type: stdio\n", "utf8");
    const r = await register("trae", y.dir, y.host);
    assert.ok(!r.ok && /traecli\.yaml/.test(r.why), `有那份 YAML 就不写:${r.ok ? "" : r.why}`);
    assert.ok(!existsSync(join(y.dir, "mcp.json")), "也不许另建一份 mcp.json");
    assert.equal(ashMcpStateIn(y.dir, "trae", {}).state, "unknown", "读不了它的格式 ⇒ 不下结论");
    group("trae:写标准 JSON、撞上原生 YAML 就不写也不下结论");
  }

  // ── ⑩ 搬宿主那条:**原值照搬**,远程/额外字段都不许丢(本轮审查 R5)──────────
  {
    // 上一版把宿主那条投影成 `{command,args,env}`:远程登记变成「连本机 4317 的 stdio」、
    // `cwd`/`timeout` 静默消失,而函数照样报「已接好」—— 这是审查在沙盘里实测到的。
    const http = bench("host-http");
    const headers = { Authorization: "Bearer abc" };
    hostJson(http.host, "claude", { type: "http", url: "https://ash.example.com/mcp", headers });
    assert.ok((await register("claude", http.dir, http.host)).ok);
    const moved = (JSON.parse(readFileSync(fileIn("claude", http.dir), "utf8")) as
      { mcpServers: Record<string, Record<string, unknown>> }).mcpServers.ash!;
    assert.deepEqual(moved, { type: "http", url: "https://ash.example.com/mcp", headers },
      "远程那条要原样搬过去(不许退回内置 stdio)");

    const extra = bench("host-extra");
    hostJson(extra.host, "claude", {
      type: "stdio", command: "./node", args: ["entry.js"], env: { ASH_URL: "http://127.0.0.1:4317" },
      cwd: "/host/repo", timeout: 30_000,
    });
    assert.ok((await register("claude", extra.dir, extra.host)).ok);
    const kept = (JSON.parse(readFileSync(fileIn("claude", extra.dir), "utf8")) as
      { mcpServers: Record<string, Record<string, unknown>> }).mcpServers.ash!;
    assert.equal(kept.cwd, "/host/repo", "cwd 不许丢");
    assert.equal(kept.timeout, 30_000, "timeout 不许丢");

    // 宿主那条是**关着**的:不搬(搬过去等于把「已关闭」一起搬到个人档)。
    const off = bench("host-off");
    hostJson(off.host, "kimi", { command: "node", args: ["/host/x.js"], disabled: true });
    const r = await register("kimi", off.dir, off.host);
    if (existsSync(ENTRY)) {
      assert.ok(r.ok, r.ok ? "" : r.why);
      const built = (JSON.parse(readFileSync(fileIn("kimi", off.dir), "utf8")) as
        { mcpServers: Record<string, Record<string, unknown>> }).mcpServers.ash!;
      assert.equal(built.disabled, undefined, "关着的那条不许搬过来");
      assert.deepEqual(built.args, [ENTRY], "改用本仓那个入口");
    } else {
      assert.ok(!r.ok, "没 build 过产物、宿主那条又关着 ⇒ 如实说没得可搬");
    }
    group("搬宿主那条:原值照搬、关着的不搬");
  }

  // ── ⑪ 两个兼容名同时在:先认开着的那条(本轮审查 R8)────────────────────────
  {
    const b = bench("live-legacy");
    const file = fileIn("antigravity", b.dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      mcpServers: {
        ash: { command: "node", args: ["/old.js"], disabled: true },
        harness: { command: "node", args: ["/live.js"] },
      },
    }, null, 2)}\n`, "utf8");
    const state = ashMcpStateIn(b.dir, "antigravity", {});
    assert.equal(state.state, "present", `有一个开着就是接好了:${state.detail}`);
    assert.equal(state.serverName, "harness", "报的是实际开着的那个名字");
    const r = await register("antigravity", b.dir, b.host);
    assert.ok(r.ok && r.serverName === "harness", "补接也认它,别去打开那条关着的");

    // 两个都关着 ⇒ 才是 disabled,而且两个名字都要说出来。
    const both = bench("both-off");
    const bf = fileIn("antigravity", both.dir);
    mkdirSync(dirname(bf), { recursive: true });
    writeFileSync(bf, `${JSON.stringify({
      mcpServers: { ash: { command: "a", disabled: true }, harness: { command: "b", enabled: false } },
    }, null, 2)}\n`, "utf8");
    const offState = ashMcpStateIn(both.dir, "antigravity", {});
    assert.equal(offState.state, "disabled");
    assert.match(offState.detail, /ash 这条登记是关着的、harness 这条登记是关着的/,
      "两个名字各自说一遍 —— 逐名扫描之后每条登记自带一句话(本轮审查 F3)");
    // 诊断提示也得指到**活着**那一条:上一版 `launch` 按名字取第一条,于是这里拿的是
    // `ash` 那条关着的 `/old.js` —— 用户照着提示去查一个根本没在跑的命令,而状态明明是
    // present(本轮审查不拦项:`shapes.ts` 的 launch 与 read 不同源)。
    const json = ASH_MCP_TABLE.antigravity;
    assert.equal(json.kind, "file");
    if (json.kind === "file") {
      const live = json.shape.launch?.(readFileSync(file, "utf8"));
      assert.deepEqual(live?.args, ["/live.js"], "提示要指到开着那条");
    }
    const toml = ASH_MCP_TABLE.grok;
    assert.equal(toml.kind, "file");
    if (toml.kind === "file") {
      // TOML 的两种关法,`read` 两种都看,launch 也必须 —— 根级那种是上一版漏掉的。
      const rootOff = 'disabled_mcp_servers = ["ash"]\n\n[mcp_servers.ash]\ncommand = "node"\nargs = ["/off.js"]\n';
      assert.equal(toml.shape.launch?.(rootOff) ?? null, null, "根级关掉的那条不该拿去当提示");
      const live = toml.shape.launch?.('[mcp_servers.ash]\ncommand = "node"\nargs = ["/live.js"]\n');
      assert.deepEqual(live?.args, ["/live.js"], "开着的照常给提示");
    }
    group("兼容名:有一个开着就算接好,都关着才说关着;诊断提示也指到活着那条");
  }

  // ── ⑫ 值不是对象:说认不出来,别覆盖(本轮审查不拦项 2)─────────────────────
  {
    for (const value of [null, "node /x.js", 42] as const) {
      const b = bench("weird-value");
      const file = fileIn("pi", b.dir);
      mkdirSync(dirname(file), { recursive: true });
      const mine = `${JSON.stringify({ mcpServers: { ash: value } }, null, 2)}\n`;
      writeFileSync(file, mine, "utf8");
      const state = ashMcpStateIn(b.dir, "pi", {});
      assert.equal(state.state, "unknown", `${JSON.stringify(value)}:认不出来就说认不出来`);
      const r = await register("pi", b.dir, b.host);
      assert.ok(!r.ok, "认不出来就不写");
      assert.equal(readFileSync(file, "utf8"), mine, "一个字节都不许动");
    }
    group("ash 那个键的值认不出来:不下结论、不覆盖");
  }

  // ── ⑬ 覆盖变量的层级契约(本轮审查 R3)+ 指到文件的那几家(R4)───────────────
  {
    // 这张表是**跟各家 CLI 的契约**,两份实现「互相一致」证明不了它 —— qwen 那条就是这么
    // 错的(QWEN_HOME 已经是最终配置目录,上一版又在它底下接了一层 `.qwen`)。
    const contract: Partial<Record<AgentType, string>> = {
      claude: "/profile/.claude.json",
      codex: "/profile/config.toml",
      gemini: "/profile/.gemini/settings.json",       // GEMINI_CLI_HOME 是 home 基准(实测)
      grok: "/profile/config.toml",
      kimi: "/profile/mcp.json",
      qwen: "/profile/settings.json",                 // QWEN_HOME 是最终配置目录
      copilot: "/profile/mcp-config.json",
      pi: "/profile/mcp.json",
    };
    for (const [type, expect] of Object.entries(contract) as [AgentType, string][]) {
      const mechanism = ASH_MCP_TABLE[type];
      assert.equal(mechanism.kind, "file");
      if (mechanism.kind !== "file") continue;
      const env = { [mechanism.site.dirEnv!]: "/profile" } as NodeJS.ProcessEnv;
      assert.equal(ashMcpHostFile(type, env, "/h"), expect, `${type}:覆盖变量指到的那一层`);
    }
    // `dirEnvIsFile` 的那两家:**写、判、提示必须是同一个路径**(上一版三处消费者各自把
    // 文件名丢掉再按默认名拼回来,于是真 CLI 连得上、派审却报没接好)。
    const b = bench("config-is-file");
    const custom = join(b.dir, "my-profile.json");
    // `XDG_CONFIG_HOME` 也给上:判定那一问内部用的是真 `homedir()`,不给就会去看这台机器上
    // 真实的 `~/.config/opencode`(来源集合里的全局那份)。
    const env = { OPENCODE_CONFIG: custom, XDG_CONFIG_HOME: join(b.host, ".config") } as NodeJS.ProcessEnv;
    assert.equal(ashMcpHostFile("opencode", env, b.host), custom, "解析口认那个文件名");
    const dirOf = (home: string, e: NodeJS.ProcessEnv) => ashMcpConfigDir("opencode", e, home)!;

    // 全局那份**也有 ash** 时:`OPENCODE_CONFIG` 是「再加一份」而不是「取代」,所以这家
    // 已经接好了 —— 不许再往更高优先级那份补一条(那会把本来连得上的那条顶掉,本轮审查 R3)。
    const globalFile = hostJson(b.host, "opencode");
    const globalBefore = readFileSync(globalFile, "utf8");
    const merged = await registerAshMcp({ agentType: "opencode", dir: dirOf(b.host, env), hostHome: b.host, env });
    assert.ok(merged.ok, merged.ok ? "" : merged.why);
    assert.equal(existsSync(custom), false, "全局那份已经有了,就不该再写变量那份");
    assert.equal(readFileSync(globalFile, "utf8"), globalBefore, "全局那份也一个字节都不许动");
    assert.equal(fileAshMcpVerdict("opencode", env, [undefined]).state, "present",
      "判定也得看全来源:全局有 ash 就是接好了,不许说 absent（absent 在预检里是硬拒）");

    // 全局那份**没有** ash 时:写的、判的、提示的都得是变量指的那一份。
    const c = bench("config-is-file-empty");
    const target = join(c.dir, "my-profile.json");
    const env2 = { OPENCODE_CONFIG: target, XDG_CONFIG_HOME: join(c.host, ".config") } as NodeJS.ProcessEnv;
    const emptyGlobal = join(c.host, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(emptyGlobal), { recursive: true });
    writeFileSync(emptyGlobal, '{\n  "$schema": "x"\n}\n', "utf8");
    assert.equal(fileAshMcpVerdict("opencode", env2, [undefined]).state, "absent",
      "两份都确认没有,才配得上 absent");
    if (existsSync(ENTRY)) {           // 没 build 过 MCP 产物时通用补接器按设计拒写
      const r2 = await registerAshMcp({ agentType: "opencode", dir: dirOf(c.host, env2), hostHome: c.host, env: env2 });
      assert.ok(r2.ok, r2.ok ? "" : r2.why);
      assert.ok(existsSync(target), "写的就是变量指的那个文件");
      assert.equal(fileAshMcpVerdict("opencode", env2, [undefined]).state, "present", "判的也是它");
    }
    group("覆盖变量的层级契约 + 指到文件的那家:来源看全、落点只有一个解析口");
  }

  // ── ⑭ 宿主那份配置全程不许被碰 ──────────────────────────────────────────
  {
    const b = bench("host-untouched");
    const file = hostJson(b.host, "antigravity");
    const before = readFileSync(file, "utf8");
    assert.ok((await register("antigravity", b.dir, b.host)).ok);
    assert.equal(readFileSync(file, "utf8"), before, "宿主那份一个字节都不许动");
    group("宿主配置只读不写");
  }

  // ── ⑯⑰ 来源模型 + 服务端那条路的备份(在 `mcp-sources-cases.ts`)──────────────
  await checkSourceModel(bench, group, existsSync(ENTRY));

  // ── ⑮ README 那张给人读的矩阵不许和代码漂 ────────────────────────────────
  {
    const readme = readFileSync(join(REPO_DIR, "server", "src", "executors", "catalog", "README.md"), "utf8");
    const rows = readme.split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("|---") && !l.includes("执行器 |"))
      .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
      .filter((cells) => cells.length === 7 && AGENT_TYPES.includes(cells[0]!.replace(/\*/g, "") as AgentType));
    assert.deepEqual(
      rows.map((c) => c[0]).sort(),
      [...AGENT_TYPES].sort(),
      "矩阵里每个执行器一行(新加执行器时这里会红 —— 代码那张表同时也编译不过)",
    );
    for (const cells of rows) {
      const type = cells[0] as AgentType;
      const mechanism = ASH_MCP_TABLE[type];
      const auto = cells[1]!.replace(/\*/g, "");
      assert.equal(auto, canRegisterAshMcp(type) ? "是" : "否", `${type}:「ash 自动写」那一列对不上`);
      const tier = cells[6]!;
      // 「未实测」里也含「实测」两个字,所以先判否,顺序不能换。
      const claimsTested = !tier.includes("未实测");
      assert.equal(claimsTested, mechanism.evidence === "tested", `${type}:档位对不上(${tier})`);
      if (mechanism.kind === "file" && mechanism.site.dirEnv) {
        assert.ok(cells[3]!.includes(mechanism.site.dirEnv), `${type}:配置目录变量那一列要写明 ${mechanism.site.dirEnv}`);
      }
    }
    group("README 矩阵与代码逐行对齐");
  }

  console.log(`✅ ash MCP 登记表 + 通用补接器:${done} 组全过`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
