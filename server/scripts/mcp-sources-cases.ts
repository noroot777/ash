// 服务端那条补接链的两组用例:**来源完整性 + 顺序 + 最终条目**(本轮审查 F4),以及
// **改写已有配置前那份核对过的备份**(F2 的可修部分)。
//
// 为什么单独一个文件:`test-ash-mcp-registry.ts` 已经 600 多行,而这两组各自要搭好几份
// 来源的沙盘。由那个文件调用,不是独立的回归入口。
//
// F4 的判据全是 2026-10-31 用真 `opencode` 逐格实测的(八格记在 `catalog.ts` 那家的
// `source` 里),这里只钉「ash 的判定和写入跟实测结果一致」:
//  · 默认目录里 `.json` 和 `.jsonc` 两份都读;
//  · `OPENCODE_CONFIG_DIR` 再加一个目录、优先级高于默认目录;
//  · `OPENCODE_CONFIG` 指的那个文件优先级更高;
//  · `OPENCODE_CONFIG_CONTENT` 里那整段 JSON 最高,而且**没有文件可写**;
//  · 它们是「合起来看、高优先级那份赢」—— 高的那份只写 `{"enabled": false}` 也会把低的
//    那条完整登记关掉。
import assert from "node:assert/strict";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { BACKUP_SUFFIX } from "../src/auth/config-publish.js";
import { fileAshMcpVerdict } from "../src/ash-mcp-file.js";
import { howToCheck } from "../src/ash-mcp-reachability.js";
import {
  ashMcpHostFile, ashMcpHostSources, effectiveConfigState, registerAshMcp, resolveAshMcp,
} from "../src/mcp-registry/register.js";
import { ASH_MCP_TABLE, ashMcpConfigDir } from "../src/mcp-registry/catalog.js";

const OC_ENTRY = {
  type: "local", command: ["node", "/host/mcp/index.js"],
  environment: { ASH_URL: "http://127.0.0.1:4317" }, enabled: true,
};
const ocBody = (mcp: Record<string, unknown>) => `${JSON.stringify({ $schema: "x", mcp }, null, 2)}\n`;
const EMPTY = ocBody({});
const WITH_ASH = ocBody({ ash: OC_ENTRY });
const ASH_OFF = ocBody({ ash: { enabled: false } });
const HARNESS_ON = ocBody({ harness: OC_ENTRY });

const shapeOf = (agentType: string) => {
  const mechanism = ASH_MCP_TABLE[agentType as keyof typeof ASH_MCP_TABLE];
  assert.equal(mechanism.kind, "file");
  if (mechanism.kind !== "file") throw new Error("unreachable");
  return mechanism;
};

/** 在假 HOME 里摆一份 opencode 配置(默认目录那一层)。 */
function seedGlobal(host: string, body: string, name = "opencode.json"): string {
  const file = join(host, ".config", "opencode", name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
  return file;
}

const ocEnv = (host: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  ({ XDG_CONFIG_HOME: join(host, ".config"), ...extra });

export async function checkSourceModel(
  bench: (name: string) => { dir: string; host: string },
  group: (name: string) => void,
  entryBuilt: boolean,
): Promise<void> {
  // ── ⑯ 来源完整性 + 顺序 + 最终条目(本轮审查 F4)────────────────────────────
  {
    const { shape, site } = shapeOf("opencode");

    // ⒜ 默认目录里两份都读:ash 在 `.json`、`.jsonc` 不含 MCP ⇒ 真 CLI 报 connected。
    //    上一版「找到第一个 alternate 就只认它」只看 `.jsonc`,判成 absent(预检硬拒),
    //    补接还往 `.jsonc` 里再写一条、把本来生效那条顶掉。
    const a = bench("sources-two-files");
    const aJson = seedGlobal(a.host, WITH_ASH);
    const aJsonc = seedGlobal(a.host, EMPTY, "opencode.jsonc");
    const envA = ocEnv(a.host);
    const srcA = ashMcpHostSources("opencode", envA, a.host);
    assert.deepEqual(srcA.map((s) => s.file), [aJson, aJsonc],
      "默认目录里存在的几份都要进来源集合(写入目标排最后)");
    assert.equal(effectiveConfigState(srcA, shape, site.sourcesMerge === true).state, "present",
      "另一份里有生效的 ash ⇒ 最终就是 present");
    assert.equal(fileAshMcpVerdict("opencode", envA, [a.host]).state, "present", "判定也得是 present");
    const beforeA = [readFileSync(aJson, "utf8"), readFileSync(aJsonc, "utf8")];
    const rA = await registerAshMcp({ agentType: "opencode", dir: ashMcpConfigDir("opencode", envA, a.host)!, hostHome: a.host, env: envA });
    assert.ok(rA.ok, rA.ok ? "" : rA.why);
    assert.deepEqual([readFileSync(aJson, "utf8"), readFileSync(aJsonc, "utf8")], beforeA,
      "两份都一个字节不许动");

    // ⒝ 高优先级那份只把同名 ash **关掉**:真 CLI 报 `ash disabled`。
    //    上一版「任一来源 present 就 present」报已接好 —— 执行器跑到交卷才发现工具不在。
    const b = bench("sources-disabled-wins");
    const bGlobal = seedGlobal(b.host, WITH_ASH);
    const bCustom = join(b.dir, "my.json");
    writeFileSync(bCustom, ASH_OFF, "utf8");
    const envB = ocEnv(b.host, { OPENCODE_CONFIG: bCustom });
    const srcB = ashMcpHostSources("opencode", envB, b.host);
    assert.equal(effectiveConfigState(srcB, shape, site.sourcesMerge === true).state, "disabled",
      "高优先级那份关掉了 ⇒ 最终是 disabled");
    const verdictB = fileAshMcpVerdict("opencode", envB, [b.host]);
    assert.equal(verdictB.state, "disabled", `判定也得是 disabled:${JSON.stringify(verdictB)}`);
    const rB = await registerAshMcp({ agentType: "opencode", dir: ashMcpConfigDir("opencode", envB, b.host)!, hostHome: b.host, env: envB });
    assert.ok(!rB.ok && /没有替你打开/.test(rB.why), `不许替用户打开:${rB.ok ? "ok" : rB.why}`);
    assert.equal(readFileSync(bGlobal, "utf8"), WITH_ASH, "全局那份不许动");
    assert.equal(readFileSync(bCustom, "utf8"), ASH_OFF, "那份也不许动");

    // ⒞ `OPENCODE_CONFIG_DIR` 再加一个目录、优先级高于默认目录。
    const c = bench("sources-alt-dir");
    seedGlobal(c.host, WITH_ASH);
    const altDir = join(c.dir, "alt");
    mkdirSync(altDir, { recursive: true });
    writeFileSync(join(altDir, "opencode.json"), ASH_OFF, "utf8");
    const envC = ocEnv(c.host, { OPENCODE_CONFIG_DIR: altDir });
    assert.equal(
      effectiveConfigState(ashMcpHostSources("opencode", envC, c.host), shape, site.sourcesMerge === true).state,
      "disabled", "再加的那个目录优先级更高 ⇒ 它关掉了就是关掉了");

    // ⒟ `OPENCODE_CONFIG_CONTENT` 优先级最高,而且**没有文件可写**:只有它有 ash 时,
    //    判定必须是 present、而且一个字都不许写(上一版判 absent 还去改全局文件)。
    const d = bench("sources-inline");
    const dGlobal = seedGlobal(d.host, EMPTY);
    const envD = ocEnv(d.host, { OPENCODE_CONFIG_CONTENT: WITH_ASH });
    const srcD = ashMcpHostSources("opencode", envD, d.host);
    assert.equal(srcD.at(-1)!.file, null, "变量里那段是只读来源,没有文件可写");
    assert.equal(ashMcpHostFile("opencode", envD, d.host), dGlobal, "落点只能是可写的那一份");
    assert.equal(fileAshMcpVerdict("opencode", envD, [d.host]).state, "present",
      "只有变量里那段有 ash,真 CLI 也连得上 ⇒ present");
    const rD = await registerAshMcp({ agentType: "opencode", dir: ashMcpConfigDir("opencode", envD, d.host)!, hostHome: d.host, env: envD });
    assert.ok(rD.ok, rD.ok ? "" : rD.why);
    assert.equal(readFileSync(dGlobal, "utf8"), EMPTY, "全局那份一个字节都不许动");

    // ⒠ 合并语义**没实测过**的那家(kilo):几份结论不一致 ⇒ 一律 unknown,不写也不拦起跑。
    const e = bench("sources-unmeasured");
    const kiloDir = join(e.host, ".config", "kilo");
    mkdirSync(kiloDir, { recursive: true });
    writeFileSync(join(kiloDir, "kilo.json"), WITH_ASH, "utf8");
    const kiloCustom = join(e.dir, "k.json");
    writeFileSync(kiloCustom, EMPTY, "utf8");
    const envE = { XDG_CONFIG_HOME: join(e.host, ".config"), KILO_CONFIG: kiloCustom } as NodeJS.ProcessEnv;
    const stateE = effectiveConfigState(
      ashMcpHostSources("kilo", envE, e.host), shapeOf("kilo").shape, shapeOf("kilo").site.sourcesMerge === true);
    assert.equal(stateE.state, "unknown", "没实测过合并语义、几份还不一致 ⇒ 看不准");
    assert.match(stateE.detail, /没实测/, `要说清是没实测过:${stateE.detail}`);
    const rE = await registerAshMcp({ agentType: "kilo", dir: ashMcpConfigDir("kilo", envE, e.host)!, hostHome: e.host, env: envE });
    assert.ok(!rE.ok && /看不准/.test(rE.why), `看不准就不写:${rE.ok ? "ok" : rE.why}`);
    assert.equal(readFileSync(kiloCustom, "utf8"), EMPTY, "两份都不许动");
    group("来源完整性 + 顺序 + 最终条目:两份都读、关掉的赢、只读来源不写、没实测的只说看不准");
  }

  // ── ⑱ 逐名跨来源解析:`ash` 和 `harness` 是两条独立登记(本轮审查 F3)──────────
  {
    const { shape, site } = shapeOf("opencode");
    const merges = site.sourcesMerge === true;

    // ⒜ 审查那条复现:高优先级那份里 `ash` 关着、低优先级那份里 `harness` 开着 ⇒ 真 CLI
    //    那边工具**连得上**(两个名字各是一条登记,ash 的工具由 harness 那条提供)。
    //    上一版先把每份来源压成一个四态、再按优先级选赢家,两个名字的事实在第一步就混成了
    //    一个 —— 判成 disabled,而 disabled 在预检里是硬拒:执行器明明能交卷却被拒派审。
    const a = bench("f3-two-names");
    const aGlobal = seedGlobal(a.host, HARNESS_ON);
    const aCustom = join(a.dir, "my.json");
    writeFileSync(aCustom, ASH_OFF, "utf8");
    const envA = ocEnv(a.host, { OPENCODE_CONFIG: aCustom });
    const srcA = ashMcpHostSources("opencode", envA, a.host);
    const stA = effectiveConfigState(srcA, shape, merges);
    assert.equal(stA.state, "present", `两个名字各算一次,harness 那条是开着的:${stA.detail}`);
    assert.equal(stA.serverName, "harness", "说清生效的是哪一条(用户要去看的就是它)");
    assert.equal(fileAshMcpVerdict("opencode", envA, [a.host]).state, "present", "派审门禁也得放行");
    const rA = await registerAshMcp({
      agentType: "opencode", dir: ashMcpConfigDir("opencode", envA, a.host)!, hostHome: a.host, env: envA,
    });
    assert.ok(rA.ok && rA.serverName === "harness", `已经接好了就别再写:${rA.ok ? rA.serverName : rA.why}`);
    assert.equal(readFileSync(aGlobal, "utf8"), HARNESS_ON, "两份都不许动");
    assert.equal(readFileSync(aCustom, "utf8"), ASH_OFF, "两份都不许动");

    // ⒝ 同一个选中结果要**喂给搬运**:宿主那份里 `ash` 关着(指向 /off.js)、`harness` 开着
    //    (指向 /live.js,底下还挂着子表)⇒ 隔离档里补出来的那条必须是 harness 那段的内容。
    //    上一版 `hostBlock` 自己按名字固定先挑 `ash`,跟 `read` 挑开着那条的判据不是一套:
    //    搬过去的是那条**关着的**,隔离档里的 agent 一开口就交不了卷。
    const b = bench("f3-host-transplant");
    const codexHome = join(b.host, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"),
      '[mcp_servers.ash]\ncommand = "node"\nargs = ["/off.js"]\nenabled = false\n\n'
      + '[mcp_servers.harness]\ncommand = "node"\nargs = ["/live.js"]\n\n'
      + '[mcp_servers.harness.tools.get_task]\napproval_mode = "approve"\n', "utf8");
    const isolated = join(b.dir, "codex-home");
    mkdirSync(isolated, { recursive: true });
    const rB = await registerAshMcp({ agentType: "codex", dir: isolated, hostHome: b.host, env: {} });
    assert.ok(rB.ok, rB.ok ? "" : rB.why);
    const built = readFileSync(join(isolated, "config.toml"), "utf8");
    assert.match(built, /args = \["\/live\.js"\]/, `搬的必须是开着那条:\n${built}`);
    assert.ok(!/enabled = false/.test(built), `那条关着的一个字都不该搬过来:\n${built}`);
    assert.match(built, /\[mcp_servers\.ash\.tools\.get_task\]/, "子表照搬(表头改成规范名)");
    assert.ok(!/off\.js/.test(built), "关着那条的启动参数也不该出现");

    // ⒞ 诊断提示跟判定取**同一条**登记:`ash` 关着(/old.js)、`harness` 开着(/live.js)
    //    ⇒ 提示里说的是 /live.js。这一格钉的是「同源」:上一版判定按最终生效算、提示按
    //    present 过滤再取最后一份、再重新挑一次条目 —— 两套判据,漂起来的后果就是提示指向
    //    一个根本没在跑的命令(⒜⒝ 是那两套判据已经实测分叉的地方)。
    const c = bench("f3-hint");
    const hintBody = ocBody({
      ash: { ...OC_ENTRY, command: ["node", "/old.js"], enabled: false },
      harness: { ...OC_ENTRY, command: ["node", "/live.js"] },
    });
    seedGlobal(c.host, hintBody);
    const envC = ocEnv(c.host);
    const pick = resolveAshMcp(ashMcpHostSources("opencode", envC, c.host), shape, merges);
    assert.equal(pick.state, "present");
    assert.deepEqual(pick.fact?.launch?.args, ["/live.js"], "解析层交出来的就是开着那条的启动方式");
    const verdictC = fileAshMcpVerdict("opencode", envC, [c.host]);
    assert.equal(verdictC.state, "present");
    assert.match(verdictC.hint ?? "", /live\.js/, `提示要指到开着那条:${verdictC.hint}`);
    assert.ok(!/old\.js/.test(verdictC.hint ?? ""), `关着那条不许拿去当提示:${verdictC.hint}`);

    // ⒟ 整份读不准的那一份:**优先级不低于**生效那条时只能说看不准(它可能正把那条关掉);
    //    优先级更低时影响不到,照样放行 —— 低的盖不住高的。
    const d = bench("f3-blind-high");
    seedGlobal(d.host, WITH_ASH);
    const brokenHigh = join(d.dir, "broken.json");
    writeFileSync(brokenHigh, '{"mcp": {', "utf8");
    const stD = effectiveConfigState(
      ashMcpHostSources("opencode", ocEnv(d.host, { OPENCODE_CONFIG: brokenHigh }), d.host), shape, merges);
    assert.equal(stD.state, "unknown", "更高优先级那份读不准 ⇒ 看不准");
    const e = bench("f3-blind-low");
    seedGlobal(e.host, '{"mcp": {');
    const highOk = join(e.dir, "ok.json");
    writeFileSync(highOk, WITH_ASH, "utf8");
    const stE = effectiveConfigState(
      ashMcpHostSources("opencode", ocEnv(e.host, { OPENCODE_CONFIG: highOk }), e.host), shape, merges);
    assert.equal(stE.state, "present", `优先级更低那份读不准,盖不住高的:${stE.detail}`);

    // ⒠ 缺登记时给的自查路径必须是**路径**(本轮审查 N1:上一版把来源对象直接拼进话里,
    //    用户拿到的是 `看一眼 [object Object]`)。
    const f = bench("n1-how-to-check");
    const one = howToCheck("kimi", { KIMI_CODE_HOME: f.dir } as NodeJS.ProcessEnv);
    assert.ok(!one.includes("[object Object]"), `单来源那家也得给出路径:${one}`);
    assert.match(one, /mcp\.json/, `说清是哪一份:${one}`);
    const many = howToCheck("opencode", ocEnv(f.host, { OPENCODE_CONFIG: join(f.dir, "my.json") }));
    assert.ok(!many.includes("[object Object]"), `几份来源也得逐个给出路径:${many}`);
    assert.match(many, /opencode\.json/, `默认目录那份要在:${many}`);
    assert.match(many, /my\.json/, `变量指的那份也要在:${many}`);
    group("逐名跨来源:两个兼容名各算一次、搬运与提示消费同一个选中结果、自查路径是路径");
  }

  // ── ⑰ 改写已有配置之前留一份核对过的备份(本轮审查 F2)──────────────────────
  {
    if (!entryBuilt) {
      group("(跳过)没 build 过 mcp/dist/index.js，备份那一组测不了");
      return;
    }
    // 服务端这条路(每次起跑、每次读设置页都会走)原来一份备份都不留。而就地写没有原子
    // 替换,「写出异常就回写旧正文」在**只有目标那个 inode 持续坏**时同样失败 —— 审查在裸
    // Node 那侧实测到活动配置留成 `{"other":{"`,那种情况下用户手里必须有东西可还原。
    const b = bench("server-backup");
    const file = join(b.dir, "mcp.json");
    const before = `${JSON.stringify({ userSetting: "keep-me" }, null, 2)}\n`;
    writeFileSync(file, before, "utf8");
    const r = await registerAshMcp({ agentType: "kimi", dir: b.dir, hostHome: b.host, env: {} });
    assert.ok(r.ok, r.ok ? "" : r.why);
    const backup = `${file}${BACKUP_SUFFIX}`;
    assert.ok(existsSync(backup), "改写已有配置之前必须留一份备份");
    assert.equal(readFileSync(backup, "utf8"), before, "备份必须逐字节是改之前那一版");
    assert.match(readFileSync(file, "utf8"), /"ash"/, "正事也办成了");

    // 新建的那一路没什么可备份的(原来就没有这个文件),不许凭空留一份空备份。
    const c = bench("server-backup-new");
    const fresh = join(c.dir, "mcp.json");
    const r2 = await registerAshMcp({ agentType: "kimi", dir: c.dir, hostHome: c.host, env: {} });
    assert.ok(r2.ok, r2.ok ? "" : r2.why);
    assert.ok(existsSync(fresh), "该写的写了");
    assert.ok(!existsSync(`${fresh}${BACKUP_SUFFIX}`), "原来没有这个文件就别留备份");

    // 备份那个名字上**摆着别的东西**时:不覆盖、也不跟着它写(本轮审查 F2)。上一版拿
    // `copyFileSync` 往那个固定名字上直接拷,于是一条指向用户另一份文件的软链接会被跟着
    // 走 —— 那份无关文件被整份改成 CLI 配置,而且整条路照样报成功。
    const d = bench("server-backup-squatter");
    const file2 = join(d.dir, "mcp.json");
    const before2 = `${JSON.stringify({ userSetting: "keep-me-too" }, null, 2)}\n`;
    writeFileSync(file2, before2, "utf8");
    const bystander = join(d.dir, "unrelated.txt");
    const bystanderBody = "用户另一份文件，跟 ash 无关\n";
    writeFileSync(bystander, bystanderBody, "utf8");
    const plain = `${file2}${BACKUP_SUFFIX}`;
    symlinkSync(bystander, plain);
    const r3 = await registerAshMcp({ agentType: "kimi", dir: d.dir, hostHome: d.host, env: {} });
    assert.ok(r3.ok, r3.ok ? "" : r3.why);
    assert.equal(readFileSync(bystander, "utf8"), bystanderBody, "无关文件一个字节都不许动");
    assert.ok(lstatSync(plain).isSymbolicLink(), "那条软链接本身也不许被换成普通文件");
    const own = readdirSync(d.dir).filter((n) => n.startsWith(`${basename(file2)}${BACKUP_SUFFIX}-`));
    assert.equal(own.length, 1, `被占住就换一个自己的唯一名字:${readdirSync(d.dir).join("、")}`);
    assert.equal(readFileSync(join(d.dir, own[0]!), "utf8"), before2, "备份必须逐字节是改之前那一版");
    assert.equal(statSync(join(d.dir, own[0]!)).mode & 0o777, 0o600, "备份一出生就只有自己能读");
    assert.match(readFileSync(file2, "utf8"), /"ash"/, "正事也办成了");
    group("服务端这条路也留备份:改写前那一版逐字节在、新建那一路不留白备份、占住的名字不碰");
  }
}
