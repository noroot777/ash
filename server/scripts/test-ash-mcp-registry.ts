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
import { ASH_MCP_TABLE, ashMcpConfigDir, canRegisterAshMcp } from "../src/mcp-registry/catalog.js";
import { ashMcpConfigFile, ashMcpStateIn, ashMcpUnsupported, registerAshMcp } from "../src/mcp-registry/register.js";
import { REPO_DIR } from "../src/paths.js";

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

    // `type: "stdio"` 只给要它的那几家写(cursor 文档说必填)。
    const c = bench("cursor");
    hostJson(c.host, "cursor");
    assert.ok((await register("cursor", c.dir, c.host)).ok);
    const cur = JSON.parse(readFileSync(join(c.dir, "mcp.json"), "utf8")) as
      { mcpServers: Record<string, Record<string, unknown>> };
    assert.equal(cur.mcpServers.ash!.type, "stdio", "cursor:type 必填");
    assert.equal(doc.mcpServers.ash!.type, undefined, "gemini:没人要求就不塞 type");
    group("三个格式族 + 子层目录 + type/子表都写对");
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
    group("幂等:补过了就只是读");
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
    for (const [extra, expect] of [["enabled = false\n", /enabled = false/], ['\ndisabled_mcp_servers = ["ash"]\n', /disabled_mcp_servers/]] as const) {
      const g = bench("disabled-toml");
      const gf = join(g.dir, "config.toml");
      writeFileSync(gf, `[mcp_servers.ash]\ncommand = "node"\nargs = ["/x.js"]\n${extra}`, "utf8");
      const gr = await register("grok", g.dir, g.host);
      assert.ok(!gr.ok && expect.test(gr.why), `TOML 关法要说清:${gr.ok ? "" : gr.why}`);
    }
    group("关着的登记:不打开、说清哪一行");
  }

  // ── ⑥ 有注释的 JSON 不自动改写 ─────────────────────────────────────────
  {
    const b = bench("jsonc");
    const file = join(b.dir, "opencode.jsonc");
    const commented = '{\n  // 这是我自己写的注释\n  "$schema": "https://opencode.ai/config.json"\n}\n';
    writeFileSync(file, commented, "utf8");
    hostJson(b.host, "opencode");
    const r = await register("opencode", b.dir, b.host);
    assert.ok(!r.ok && /注释/.test(r.why), `有注释要如实说:${r.ok ? "" : r.why}`);
    assert.equal(readFileSync(file, "utf8"), commented, "注释一个字都不许丢");
    assert.ok(!existsSync(join(b.dir, "opencode.json")), "也不许在旁边另建一份 .json");
    group("有注释的配置:不改写、不另建一份");
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

  // ── ⑨ 不支持的那两档:拦/提示分得开 ────────────────────────────────────
  {
    const b = bench("trae");
    const r = await register("trae", b.dir, b.host);
    assert.ok(!r.ok && /不自动写/.test(r.why) && /trae_cli\.yaml/.test(r.why), `manual 要给办法:${r.ok ? "" : r.why}`);
    assert.deepEqual(
      [...new Set(AGENT_TYPES.filter((t) => !canRegisterAshMcp(t)))],
      ["trae"],
      "现在只有 trae 不自动写;再多一家要在这里登记并说明",
    );
    // 两档的措辞只有一份,所以拿合成的机制驱动它(表里暂时没有 none 这一档)。
    const none = ashMcpUnsupported("fakecli", {
      kind: "none", why: "它压根没有 MCP", evidence: "tested", source: "实测",
    });
    assert.equal(none?.tier, "refuse");
    assert.match(none!.why, /上报不了结论/);
    const manual = ashMcpUnsupported("trae", ASH_MCP_TABLE.trae);
    assert.equal(manual?.tier, "hint", "有 MCP、只是我们不写 ⇒ 不许拦");
    assert.equal(ashMcpUnsupported("gemini", ASH_MCP_TABLE.gemini), null, "能写的归常规判据管");
    group("none 拦得住、manual 只提示");
  }

  // ── ⑩ 两份实现不许漂(TS 表 ↔ 裸 Node 那份)────────────────────────────
  {
    const hosts = await import(pathToFileURL(join(REPO_DIR, "scripts", "mcp-hosts.mjs")).href) as {
      HOST_SITES: Record<string, {
        bins: string[]; dirEnv: string | null; dirEnvIsFile?: boolean;
        relative: string[]; alternates?: string[][]; shape: string; type?: boolean; enabled?: boolean;
        dir: (env: NodeJS.ProcessEnv, home: string) => string;
      }>;
      hostMcpFile: (agentType: string, opts: { env: NodeJS.ProcessEnv; home: string }) => string | null;
    };
    const SHAPE_ID: Record<string, string> = {
      mcpServers: "mcp-servers-json", opencode: "opencode-json", toml: "mcp-servers-toml",
    };
    // claude 走它自己的 `mcp add`,codex 走 codex-mcp.mjs(发布前要 codex 本人点头),
    // trae 不自动写 —— 其余每一家都必须在裸 Node 那份表里有落点。
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
      assert.deepEqual(
        (site.alternates ?? []).map((a) => [...a]),
        (mechanism.site.alternates ?? []).map((a) => [...a]),
        `${type}:备选文件名要对上`,
      );
      assert.equal(!!site.type, !!mechanism.writeType, `${type}:要不要写 type 得一致`);
      assert.equal(!!site.enabled, !!mechanism.writeEnabled, `${type}:要不要写 enabled 得一致`);
      // 默认目录也要算出同一个路径(QODER_CONFIG_DIR_NAME / XDG 这些分支都在里面)。
      for (const env of [{}, { XDG_CONFIG_HOME: "/xdg" }, { QODER_CONFIG_DIR_NAME: ".qq" }] as NodeJS.ProcessEnv[]) {
        assert.equal(
          hosts.hostMcpFile(type, { env, home: "/h" }),
          ashMcpConfigFile(ashMcpConfigDir(type, env, "/h")!, mechanism.site),
          `${type}:默认路径要算出同一个(env=${JSON.stringify(env)})`,
        );
      }
      // 命令名也不许漂:裸 Node 那边靠它判「这台机器装没装」。
      for (const bin of site.bins) {
        assert.ok(cliSpec(type as AgentType).bins.includes(bin), `${type}:${bin} 不在执行器目录的 bins 里`);
      }
    }
    group("TS 表与裸 Node 那份逐项对齐");
  }

  // ── ⑪ 宿主那份配置全程不许被碰 ──────────────────────────────────────────
  {
    const b = bench("host-untouched");
    const file = hostJson(b.host, "antigravity");
    const before = readFileSync(file, "utf8");
    assert.ok((await register("antigravity", b.dir, b.host)).ok);
    assert.equal(readFileSync(file, "utf8"), before, "宿主那份一个字节都不许动");
    group("宿主配置只读不写");
  }

  // ── ⑫ README 那张给人读的矩阵不许和代码漂 ────────────────────────────────
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
