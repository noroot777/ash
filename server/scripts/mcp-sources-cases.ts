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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKUP_SUFFIX } from "../src/auth/config-publish.js";
import { fileAshMcpVerdict } from "../src/ash-mcp-file.js";
import {
  ashMcpHostFile, ashMcpHostSources, effectiveConfigState, registerAshMcp,
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
    group("服务端这条路也留备份:改写前那一版逐字节在,新建那一路不留白备份");
  }
}
