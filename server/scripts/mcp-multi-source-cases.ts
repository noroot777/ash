// 一家 CLI 会读好几份配置时,裸 Node 那份安装器怎么判 —— 「几份**合起来**生效的那一条」。
//
// 为什么单独一个文件:这一组要搭的沙盘最多(层级对打、字段继承、同目录先后、同路径两个
// 加载阶段、坏文件在哪一层),而 `test-ash-mcp-installer.ts` 已经接近单文件 700 行上限。
// 由那个文件调用,不是独立的回归入口;TS 那侧对应的几组住在 `mcp-sources-cases.ts`。
//
// 判据全是真 opencode 1.19.3 逐格实测的(结论记在 `mcp-registry/catalog.ts` 那家的
// `source` 里),这里只钉「裸 Node 这侧跟它一致」。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 这一组要用到的那几件外部家当(都由入口文件给,见那边的同名定义)。 */
export interface MultiSourceDeps {
  /** 一副全新的假 HOME。 */
  home: (name: string) => string;
  /** 跑一次裸 Node 安装器。 */
  install: (agentType: string, h: string, env?: NodeJS.ProcessEnv) => { file: string; added: boolean; why?: string };
  /** `scripts/mcp-hosts.mjs` 本体(这一组还要问它写入落点)。 */
  hosts: { hostMcpFile: (agentType: string, opts: { env?: NodeJS.ProcessEnv; home?: string }) => string | null };
  /** 报一组过了。 */
  group: (name: string) => void;
}

export function checkMultiSource({ home, install, hosts, group }: MultiSourceDeps): void {
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

    // ── 本轮审查 F1:判的是「几份**合起来**生效的那一条」,不是「挑一份赢家」 ────────
    //    四格的真 CLI 结论都在 `catalog.ts` 那家的 `source` 里(⑨⑫⑬⑭),这里钉裸 Node 这侧
    //    跟它一致 —— TS 那侧同样四格在 `mcp-sources-cases.ts` 第 ⑲ 组。
    const ocFull = (tag: string, enabled: boolean) => `${JSON.stringify({
      mcp: { ash: { type: "local", command: ["node", `/${tag}.js`], environment: { WHO: tag }, enabled } },
    }, null, 2)}\n`;
    const ocRaw = (ash: Record<string, unknown>) => `${JSON.stringify({ mcp: { ash } }, null, 2)}\n`;

    // ⒤ **层级对打**:`OPENCODE_CONFIG` 那个文件写完整条目 + `enabled:false`,
    //    `OPENCODE_CONFIG_DIR` 那个目录里只写 `{"enabled":true}` ⇒ 真 CLI `ash connected`。
    //    上一版把文件排在目录上面(排反了),于是报「被关掉了,没有替你打开」。
    const h8 = home("merge-dir-beats-file");
    mkdirSync(join(h8, ".config", "opencode"), { recursive: true });
    writeFileSync(join(h8, ".config", "opencode", "opencode.json"), empty, "utf8");
    const f8 = join(h8, "custom.json");
    writeFileSync(f8, ocFull("FILE", false), "utf8");
    const alt8 = join(h8, "altdir");
    mkdirSync(alt8, { recursive: true });
    writeFileSync(join(alt8, "opencode.json"), ocRaw({ enabled: true }), "utf8");
    const r8 = install("opencode", h8, { OPENCODE_CONFIG: f8, OPENCODE_CONFIG_DIR: alt8 });
    assert.ok(!r8.added, "合起来是开着的 ⇒ 不该再写一条");
    assert.match(r8.why ?? "", /已经有生效的/, `不许说成被关掉了:${r8.why ?? ""}`);
    assert.equal(hosts.hostMcpFile("opencode", { env: { OPENCODE_CONFIG: f8, OPENCODE_CONFIG_DIR: alt8 }, home: h8 }),
      join(alt8, "opencode.json"), "落点是优先级最高的那份可写来源");

    // ⒥ **只写开关、没写启动方式**:真 CLI 打印 `No MCP servers configured`(有键不等于有
    //    服务),所以既不许当「已接好」,也不许覆盖用户那个键 ⇒ 如实说看不准、一个字不写。
    const h9 = home("merge-switch-only");
    const g9 = join(h9, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(g9), { recursive: true });
    const switchOnly = ocRaw({ enabled: true });
    writeFileSync(g9, switchOnly, "utf8");
    const f9 = join(h9, "custom.json");
    writeFileSync(f9, empty, "utf8");
    const r9 = install("opencode", h9, { OPENCODE_CONFIG: f9 });
    assert.ok(!r9.added, "只有一个开关键 ⇒ 不许报成已接好,也不许覆盖它");
    assert.match(r9.why ?? "", /没写启动方式/, `要说清缺的是什么:${r9.why ?? ""}`);
    assert.equal(readFileSync(g9, "utf8"), switchOnly, "一个字节都不许动");

    // ⒦ **同目录两份都开着、命令不同** ⇒ 真 CLI 用 `.jsonc` 那条,所以措辞和落点都指它。
    const h10 = home("merge-same-dir");
    mkdirSync(join(h10, ".config", "opencode"), { recursive: true });
    writeFileSync(join(h10, ".config", "opencode", "opencode.json"), ocFull("JSON", true), "utf8");
    const jsonc10 = join(h10, ".config", "opencode", "opencode.jsonc");
    writeFileSync(jsonc10, ocFull("JSONC", true), "utf8");
    const f10 = join(h10, "custom.json");
    writeFileSync(f10, empty, "utf8");
    const r10 = install("opencode", h10, { OPENCODE_CONFIG: f10 });
    assert.ok(!r10.added, "已经有生效的 ⇒ 不写");
    assert.match(r10.why ?? "", /opencode\.jsonc/, `说的该是生效那份:${r10.why ?? ""}`);

    // ⒧ **`disabled: true` 这个键 opencode 不认**(实测带着它照样连):不许当成关着硬拒,
    //    也不敢当成没写(同格式的 kilo 没真 CLI 可问)⇒ 如实答看不准。
    const h11 = home("merge-disabled-key");
    const g11 = join(h11, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(g11), { recursive: true });
    const withDisabled = ocRaw({ type: "local", command: ["node", "/x.js"], enabled: true, disabled: true });
    writeFileSync(g11, withDisabled, "utf8");
    const f11 = join(h11, "custom.json");
    writeFileSync(f11, empty, "utf8");
    const r11 = install("opencode", h11, { OPENCODE_CONFIG: f11 });
    assert.ok(!r11.added, "看不准就不写");
    assert.match(r11.why ?? "", /disabled: true/, `要指明是哪个键:${r11.why ?? ""}`);
    assert.equal(readFileSync(g11, "utf8"), withDisabled, "一个字节都不许动");

    // ── 本轮审查 F1 的 A/B/C:合并的三条实测约束(TS 那侧同三格在 `mcp-sources-cases.ts`
    //    第 ⑳ 组;真 CLI 结论记在 `catalog.ts` 的 `source` ⑯–⑳)────────────────────
    // ⒨ **逐份投影**:低那份写成开关(没 type)⇒ 只贡献 `enabled`,它写的 command /
    //    environment 真 CLI 一律丢掉。这里钉裸 Node 这侧「不许据此说成已接好以外的话」:
    //    合出来是开着的 ⇒ 不写、措辞指生效那份。
    const h12 = home("merge-project-lowest");
    const g12 = join(h12, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(g12), { recursive: true });
    writeFileSync(g12, ocRaw({ enabled: true, environment: { SMOKE_REJECT: "yes" }, command: ["node", "/x.js"] }), "utf8");
    const f12 = join(h12, "custom.json");
    writeFileSync(f12, ocFull("LIVE", true), "utf8");
    const r12 = install("opencode", h12, { OPENCODE_CONFIG: f12 });
    assert.ok(!r12.added, "合起来是开着的 ⇒ 不该再写一条");
    assert.match(r12.why ?? "", /已经有生效的/, `不许说成关着或看不准:${r12.why ?? ""}`);
    //    低那份写成 `{enabled:false}`(没 type)⇒ 开关跨来源继承,真 CLI 关着 ⇒ 不许替用户打开。
    const h13 = home("merge-switch-off-inherits");
    const g13 = join(h13, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(g13), { recursive: true });
    const off13 = ocRaw({ enabled: false, environment: { X: "1" } });
    writeFileSync(g13, off13, "utf8");
    const f13 = join(h13, "custom.json");
    // 高那份**不写 enabled**(默认开着):开关只能从低那份继承上来,这一格考的就是它。
    const live13 = ocRaw({ type: "local", command: ["node", "/live.js"], environment: { WHO: "LIVE" } });
    writeFileSync(f13, live13, "utf8");
    const r13 = install("opencode", h13, { OPENCODE_CONFIG: f13 });
    assert.ok(!r13.added, "关着就不写");
    assert.match(r13.why ?? "", /没有替你打开/, `要说清是关着的:${r13.why ?? ""}`);
    assert.deepEqual([readFileSync(g13, "utf8"), readFileSync(f13, "utf8")], [off13, live13], "两份都不许动");

    // ⒩ **阶段才是单位**:`OPENCODE_CONFIG` 指回默认目录那份 ⇒ 真 CLI 在同目录 `.jsonc`
    //    之后再读一遍它,开关翻回来(`ash connected`)。上一版按路径去重,于是判成关着、
    //    落点还指向 `.jsonc`。
    const h14 = home("merge-same-path");
    const dir14 = join(h14, ".config", "opencode");
    mkdirSync(dir14, { recursive: true });
    const json14 = join(dir14, "opencode.json");
    writeFileSync(json14, ocFull("JSON", true), "utf8");
    writeFileSync(join(dir14, "opencode.jsonc"), ocRaw({ enabled: false }), "utf8");
    const r14 = install("opencode", h14, { OPENCODE_CONFIG: json14 });
    assert.ok(!r14.added, "再读那一遍把开关翻回来了 ⇒ 已经有生效的,不写");
    assert.match(r14.why ?? "", /已经有生效的/, `不许说成关着:${r14.why ?? ""}`);
    assert.equal(hosts.hostMcpFile("opencode", { env: { OPENCODE_CONFIG: json14 }, home: h14 }), json14,
      "落点是最高那个阶段指的那份,不是 .jsonc");

    // ⒪ **任何一份读不通就整份拒载**(实测:坏文件在哪一层都 exit 1,哪怕它没提 ash)⇒
    //    只能答看不准、一个字不写。上一版「低的盖不住高的」会说「已经有生效的 ash 登记」。
    for (const where of ["lowest", "highest", "no-ash"] as const) {
      const h15 = home(`merge-broken-${where}`);
      const g15 = join(h15, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(g15), { recursive: true });
      const f15 = join(h15, "custom.json");
      let broken = g15;
      if (where === "lowest") {
        writeFileSync(g15, "{BROKEN", "utf8");
        writeFileSync(f15, ocFull("LIVE", true), "utf8");
      } else if (where === "highest") {
        writeFileSync(g15, ocFull("LIVE", true), "utf8");
        broken = f15;
        writeFileSync(f15, "{BROKEN", "utf8");
      } else {
        writeFileSync(g15, '{"model": ', "utf8");
        writeFileSync(f15, ocFull("LIVE", true), "utf8");
      }
      const r15 = install("opencode", h15, { OPENCODE_CONFIG: f15 });
      assert.ok(!r15.added, `${where}:看不准就不写`);
      assert.match(r15.why ?? "", /看不准/, `${where}:要如实说看不准(${r15.why ?? ""})`);
      assert.ok(readFileSync(broken, "utf8").startsWith("{"), `${where}:坏的那份一个字节都不许动`);
    }
    group("会读好几份配置的那家:判的是几份合起来那一条(层级、逐份投影、阶段去重、读不通就看不准)");
  }

  // ── 本轮审查 F1:来源集合漏掉的那三个入口(裸 Node 这侧只有「写不写」这一个出口)──
  {
    const full = (tag: string) => `${JSON.stringify({
      mcp: {
        ash: {
          type: "local", command: ["node", `/${tag}.js`],
          environment: { ASH_URL: "http://127.0.0.1:54321" }, enabled: true,
        },
      },
    }, null, 2)}\n`;
    const empty = '{\n  "$schema": "x"\n}\n';
    const put = (file: string, body: string): string => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body, "utf8");
      return file;
    };

    // ⒜ 默认目录里的 `config.json`(真 CLI 也读、优先级最低)。**审查那一行的复现**:上一版
    //    压根没枚举这个名字,于是这里 `added:true`、新建一份 `opencode.json`,而它优先级更
    //    高 —— 真 CLI 的生效 `ASH_URL` 当场从用户那条 `:54321` 换成了 ash 那条 `:4317`。
    const h = home("load-config-json");
    const low = put(join(h, ".config", "opencode", "config.json"), full("CONFIGJSON"));
    const r = install("opencode", h);
    assert.ok(!r.added, `config.json 里已经有生效的 ash ⇒ 不许再写一条顶掉它:${r.why ?? ""}`);
    assert.equal(readFileSync(low, "utf8"), full("CONFIGJSON"), "那份一个字节都不许动");

    // ⒝ `~/.opencode/`(另一层全局配置,压过默认目录):同理不写。
    const h2 = home("load-dot-opencode");
    put(join(h2, ".config", "opencode", "opencode.json"), empty);
    const dot = put(join(h2, ".opencode", "opencode.json"), full("DOT"));
    const r2 = install("opencode", h2);
    assert.ok(!r2.added, `~/.opencode 那份里已经有 ash ⇒ 不写:${r2.why ?? ""}`);
    assert.equal(readFileSync(dot, "utf8"), full("DOT"), "那份一个字节都不许动");

    // ⒞ `OPENCODE_CONFIG` 给**相对路径**:它按 CLI 自己的工作目录解,安装器这边压根算不出
    //    是哪一份 ⇒ **看不准就不写**(上一版当成文件名直接用、按自己的目录找不到就判没有,
    //    于是又新写一条)。
    const h3 = home("load-relative");
    const g3 = put(join(h3, ".config", "opencode", "opencode.json"), empty);
    const r3 = install("opencode", h3, { OPENCODE_CONFIG: "ws-config.json" });
    assert.ok(!r3.added, "相对路径解不出 ⇒ 不写");
    assert.match(r3.why ?? "", /看不准/, `要如实说看不准:${r3.why ?? ""}`);
    assert.equal(readFileSync(g3, "utf8"), empty, "全局那份也不许动");
    // 绝对路径照旧照常走(别把这条闸开得太大)。
    const abs = put(join(h3, "abs.json"), empty);
    const r4 = install("opencode", h3, { OPENCODE_CONFIG: abs });
    assert.ok(r4.added, `绝对路径仍然照常补:${r4.why ?? ""}`);
    assert.equal(r4.file, abs, "写的就是变量指的那一份");
    group("来源集合补齐:config.json / ~/.opencode 里已有的不覆盖,相对路径看不准就不写");
  }

  // ── 本轮审查 F2:逐家启停策略(裸 Node 这侧)────────────────────────────────
  {
    const geminiBody = (extra: Record<string, unknown>) => `${JSON.stringify({
      mcpServers: { other: { command: "node", args: ["/o.js"] } }, ...extra,
    }, null, 2)}\n`;
    for (const [tag, extra] of [
      ["excluded 列着 ash", { mcp: { excluded: ["ash"] } }],
      ["allowed 白名单里没有 ash", { mcp: { allowed: ["other"] } }],
    ] as const) {
      const h = home("switch-gemini");
      const file = join(h, ".gemini", "settings.json");
      mkdirSync(dirname(file), { recursive: true });
      const body = geminiBody(extra);
      writeFileSync(file, body, "utf8");
      const r = install("gemini", h);
      // 真 gemini 0.60.0 实测:这两种写法都把 ash 打成 `Blocked`。写进去也是一条用不上的
      // 登记,而用户看到的是「已接好」—— 所以如实拒,别碰那两个名单。
      assert.ok(!r.added, `${tag} ⇒ 不写:${r.why ?? ""}`);
      assert.match(r.why ?? "", /没有替你打开|mcp\.(excluded|allowed)/, `${tag}:要说清为什么(${r.why ?? ""})`);
      assert.equal(readFileSync(file, "utf8"), body, `${tag}:那份一个字节都不许动`);
    }
    // 白名单里有 ash ⇒ 照常补(闸不许开大)。
    const ok = home("switch-gemini-ok");
    const okFile = join(ok, ".gemini", "settings.json");
    mkdirSync(dirname(okFile), { recursive: true });
    writeFileSync(okFile, geminiBody({ mcp: { allowed: ["ash", "other"] } }), "utf8");
    const rOk = install("gemini", ok);
    assert.ok(rOk.added, `白名单里有 ash ⇒ 照常补:${rOk.why ?? ""}`);

    // grok 的根级数组是它专有的:认它(而同格式的 codex 不认 —— codex 走它自己那条带 CLI
    // 批准的路,不在这张表里,TS 那侧有逐家对打的那一格)。
    const g = home("switch-grok");
    const gFile = join(g, ".grok", "config.toml");
    mkdirSync(dirname(gFile), { recursive: true });
    const gBody = 'disabled_mcp_servers = ["ash"]\n\nmodel = "x"\n';
    writeFileSync(gFile, gBody, "utf8");
    const rg = install("grok", g);
    assert.ok(!rg.added, `grok:根级那行关着 ash ⇒ 不写:${rg.why ?? ""}`);
    assert.match(rg.why ?? "", /disabled_mcp_servers/, `要说清是哪一行:${rg.why ?? ""}`);
    assert.equal(readFileSync(gFile, "utf8"), gBody, "那份一个字节都不许动");
    group("逐家启停策略:gemini 的根级名单挡住就不写、grok 的根级数组照旧认(都不替用户打开)");
  }
}
