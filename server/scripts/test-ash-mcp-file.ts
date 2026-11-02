// ash MCP 预检的**配置文件那一档**（server/src/ash-mcp-file.ts）—— 问不了 CLI 本人时的退路。
//
// 为什么非钉不可：新链第 1 轮审查在 macOS 上用真配置实测，配置里确实没有 ash 登记，派审
// 预检 `reachable:true`、启动自检一声不吭（问 CLI 要起进程，那台机器拿不到能核销进程的
// 内核圈定，于是整条放行）。这一档要在那类机器上把「确定没有」说出来，同时**绝不**把
// 「看不懂」读成「没有」—— 拦错一轮审查，用户得到的是一条根本跑不起来的链。
//
// 开头**强制关掉内核圈定**（`ASH_KERNEL_CONFINE=0`）：这样在哪个平台上走的都是同一条退路，
// Windows/Linux 的验收也能把它跑一遍，不只在 macOS 上有效。
//
// 覆盖：
//   1. TOML 扫描器：引号名 / 缩进 / 行尾注释 / 点号键 / 内联表 / 多行字符串里的假表头 /
//      多行数组 / 两个兼容名一开一关 / 挂在别的表底下 / 整个内联 —— 判不了的一律 doubt；
//      路径型表头（`[projects."…/harness"]`）不算信号
//   2. codex 文件判据：absent / disabled / present / 没有文件 / 读不动 / 项目内 .codex
//      （只到 git 根、不把宿主默认那份当项目配置）
//   3. claude 文件判据：用户级 / 项目级（键是主仓 git 根或目录本身）/ `.mcp.json`（一路往上）/
//      解析不了
//   4. 端到端：派审预检在问不了 CLI 时按文件判，**一个进程都不起**；带 extraArgs 放行；
//      409 文案写明证据来源与问不了的原因
//   5. 启动自检：`enabled = false` 不再被快速通道放过（第 2 条），措辞随证据来源降档
//   6. 「登记在 ≠ 起得来」：只出提示，不拦（第 3 条）
//
// 跑：npm -w server run test:ash-mcp-file
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-mcp-file-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;
process.env.ASH_KERNEL_CONFINE = "0";

try {
  const { scanCodexToml, fileAshMcpVerdict, launchHint } = await import("../src/ash-mcp-file.js");

  // ── 1. 扫描器 ───────────────────────────────────────────────────────────
  {
    const scan = (t: string) => {
      const r = scanCodexToml(t);
      return { names: Object.fromEntries([...r.servers].map(([n, s]) => [n, s.enabled])), doubt: !!r.doubt };
    };
    const yes = { names: { ash: true }, doubt: false };
    assert.deepEqual(scan('[mcp_servers.ash]\ncommand = "node"\n'), yes, "标准写法");
    assert.deepEqual(scan('[mcp_servers."ash"]\ncommand = "node"\n'), yes, "引号名（正则版判成缺失的那种）");
    assert.deepEqual(scan('  [ mcp_servers . \'ash\' ]   # a=b ]\n  command = "node"\n'), yes,
      "缩进 + 字面量引号 + 行尾注释里带 `=` 和 `]`");
    assert.deepEqual(scan('mcp_servers.ash.command = "node"\n'), yes, "根上的点号键");
    assert.deepEqual(scan('[mcp_servers]\nash = { command = "node" }\n'), yes, "内联表");
    assert.deepEqual(scan('[mcp_servers.ash]\ncommand = "node"\nenabled = false\n'),
      { names: { ash: false }, doubt: false }, "关着的登记必须认成关着（第 2 条的形状）");
    assert.deepEqual(scan('mcp_servers.ash.enabled = false\n'), { names: { ash: false }, doubt: false });
    assert.deepEqual(scan('[mcp_servers]\nash = { command = "node", enabled = false }\n'),
      { names: { ash: false }, doubt: false });
    // 另一个 server 的 enabled=false 不能算到 ash 头上（F2 那个形状），注释里的表头不算数。
    assert.deepEqual(scan('[mcp_servers.foo] # 旁边\nenabled = false\n[mcp_servers.ash]\ncommand = "x"\n'), yes);
    assert.deepEqual(scan('[mcp_servers.foo]\ncommand = "x" # [mcp_servers.ash]\n'), { names: {}, doubt: false },
      "注释里的表头不是登记");
    assert.deepEqual(scan('x = [\n  "[mcp_servers.ash]",\n]\n[mcp_servers.harness]\ncommand = "node"\n'),
      { names: { harness: true }, doubt: false }, "多行数组续行里的 `[` 不是表头");
    assert.deepEqual(
      scan('[mcp_servers.ash]\nenabled = false\n[mcp_servers.harness]\ncommand = "node"\n'),
      { names: { ash: false, harness: true }, doubt: false }, "两个兼容名各记各的");
    assert.deepEqual(scan('model = "gpt"\n'), { names: {}, doubt: false });
    // 判不了的一律 doubt：拦人只能落在「确定没有」上。
    assert.equal(scan('note = """\n[mcp_servers.ash]\n"""\n').doubt, true,
      "多行字符串里像表头的东西：扫描器不认、兜底也不许说「没有」");
    assert.equal(scan('[profiles.p.mcp_servers.ash]\ncommand = "node"\n').doubt, true, "挂在别的表底下");
    assert.equal(scan('profiles.p.mcp_servers.ash.command = "node"\n').doubt, true, "点号键挂在别的表底下");
    // ── 别的命名空间里**恰好**有个字段叫 mcp_servers：合法、与 ash 无关，一个字都不许算到
    //    我们头上（第 2 轮审查 F1，真机取证）。上一版对任何位置的 mcp_servers 段都答 doubt，
    //    于是一份接得好好的配置被判成「看不准」：注入目标变 null、Windows 上派审当场被拒、
    //    mac 上审查跑完交不了卷。值得提示的只有「紧跟着兼容名」那种 —— 用户以为接好了，而
    //    codex 并不读那个位置（上面两条）。
    for (const unrelated of [
      '[profiles.mcp_servers]\nmodel = "gpt"\n',
      '[model_providers.mcp_servers]\nbase_url = "http://x"\n',
      '[profiles.foo.mcp_servers]\nkb = { command = "uv" }\n',
      'profiles.mcp_servers.model = "gpt"\n',
      '[profiles.p]\nmcp_servers = { kb = { command = "uv" } }\n',
    ]) {
      assert.deepEqual(scan(`[mcp_servers.ash]\ncommand = "node"\n${unrelated}`), yes,
        `无关命名空间不许污染判据：${JSON.stringify(unrelated)}`);
    }
    // codex 自己记项目信任就是路径型表头；路径里有 harness/ash 不是登记（新链第 3 轮第 1 条：
    // 上一版兜底拿「行首 `[` + 行内有这两个词」当信号，跑过这个仓库的机器整份配置都成了「看不准」）。
    for (const path of ["/Users/champion/code/harness", "/Users/x/ash/y", "C:\\\\ash"]) {
      assert.deepEqual(
        scan(`[mcp_servers.kb]\ncommand = "uv"\n[projects."${path}"]\ntrust_level = "trusted"\n`),
        { names: {}, doubt: false }, `路径型表头不算信号：${path}`);
    }
    assert.equal(scan('note = """\nmcp_servers.harness.command = "x"\n"""\n').doubt, true,
      "多行字符串里的点号键登记：照旧判不了");
    // ── 多行字符串在哪收尾：**转义引号、连续引号、行尾续行**（第 5 轮 F2）。上一版见到三个
    // 引号就收尾，于是一段合法指令里带转义三引号的接入示例被升级成真登记 —— 真 codex
    // `mcp list` 只列出 kb，而执行器照着那条假登记注入 `-c mcp_servers.ash.env_vars=…`，
    // 同一份本来读得动的配置当场拒载（`invalid transport in mcp_servers.ash`），这台机器上
    // 别的 MCP 一起没了。
    const escaped = 'developer_instructions = """\nAn escaped triple quote: \\"""\n'
      + '[mcp_servers.ash]\ncommand = "node"\n"""\n[mcp_servers.kb]\ncommand = "node"\n';
    assert.deepEqual(scan(escaped).names, {}, "转义引号不收尾 ⇒ 里面那段是示例，不是登记");
    assert.deepEqual(scan('note = """a""""\n[mcp_servers.ash]\ncommand = "node"\n'), yes,
      "四个引号里只有后三个是收尾符（内容末尾留一个）⇒ 下一行是真表头");
    assert.equal(scan('note = """a""""""\n[mcp_servers.ash]\ncommand = "node"\n').doubt, true,
      "六个连续引号：这份 TOML 本身不合法，codex 也读不动 —— 别替它猜");
    assert.deepEqual(scan("note = '''\\'''\n[mcp_servers.ash]\ncommand = \"node\"\n"), yes,
      "多行字面量串里反斜杠不是转义 ⇒ 第一行就收尾了");
    assert.deepEqual(
      scan('note = """\\\n  still inside \\"""\n[mcp_servers.ash]\nc = 1\n"""\n[mcp_servers.harness]\ncommand = "node"\n'),
      { names: { harness: true }, doubt: false }, "行尾续行是合法写法，字符串收尾之后那个才是登记");
    assert.deepEqual(scan('mcp_servers = { ash = { command = "node", note = """a"""" } }\n'),
      yes, "内联表里的连续引号也得按同一条规矩收尾（上一版在这里答「拆不开」）");
    // ── 转义键：**codex 自己会解**（0.153 真机实测：`[mcp_servers."\u0061sh"]` 它读成 ash，
    // rc=0、`mcp mcp list --json` 列得出来）。扫描器不解的话，这份配置里明明有 ash，预检却答
    // 「确定没有」—— 拦下一整轮审查；补写那一侧还会再追加一份同名表，那是 TOML 的重复定义，
    // codex 整份拒载、用户别的 MCP 一起没了（本轮 F1）。
    assert.deepEqual(scan('[mcp_servers."\\u0061sh"]\ncommand = "node"\n'), yes, "\\u 转义键");
    assert.deepEqual(scan('[mcp_servers."as\\u0068"]\ncommand = "node"\n'), yes, "转义只占键的一截");
    assert.deepEqual(scan('[mcp_servers."\\U00000061sh"]\ncommand = "node"\n'), yes, "\\U 八位转义");
    assert.deepEqual(scan('mcp_servers."\\u0061sh".command = "node"\n'), yes, "点号键里的转义");
    assert.deepEqual(scan('[mcp_servers]\n"\\u0061sh" = { command = "node" }\n'), yes, "内联表名里的转义");
    assert.deepEqual(scan('[mcp_servers."a\\tsh"]\ncommand = "node"\n'), { names: {}, doubt: false },
      "解出来是别的名字就不是 ash —— 解错方向反了也一样错（这个名字里是真制表符）");
    assert.deepEqual(scan('[mcp_servers.ash]\ncommand = "no\\"de"\n'), yes, "值里的转义引号不影响读键");
    // 反过来：**codex 读不动的，我们也不准据此说「没有」**。
    assert.equal(scan('[mcp_servers."a\\qsh"]\ncommand = "node"\n').doubt, true, "TOML 不认的转义");
    assert.equal(scan('[mcp_servers."ash]\ncommand = "node"\n').doubt, true, "引号没收尾");
    assert.equal(scan('[mcp_servers.ash]\ncommand = "a"\n[mcp_servers.ash]\ncommand = "b"\n').doubt, true,
      "同名表定义两次：codex 报 duplicate key 整份拒载（setup 旧版追加重复表就是这个形状）");
    assert.deepEqual(scan('[[x]]\na = 1\n[[x]]\na = 2\n[mcp_servers.ash]\ncommand = "node"\n'), yes,
      "数组表重复出现是合法的，不准当成重复定义");
    // ── 整张表写成一个内联值：**必须拆开读**。codex 自己认得（真机 rc=0、`mcp list` 列得出
    // ash，`-c mcp_servers.ash.env_vars=[...]` 也落得上去），上一版只拿 `\bash\b` 扫值文本、
    // 一律答 doubt：派审误拒、身份注不进去；而「确实没有 ash」那一半是对的时候，补写追加
    // 一段普通表头，codex 报 `cannot extend value of type inline table with a dotted key`
    // 整份拒载（第 2 轮审查 F1 的三组实测形状）。
    assert.deepEqual(scan('mcp_servers = { ash = { command = "node", args = [] } }\n'), yes, "根内联表里的 ash");
    assert.deepEqual(scan('mcp_servers = { "\\u0061sh" = { command = "node" } }\n'), yes, "根内联表 + 转义键");
    assert.deepEqual(scan('mcp_servers = { ash = { command = "node", enabled = false } }\n'),
      { names: { ash: false }, doubt: false }, "根内联表里关着的登记");
    assert.deepEqual(scan('mcp_servers = { kb = { command = "node" } }\n'), { names: {}, doubt: false },
      "根内联表里确实没有 ash —— 这一半要答得准，补写那边才知道「缺」是真的");
    assert.equal(scan('mcp_servers = { ash = \n').doubt, true, "内联表拆不开:不准据此说没有");
    // **封闭性**:我们唯一会写的东西是追加一段普通表头,而内联值定义过的表不许这么扩展。
    // 封的只有「整张表是一个内联值」这一种 —— 另四种形状真机都扩展得了(rc=0)。
    const sealed = (t: string) => !!scanCodexToml(t).sealed;
    assert.equal(sealed('mcp_servers = { kb = { command = "node" } }\n'), true, "整张表是内联值 ⇒ 封住了");
    assert.equal(sealed('mcp_servers = {}\n'), true, "空内联值一样封住");
    for (const open of [
      'mcp_servers.kb = { command = "node" }\n',
      'mcp_servers.kb.command = "node"\n',
      '[mcp_servers]\nkb = { command = "node" }\n',
      '[mcp_servers.kb]\ncommand = "uv"\n',
      'model = "gpt"\n',
    ]) assert.equal(sealed(open), false, `这种写法还扩展得了，不准说封住：${JSON.stringify(open)}`);
    // 文件结尾处值还没收尾：后面那些行全成了这个值的续行，看不见的 ash 不等于没有 ash。
    assert.equal(scan('x = [\n  "a",\n').doubt, true, "数组少一个 ]");
    assert.equal(scan('x = [\n  "a",\n[mcp_servers.ash]\ncommand = "node"\n').doubt, true,
      "没收尾的数组把后面的表头吞了 —— 不准答「没有」");
  }

  // ── 1b. 执行器注入回合身份用的同一份判据 ─────────────────────────────────
  // 上一版注入侧是 `^\[mcp_servers\.ash\]` 行首正则：带引号的写法预检放行、注入却认不出，
  // MCP 拿不到回合身份，交卷 409（新链第 4 轮审查第 1 条）。预检认得的写法，注入必须都认得。
  {
    const { codexAshMcpServerName } = await import("../src/executors/codex-mcp.js");
    const home = join(stage, "inject");
    mkdirSync(home, { recursive: true });
    const target = (toml: string) => { writeFileSync(join(home, "config.toml"), toml); return codexAshMcpServerName(home); };
    for (const toml of [
      '[mcp_servers.ash]\ncommand = "node"\n',
      '[mcp_servers."ash"]\ncommand = "node"\n\n[mcp_servers."ash".env]\nASH_URL = "x"\n',
      '  [ mcp_servers . \'ash\' ]  # 注释\n  command = "node"\n',
      '[mcp_servers]\nash = { command = "node" }\n',
      'mcp_servers.ash.command = "node"\n',
      // 整张表写成内联值:真 codex 不仅列得出,`-c mcp_servers.ash.env_vars=[...]` 也落得
      // 上去(本轮真机 rc=0 + env_vars 列得出来),所以注入目标必须给得出来。
      'mcp_servers = { ash = { command = "node" } }\n',
    ]) {
      assert.equal(scanCodexToml(toml).servers.has("ash"), true, `预检认得：${JSON.stringify(toml)}`);
      assert.equal(target(toml), "ash", `注入也必须认得：${JSON.stringify(toml)}`);
    }
    assert.equal(target('[mcp_servers."harness"]\ncommand = "node"\n'), "harness", "只有历史名时注入历史名");
    assert.equal(target('[mcp_servers.ash]\nenabled = false\n[mcp_servers.harness]\ncommand = "node"\n'), "harness",
      "规范名关着、历史名开着：注入开着的那个（工具从它那里来）");
    assert.equal(target('[mcp_servers.ash]\ncommand = "a"\n[mcp_servers.harness]\ncommand = "b"\n'), "ash", "都开着取规范名");
    // 往没声明的名字里塞 `-c` 会让 codex 整份配置起不来：认不出来的一律不注入。
    assert.equal(target('note = """\n[mcp_servers.ash]\n"""\n'), null, "多行字符串里的假表头不是登记");
    assert.equal(
      target('developer_instructions = """\nAn escaped triple quote: \\"""\n'
        + '[mcp_servers.ash]\ncommand = "node"\n"""\n[mcp_servers.kb]\ncommand = "node"\n'),
      null, "带转义三引号的示例更不许据此注入身份（第 5 轮 F2 的本体）");
    // **切不开才不注入**（第 5 轮 F2 + 第 2 轮 F1）：整份文本切不成语句时，认出来的可能是
    // 字符串里的示例；而「某处有疑问」不算 —— 那一档连别的命名空间里恰好叫 mcp_servers 的
    // 字段都算进去，真 codex 读得好好的、也接受这条 `-c`，上一版却把身份注入整个取消了。
    assert.equal(target('note = """\n[mcp_servers.ash]\ncommand = "node"\n'), null,
      "多行串到文件结尾还没收尾：切不开 ⇒ 不注入");
    assert.equal(target('[mcp_servers."ash]\ncommand = "node"\n'), null,
      "表头按 TOML 读不通：切不开 ⇒ 不注入");
    assert.equal(target('[mcp_servers.ash]\ncommand = "a"\n[mcp_servers.ash]\ncommand = "b"\n'), "ash",
      "重复定义 codex 会整份拒载，但那条 ash 是正面认出来的 —— 注入与否无差，不算「不可信」");
    for (const unrelated of [
      '[profiles.mcp_servers]\nmodel = "gpt"\n',
      '[model_providers.mcp_servers]\nbase_url = "http://x"\n',
      '[profiles.foo.mcp_servers]\nkb = { command = "uv" }\n',
      'profiles.mcp_servers.model = "gpt"\n',
    ]) {
      assert.equal(target(`[mcp_servers.ash]\ncommand = "node"\n${unrelated}`), "ash",
        `无关命名空间不许取消身份注入：${JSON.stringify(unrelated)}`);
    }
    assert.equal(target('[mcp_servers.kb]\ncommand = "uv"\n[projects."/x/ash"]\ntrust_level = "trusted"\n'), null);
    assert.equal(codexAshMcpServerName(join(stage, "no-such-home")), null, "没有配置文件");
  }

  // ── 2. codex 文件判据 ────────────────────────────────────────────────────
  const codexHome = join(stage, "codex");
  mkdirSync(codexHome, { recursive: true });
  const writeCodex = (toml: string) => writeFileSync(join(codexHome, "config.toml"), toml);
  {
    const inlineHome = join(stage, "codex-inline");
    mkdirSync(inlineHome, { recursive: true });
    const { codexInjectionTarget } = await import("../src/codex-toml.js");
    const { ashMcpRegistration } = await import("../src/auth/user-cli-mcp.js");
    const cases: [string, boolean][] = [
      ['tools = { get_task = { enabled = false } }', true],
      ['env = { ASH_NOTE = "enabled = false" }', true],
      ['some = { enabled = false }', true],
      ['note = "enabled = false, command = \\"fake\\""', true],
      ["note = 'enabled = false, command = \"fake\"'", true],
      ['args = ["enabled = false", "}", ","]', true],
      ['x_enabled = false', true],
      ['tools.get_task.enabled = false', true],
      ['"enabled.flag" = false', true],
      ['enabled = true, tools = { get_task = { enabled = false } }', true],
      ['"enabled" = false', false],
      ['enabled = false, tools = { get_task = { enabled = true } }', false],
    ];
    for (const [fields, enabled] of cases) {
      const config = `[mcp_servers]\nash = { command = "node", ${fields} }\n`;
      const scanned = scanCodexToml(config);
      assert.equal(scanned.doubt, null, fields);
      assert.equal(scanned.servers.get("ash")?.enabled, enabled, fields);
      assert.equal(scanned.servers.get("ash")?.spec.command, "node", fields);
      writeFileSync(join(inlineHome, "config.toml"), config);
      assert.equal(fileAshMcpVerdict("codex", { CODEX_HOME: inlineHome }, [undefined]).state,
        enabled ? "present" : "disabled", fields);
      assert.equal(ashMcpRegistration(inlineHome, "codex").state, enabled ? "present" : "disabled", fields);
      assert.equal(codexInjectionTarget(`${config}[mcp_servers.harness]\ncommand = "node"\n`),
        enabled ? "ash" : "harness", fields);
    }
    // 文件判据消费的是同一份扫描:无关命名空间在这里也不许把「有」降成「看不准」(第 2 轮 F1)。
    for (const unrelated of ['[profiles.mcp_servers]\nmodel = "gpt"\n', '[model_providers.mcp_servers]\nbase_url = "http://x"\n']) {
      writeFileSync(join(inlineHome, "config.toml"), `[mcp_servers.ash]\ncommand = "node"\n${unrelated}`);
      assert.equal(fileAshMcpVerdict("codex", { CODEX_HOME: inlineHome }, [undefined]).state, "present",
        `文件判据:${JSON.stringify(unrelated)}`);
      assert.equal(ashMcpRegistration(inlineHome, "codex").state, "present", `个人登记读取:${JSON.stringify(unrelated)}`);
    }
    const specs: [string, unknown][] = [
      ['some = { command = "fake", ASH_URL = "fake" }, command = "node", args = ["mcp.js", "a,b"], env = { nested = { ASH_URL = "fake" }, ASH_URL = "http://localhost:4317" }',
        { command: "node", args: ["mcp.js", "a,b"], ashUrl: "http://localhost:4317" }],
      ['note = \'command = "fake", ASH_URL = "fake"\', env = { nested = { ASH_URL = "fake" } }', {}],
      ['"command" = "node", env."ASH_URL" = "http://localhost:4317"',
        { command: "node", ashUrl: "http://localhost:4317" }],
      ['command = "node", "env.ASH_URL" = "fake"', { command: "node" }],
    ];
    for (const [fields, spec] of specs) {
      const scanned = scanCodexToml(`[mcp_servers]\nash = { ${fields} }\n`);
      assert.equal(scanned.doubt, null, fields);
      assert.deepEqual(scanned.servers.get("ash")?.spec, spec, fields);
    }
    assert.deepEqual(scanCodexToml('[mcp_servers.ash]\nenv = { nested = { ASH_URL = "fake" }, ASH_URL = "real" }\n')
      .servers.get("ash")?.spec, { ashUrl: "real" });
    for (const config of ['[mcp_servers]\nash = { command = "node"\n', '[mcp_servers.ash]\nenv = { broken }\n']) {
      assert.ok(scanCodexToml(config).doubt, "未识别的内联表不据此拦人");
    }
    console.log("✅ 内联表开关与启动字段只读取对应层级，四个消费口径一致");
  }
  {
    const env = { CODEX_HOME: codexHome };
    assert.equal(fileAshMcpVerdict("codex", env, [undefined]).state, "absent", "没有 config.toml = 没有登记");
    writeCodex('model = "x"\n[mcp_servers.linear]\ncommand = "y"\n');
    assert.equal(fileAshMcpVerdict("codex", env, [undefined]).state, "absent");
    writeCodex('[mcp_servers.ash]\ncommand = "node"\nenabled = false\n');
    assert.equal(fileAshMcpVerdict("codex", env, [undefined]).state, "disabled");
    writeCodex('[mcp_servers."ash"]\ncommand = "node"\n');
    assert.equal(fileAshMcpVerdict("codex", env, [undefined]).state, "present");
    writeCodex('note = """\n[mcp_servers.ash]\n"""\n');
    assert.equal(fileAshMcpVerdict("codex", env, [undefined]).state, "unknown", "扫描器没把握 ⇒ 判不了");
    // 审查复现的原样配置：接过别的 MCP、codex 记过这个仓库的信任。ash 一条都没有 ⇒ 确定没有，
    // 派审和启动自检两个出口都要说出来（新链第 3 轮第 1 条）。
    writeCodex('model = "gpt-5"\n\n[mcp_servers.kb]\ncommand = "uv"\nargs = ["run", "kb-mcp"]\n\n'
      + '[projects."/Users/champion/code/harness"]\ntrust_level = "trusted"\n');
    assert.equal(fileAshMcpVerdict("codex", env, [undefined]).state, "absent", "路径型表头不让整份配置失明");
    const { ashMcpRegistration: quickReg } = await import("../src/auth/user-cli-mcp.js");
    assert.equal(quickReg(codexHome, "codex").state, "absent", "启动自检的快速通道同样要说「没有」");

    // 项目里的 .codex/config.toml 提到 mcp_servers：合并规则不复刻，判不了。祖先目录也算。
    writeCodex('model = "x"\n');
    const proj = join(stage, "proj-codex");
    mkdirSync(join(proj, ".codex"), { recursive: true });
    mkdirSync(join(proj, "sub"), { recursive: true });
    writeFileSync(join(proj, ".codex", "config.toml"), '[mcp_servers.ash]\ncommand = "node"\n');
    assert.equal(fileAshMcpVerdict("codex", env, [join(proj, "sub")]).state, "unknown");
    assert.equal(fileAshMcpVerdict("codex", env, [undefined]).state, "absent", "不指定目录时不看项目");

    // 只看到 git 根为止（新链第 2 轮审查第 2 条；codex-cli 0.153 实测根外面的不读）。
    mkdirSync(join(proj, "repo", ".git"), { recursive: true });
    mkdirSync(join(proj, "repo", "sub"), { recursive: true });
    assert.equal(fileAshMcpVerdict("codex", env, [join(proj, "repo", "sub")]).state, "absent",
      "git 根外面那份 .codex/config.toml 这一轮不生效，不能替它下「判不了」");

    // CODEX_HOME 指到别处时，宿主 ~/.codex/config.toml 不是项目配置 —— 任务目录在 $HOME 下、
    // 一路没有 git 根也一样（审查证据 A 第 4 行就是这个形状）。
    // 外面套一层 git 根，让向上查找停在舞台里：Windows 的 %TEMP% 就在真实用户目录底下，
    // 不拦的话会一路走到**真实**的 `~/.codex/config.toml`（HOME 换掉之后它不再算宿主默认）。
    const homeBox = join(stage, "home-box");
    mkdirSync(join(homeBox, ".git"), { recursive: true });
    const fakeHome = join(homeBox, "fake-home");
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    mkdirSync(join(fakeHome, "work", "task"), { recursive: true });
    writeFileSync(join(fakeHome, ".codex", "config.toml"), '[mcp_servers.ash]\ncommand = "node"\n');
    const homeWas = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      assert.equal(fileAshMcpVerdict("codex", env, [join(fakeHome, "work", "task")]).state, "absent",
        "生效的是 CODEX_HOME 那份，宿主默认那份不构成证据");
    } finally {
      for (const [k, v] of Object.entries(homeWas)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      chmodSync(join(codexHome, "config.toml"), 0o000);
      assert.equal(fileAshMcpVerdict("codex", env, [undefined]).state, "unknown", "读不动 ≠ 没有");
      chmodSync(join(codexHome, "config.toml"), 0o644);
    }
  }

  // ── 3. claude 文件判据 ───────────────────────────────────────────────────
  const claudeDir = join(stage, "claude");
  mkdirSync(claudeDir, { recursive: true });
  const writeClaude = (doc: unknown) => writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify(doc));
  {
    const env = { CLAUDE_CONFIG_DIR: claudeDir };
    const proj = join(stage, "proj-claude");
    const deep = join(proj, "a", "b");
    mkdirSync(deep, { recursive: true });
    assert.equal(fileAshMcpVerdict("claude", env, [deep]).state, "absent", "没有 .claude.json = 没有登记");
    writeClaude({ mcpServers: { ash: { command: "node" } } });
    assert.equal(fileAshMcpVerdict("claude", env, [deep]).state, "present", "用户级");
    // 项目级登记的键按 claude 自己的规则算（2.1.283 实测，新链第 3 轮第 3 条）。
    const local = (key: string) =>
      writeClaude({ mcpServers: { other: {} }, projects: { [key]: { mcpServers: { harness: { command: "node" } } } } });
    local(proj);
    assert.equal(fileAshMcpVerdict("claude", env, [deep]).state, "absent",
      "不在 git 仓库里时键就是目录本身，祖先目录的登记 claude 不认");
    assert.equal(fileAshMcpVerdict("claude", env, [proj]).state, "present", "目录本身的键");
    assert.equal(fileAshMcpVerdict("claude", env, [undefined]).state, "absent", "宿主默认上下文看不到项目级");
    mkdirSync(join(proj, ".git"));
    assert.equal(fileAshMcpVerdict("claude", env, [deep]).state, "present", "在仓库里，键是 git 根");
    local(deep);
    assert.equal(fileAshMcpVerdict("claude", env, [deep]).state, "absent", "子目录自己的键 claude 不认");
    local(stage);
    assert.equal(fileAshMcpVerdict("claude", env, [deep]).state, "absent", "git 根外面祖先的键也不认");
    // worktree：认的是主仓那一条，worktree 自己路径的键不认（ash 的任务正是跑在 worktree 里）。
    const main = join(stage, "wt-main");
    const wt = join(stage, "wt-task");
    mkdirSync(join(main, ".git", "worktrees", "t"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "t", "commondir"), "../..\n");
    mkdirSync(join(wt, "sub"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "t")}\n`);
    local(main);
    assert.equal(fileAshMcpVerdict("claude", env, [join(wt, "sub")]).state, "present", "worktree 认主仓的键");
    local(wt);
    assert.equal(fileAshMcpVerdict("claude", env, [join(wt, "sub")]).state, "absent", "worktree 自己路径的键不认");
    // git 结构读不懂（子模块那种没有 commondir 的 gitdir）：算不出键，判不了。
    const odd = join(stage, "odd-sub");
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, ".git"), "gitdir: ../nowhere/modules/x\n");
    assert.equal(fileAshMcpVerdict("claude", env, [odd]).state, "unknown", "算不出键时不说「没有」");
    writeClaude({ mcpServers: {} });
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { ash: { command: "node" } } }));
    assert.equal(fileAshMcpVerdict("claude", env, [deep]).state, "unknown", ".mcp.json 要看审批状态，判不了");
    rmSync(join(proj, ".mcp.json"));
    // `.mcp.json` 跟项目级登记不同：git 根外面上层目录里的那份 claude 也读（实测 Pending
    // approval），所以这一份照旧一路看上去。
    writeFileSync(join(stage, ".mcp.json"), JSON.stringify({ mcpServers: { ash: { command: "node" } } }));
    assert.equal(fileAshMcpVerdict("claude", env, [deep]).state, "unknown", "git 根外面的 .mcp.json 也算");
    rmSync(join(stage, ".mcp.json"));
    writeFileSync(join(claudeDir, ".claude.json"), "{ 半截");
    assert.equal(fileAshMcpVerdict("claude", env, [deep]).state, "unknown", "解析不了 ≠ 没有");
    writeClaude({});
  }

  // ── 4. 端到端：派审预检在问不了 CLI 时按文件判 ─────────────────────────────
  // 假 CLI 被执行就留痕 —— 这一档**一个进程都不该起**。
  const binDir = join(stage, "bin");
  mkdirSync(binDir, { recursive: true });
  const ran = join(stage, "cli-ran");
  for (const name of ["codex", "claude"]) {
    if (process.platform === "win32") {
      writeFileSync(join(binDir, `${name}.cmd`), `@echo off\r\necho ran> "${ran}"\r\nexit /b 0\r\n`);
    } else {
      writeFileSync(join(binDir, name), `#!/bin/sh\necho ran > "${ran}"\n`);
      chmodSync(join(binDir, name), 0o755);
    }
  }
  const pathWas = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${pathWas ?? ""}`;
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const { ensureSchema, db } = await import("../src/db/index.js");
  await ensureSchema();
  const { ashMcpReachability, hostAshMcpGap } = await import("../src/ash-mcp-reachability.js");
  {
    writeCodex('model = "x"\n');
    const miss = await ashMcpReachability({ agentType: "codex" });
    assert.equal(miss.reachable, false, "问不了 CLI 时，配置里确定没有就要拦（第 1 条）");
    assert.match(miss.problem ?? "", /读配置文件得出/, "文案写明证据来源");
    assert.match(miss.problem ?? "", /ASH_KERNEL_CONFINE=0/, "文案带上问不了 CLI 的原因");
    writeCodex('[mcp_servers.ash]\ncommand = "node"\nenabled = false\n');
    assert.equal((await ashMcpReachability({ agentType: "codex" })).reachable, false, "关着也拦");
    writeCodex('[mcp_servers.ash]\ncommand = "node"\n');
    assert.equal((await ashMcpReachability({ agentType: "codex" })).reachable, true);
    writeCodex('note = """\n[mcp_servers.ash]\n"""\n');
    assert.equal((await ashMcpReachability({ agentType: "codex" })).reachable, true, "判不了就放行");

    // 登记只在项目的 .codex/config.toml 里：这一档判不了 ⇒ 放行，但执行器只往用户级那份里
    // 的登记注入回合身份 —— 至少说一句（新链第 5 轮审查第 3 条）。用户级有登记时不啰嗦。
    const projCodex = join(stage, "proj-codex");
    mkdirSync(join(projCodex, ".codex"), { recursive: true });
    writeFileSync(join(projCodex, ".codex", "config.toml"), '[mcp_servers.ash]\ncommand = "node"\n');
    writeCodex('model = "x"\n');
    const projOnly = await ashMcpReachability({ agentType: "codex", cwdCandidates: [projCodex] });
    assert.equal(projOnly.reachable, true, "项目里配了 mcp_servers ⇒ 判不了 ⇒ 放行");
    assert.match(projOnly.warning ?? "", /回合身份/, "但要说清身份注不进去的风险");
    writeCodex('[mcp_servers.ash]\ncommand = "node"\n');
    const both = await ashMcpReachability({ agentType: "codex", cwdCandidates: [projCodex] });
    assert.equal(both.reachable, true);
    assert.equal(both.warning, null, "用户级那份注得进去 ⇒ 没什么好提醒的");

    // 带 extraArgs：文件里看不到命令行覆盖，不下硬结论（同 claude 那条）。
    writeCodex('model = "x"\n');
    const { agents } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.insert(agents).values({
      id: "file-default", name: "codex-default", type: "codex", isDefault: true,
      extraArgs: JSON.stringify(["-cmcp_servers.ash.command=node"]),
    });
    assert.equal((await ashMcpReachability({ agentType: "codex" })).reachable, true,
      "profile 带了 -c 覆盖：文件那一档看不到它，必须放行");
    await db.delete(agents).where(eq(agents.id, "file-default"));

    // claude：用户级没有、候选目录里有项目级 ⇒ 放行；都没有 ⇒ 拦。
    const proj = join(stage, "proj-claude");
    writeClaude({ projects: { [proj]: { mcpServers: { ash: { command: "node" } } } } });
    assert.equal((await ashMcpReachability({ agentType: "claude", cwdCandidates: [proj] })).reachable, true);
    assert.equal((await ashMcpReachability({ agentType: "claude", cwdCandidates: [] })).reachable, false);
    writeClaude({});

    assert.ok(!existsSync(ran), "配置文件那一档一个进程都不该起");
  }

  // ── 5. 启动自检 ──────────────────────────────────────────────────────────
  {
    writeCodex('[mcp_servers.ash]\ncommand = "node"\nenabled = false\n');
    const gap = await hostAshMcpGap("codex");
    assert.ok(gap, "宿主配置里登记关着 ⇒ 启动自检必须点名");
    assert.equal(gap!.basis, "file", "问不了 CLI 的机器上，证据来源是配置文件");

    const { ashMcpRegistration } = await import("../src/auth/user-cli-mcp.js");
    assert.equal(ashMcpRegistration(codexHome, "codex").state, "disabled",
      "快速通道必须认出 enabled = false —— 上一版报成 present，启动自检直接放过（第 2 条）");
    writeCodex('[mcp_servers."ash"]\ncommand = "node"\n');
    assert.equal(ashMcpRegistration(codexHome, "codex").state, "present", "引号表头是合法登记");

    // 整条启动自检：关着的登记要出声，而且措辞要降一档（读配置得出、没经 CLI 确认）。
    writeCodex('[mcp_servers.ash]\ncommand = "node"\nenabled = false\n');
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
    try {
      const { sweepPersonalAshMcp } = await import("../src/auth/user-cli.js");
      await sweepPersonalAshMcp();
    } finally { console.warn = realWarn; }
    const all = warned.join("\n");
    assert.match(all, /ash MCP 登记/, `关着的登记必须出声：${all}`);
    assert.match(all, /没经 CLI 本人确认/, "证据来自配置文件时措辞要降档");
    assert.match(all, /enabled = false/, "点名到具体原因");

    // 装了 codex、从没写过 config.toml：派审门禁答「确实没有」，启动自检也必须出声
    // （新链第 2 轮审查第 3 条 —— 上一版拿「文件不存在」当「没用过这个 CLI」直接跳过）。
    rmSync(join(codexHome, "config.toml"));
    warned.length = 0;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
    try {
      const { sweepPersonalAshMcp } = await import("../src/auth/user-cli.js");
      await sweepPersonalAshMcp();
    } finally { console.warn = realWarn; }
    assert.match(warned.join("\n"), /codex（[^）]*config\.toml）：.*还不存在/,
      `配置文件还没建出来也要点名：${warned.join("\n")}`);
  }

  // ── 6. 登记在 ≠ 起得来：只出提示 ──────────────────────────────────────────
  {
    const { recordListeningPort } = await import("../src/listening-port.js");
    assert.equal(launchHint({ command: "node", args: [], ashUrl: "http://127.0.0.1:4317" }), null,
      "没 listen 过就不比端口（猜出来的端口只会制造假提示）");
    recordListeningPort(4399);
    const hint = launchHint({
      command: "definitely-not-a-real-bin-ash",
      args: [join(stage, "gone", "index.js")],
      ashUrl: "http://localhost:4317",
    });
    assert.match(hint ?? "", /找不到/, "command 解析不到要说");
    assert.match(hint ?? "", /不存在/, "指向的脚本不在要说");
    assert.match(hint ?? "", /4317.*4399/, "端口对不上要说");
    assert.match(hint ?? "", /没拦/, "明说只是提示");
    assert.equal(launchHint({ command: "node", args: [], ashUrl: "http://127.0.0.1:4399" }), null);

    // 端到端：放行，但带着提示。
    writeCodex('[mcp_servers.ash]\ncommand = "definitely-not-a-real-bin-ash"\n');
    const r = await ashMcpReachability({ agentType: "codex" });
    assert.equal(r.reachable, true, "起不来只是推断，不拦");
    assert.match(r.warning ?? "", /找不到/);

    const { claudeStatusHint } = await import("../src/ash-mcp-reachability.js");
    assert.equal(claudeStatusHint("ash:\n  Scope: User config\n  Status: ✔ Connected\n"), null);
    assert.match(claudeStatusHint("ash:\n  Status: ✘ Failed to connect\n") ?? "", /连不上/);
    assert.equal(claudeStatusHint("没有 Status 这一行\n"), null, "读不到就不说");
  }

  process.env.PATH = pathWas;
  console.log("✅ ash MCP 预检的配置文件那一档（扫描器 / 文件判据 / 端到端 / 启动自检 / 起法提示）通过");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
