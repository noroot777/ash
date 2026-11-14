// 「问 codex 本人要不要这份配置」那一关(`auth/codex-approve.ts`)的回归用例:先批准再发布、
// 批准期间别人存了东西、问不出来怎么收场、沙盘摆在哪、两种失败各记多久。
//
// 为什么单独一个文件:这一段十二格要搭的沙盘最重,而入口 `test-user-cli-mcp.ts` 已经顶到
// 单文件 700 行的上限(2026-10-31 审查 F3)。由那个文件调用,不是独立的回归入口 ——
// 共用脚手架在 `user-cli-mcp-bench.ts`。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAskOutcome } from "../src/auth/codex-approve.js";
import type { CodexAsk } from "../src/auth/user-cli-mcp.js";
import { DATA_DIR, REPO_DIR } from "../src/paths.js";
import { type Asked, bench, canned, ensure, askRealCodex, HAS_BUILT_MCP, HAS_CODEX, LISTS_ASH } from "./user-cli-mcp-bench.js";

export async function checkCodexApprove(): Promise<void> {
  // ⑱ **先批准再发布：验不过的那次，用户那份配置一个字节都没被动过**（本轮审查 F1）。
  //    上一版是「写进去 → 读回来 → 验不过再还原」：写完到还原之间崩一次，坏文件就留在那儿了，
  //    而还原本身又是第二次写，会把别人同时存下的设置一起盖掉。现在顺序倒过来，没有还原这一步。
  {
    // 宿主那条是**关着的**:不搬它,改用内置那条(2026-10-31 审查 F3 起跟 JSON 两族同口径 ——
    // 判据只有一处 `pickFact`,只认开着的那条;`test-ash-mcp-registry.ts` ⑩「关着的那条不许
    // 搬过来」是同一格)。上一版 TOML 这一族独自把那条关着的整段搬过去,拼完自己又读不出
    // 启用着的登记、于是报「没接好」:同一个现场,JSON 族写出内置那条、TOML 族什么都不写。
    // **隔离档是 ash 自己造的目录**,宿主那个 `enabled = false` 是用户给他自己那份 codex 下的;
    // 宿主那份我们一个位都不会动(那一格在 ⑤),这里不写就等于这个档的 agent 交不了卷。
    const { host, dir } = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nenabled = false\n` });
    const before = `model = "gpt"\n`;
    const file = join(dir, "config.toml");
    writeFileSync(file, before, "utf8");
    const state = await ensure(dir, "codex", host);
    assert.equal(state.configured, HAS_BUILT_MCP, "关着的不搬 ⇒ 改用内置那条(仓库没 build 就只能如实说补不上)");
    const written = readFileSync(file, "utf8");
    assert.ok(written.startsWith(before), "用户原有那几行原样留在前面");
    if (HAS_BUILT_MCP) {
      assert.match(written, /\[mcp_servers\.ash\]/, "补的是规范名那条");
      assert.ok(!/enabled = false/.test(written), "宿主那条关着的一个字都不许搬过来");
      assert.match(written, /mcp[\\/]dist[\\/]index\.js/, "搬不了就按内置那条渲染(指向本仓库的 MCP 入口)");
    } else {
      assert.equal(written, before, "没东西可搬、仓库也没 build ⇒ 一个字都不写");
    }

    // **没批准就一个字节都没写**:codex 看完候选说它仍然列不出 ash ⇒ 原文照旧、连 mtime
    // 都不变,原来压根没有那个文件时也不许被建出来(上一版是先建、再删)。
    const stillBlind: CodexAskOutcome = { kind: "answer", code: 0, stdout: "[]", stderr: "" };
    const refused = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n` });
    const refusedFile = join(refused.dir, "config.toml");
    writeFileSync(refusedFile, before, "utf8");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(refusedFile, past, past);
    const blocked = await ensure(refused.dir, "codex", refused.host, canned(stillBlind));
    assert.equal(blocked.configured, false, "codex 说补完仍看不到 ash ⇒ 不许报「已接好」");
    assert.equal(readFileSync(refusedFile, "utf8"), before, "原文照旧");
    assert.equal(statSync(refusedFile).mtimeMs, past.getTime(), "没批准就根本没写过 —— 连 mtime 都不该变");
    const second = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n` });
    assert.equal((await ensure(second.dir, "codex", second.host, canned(stillBlind))).configured, false);
    assert.equal(existsSync(join(second.dir, "config.toml")), false, "原来没有的文件不许被建出来");

    // 对照:宿主那条是开着的、codex 也收下了 → 落盘,如实报已接好。
    const third = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n` });
    writeFileSync(join(third.dir, "config.toml"), before, "utf8");
    assert.equal((await ensure(third.dir, "codex", third.host)).configured, true, "开着的照样补得上");
    assert.match(readFileSync(join(third.dir, "config.toml"), "utf8"), /\[mcp_servers\.ash\]/);
  }

  // ⑲ **整张 mcp_servers 写成内联值时一个字都不许写**（第 2 轮审查 F1）：我们唯一会写的东西
  //    是追加一段 `[mcp_servers.ash]`，而 TOML 不许用表头扩展一个已经定义成内联值的表 ——
  //    真机实测 codex 报 `cannot extend value of type inline table with a dotted key` 并整份
  //    拒载，用户别的 MCP 一起加载不了。认得出登记的那一半同样重要：根内联里有 ash 就别写。
  {
    const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
    // ① 根内联里确实没有 ash：缺是真的，但这份文件不能这么补 —— 如实报，并说清两种改法。
    const noAsh = `mcp_servers = { kb = { command = "node" } }\n`;
    {
      const { host, dir } = bench({ codex: HOST });
      const file = join(dir, "config.toml");
      writeFileSync(file, noAsh, "utf8");
      const state = await ensure(dir, "codex", host);
      assert.equal(state.configured, false, "补不了就不许报「已接好」");
      assert.match(state.problem ?? "", /内联/, "要说清是内联表挡住了");
      assert.match(state.problem ?? "", /普通表写法|自己加一条/, "要给得出改法");
      assert.equal(readFileSync(file, "utf8"), noAsh, "一个字都不许写 —— 写了就是整份拒载");
    }
    // ② 根内联里已经有 ash（codex 认得、`-c` 也落得上去）：认出来，更不该追加。
    for (const existing of [
      `mcp_servers = { ash = { command = "node" } }\n`,
      `mcp_servers = { "\\u0061sh" = { command = "node" } }\n`,
    ]) {
      const { host, dir } = bench({ codex: HOST });
      const file = join(dir, "config.toml");
      writeFileSync(file, existing, "utf8");
      const state = await ensure(dir, "codex", host);
      assert.equal(state.configured, true, `根内联登记要认得出：${JSON.stringify(existing)}`);
      assert.equal(readFileSync(file, "utf8"), existing, "认出来了就一个字都不写");
    }
  }

  // ⑳ **判官是 codex 本人,而且问的是沙盘里的副本**（本轮审查 F1）：我们那份是**结构**扫描器，
  //    看得出新表头落进了文件里，证不了它在这份 TOML 上合法。这里拿一种真实形状把差别摆出来 ——
  //    宿主那条登记的 env 值里有个不合法转义（`"http://bad\q"`），拼完扫描器照样答「ash 在、
  //    启用着」，而真 codex 整份拒载（实测 rc=1 `missing escaped value`）。要的行为是：**一个
  //    字节都不写**、如实报、给得出手工办法，而且同一份组合不再问第二遍（设置页每读一次、每条
  //    任务起跑都会走到这里，不该为同一个已知答案反复起进程）。
  {
    const BAD_HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/x.js"]\n\n`
      + `[mcp_servers.ash.env]\nASH_URL = "http://bad\\q"\n`;
    const { host, dir } = bench({ codex: BAD_HOST });
    const file = join(dir, "config.toml");
    const before = `model = "gpt"\n`;
    writeFileSync(file, before, "utf8");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(file, past, past);
    const state = await ensure(dir, "codex", host, askRealCodex);
    if (HAS_CODEX) {
      assert.equal(state.configured, false, "codex 读不动这份候选 ⇒ 不许报「已接好」");
      assert.match(state.problem ?? "", /codex 读不动|仍然没列出|关着的/, `要说清是 codex 那边的结论：${state.problem}`);
      assert.equal(readFileSync(file, "utf8"), before, "没批准 ⇒ 没写");
      assert.equal(statSync(file).mtimeMs, past.getTime(), "连 mtime 都不该变");
      assert.match(state.problem ?? "", /手工/, "补不上就得给办法");
      const again = await ensure(dir, "codex", host, async () => {
        throw new Error("同一份组合不该再问 codex 第二遍");
      });
      assert.equal(again.configured, false, "失败过的组合照样报失败");
      assert.equal(statSync(file).mtimeMs, past.getTime(), "第二次也一个字节都不该动");
    } else {
      console.log("⚠ 没装 codex，跳过「真 codex 判决」那一条");
      assert.equal(state.configured, false, "问不动 codex ⇒ 不补接（不拿「问不出来」当批准）");
    }
  }

  // ㉑ **「问不出来」不等于「可以发布」**（本轮审查 F1 的本体）：上一版把超时、起不来、输出
  //    看不懂都当成「可以留着」—— 真机实测那正是「界面报已接好、下次启动 codex 整份拒载」的
  //    那一格。四种答不出来的收场在这里一次过齐，判据只有一条：**没批准就没写**。
  {
    const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
    const cases: { why: string; outcome: CodexAskOutcome; expect: RegExp }[] = [
      { why: "起不来(没装 codex、spawn 失败)", outcome: { kind: "not-started", why: "这台机器上找不到 codex" }, expect: /起不了 codex/ },
      { why: "超时/被打断", outcome: { kind: "unqueryable" }, expect: /没给出一份能用的答案/ },
      { why: "退出码 0 但输出不是 JSON", outcome: { kind: "answer", code: 0, stdout: "Listing MCP servers…", stderr: "" }, expect: /输出看不懂/ },
      { why: "退出码 0、是列表但没列出 ash", outcome: { kind: "answer", code: 0, stdout: "[]", stderr: "" }, expect: /仍然没列出/ },
    ];
    for (const { why, outcome, expect } of cases) {
      const { host, dir } = bench({ codex: HOST });
      const file = join(dir, "config.toml");
      const before = `model = "gpt"\n`;
      writeFileSync(file, before, "utf8");
      const past = new Date("2020-01-01T00:00:00Z");
      utimesSync(file, past, past);
      const state = await ensure(dir, "codex", host, canned(outcome));
      assert.equal(state.configured, false, `${why}:不许报「已接好」`);
      assert.match(state.problem ?? "", expect, `${why}:要说清为什么没接上 —— ${state.problem}`);
      assert.match(state.problem ?? "", /手工/, `${why}:补不上就得给办法`);
      assert.ok(state.problem?.includes("[mcp_servers.ash]"), `${why}:办法里要带上那段内容`);
      assert.equal(readFileSync(file, "utf8"), before, `${why}:用户那份配置一个字节都不许动`);
      assert.equal(statSync(file).mtimeMs, past.getTime(), `${why}:连 mtime 都不该变`);
    }
  }

  // ㉒ **问的是沙盘里的一份副本,不是用户那个文件**（本轮审查 F1）：批准之前用户那份配置必须
  //    还是原样 —— 上一版正是「先写进去再问」，问的那十秒里盘上躺着的是一份 codex 整份拒载的
  //    配置，中间崩一次就留在那儿了。
  {
    const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
    const { host, dir } = bench({ codex: HOST });
    const file = join(dir, "config.toml");
    const before = `model = "gpt"\n`;
    writeFileSync(file, before, "utf8");
    const log: Asked[] = [];
    const state = await ensure(dir, "codex", host, canned(LISTS_ASH, log, file));
    assert.equal(state.configured, true);
    assert.equal(log.length, 1, "一次补接只问一遍");
    assert.notEqual(log[0]!.sandbox, dir, "问的得是另一个目录,不是用户的配置目录");
    assert.equal(log[0]!.userFile, before, "问的时候用户那份配置还是原样");
    assert.match(log[0]!.candidate, /\[mcp_servers\.ash\]/, "沙盘里放的是拼好的候选内容");
    assert.ok(log[0]!.candidate.includes(before), "候选 = 原文 + 那段,不是只剩那段");
    assert.equal(readFileSync(file, "utf8"), log[0]!.candidate, "批准之后落盘的就是批准过的那一份");
    assert.ok(!existsSync(log[0]!.sandbox), "问完沙盘要清掉");
  }

  // ㉓ **这一问不许在 server 里同步 spawn**（本轮审查 F2）：那样起的进程没有归属、收不回来
  //    （Windows 真机实测包装退出后查询还活着），而同步调用期间整个 server 的事件循环被堵住。
  //    唯一许可的起法是探测执行层。替身住在**测试文件**里,产品代码里一个都不许有。
  //
  //    2026-10-31 这一条跟着代码搬了家:补登记现在是十五家 CLI 通用的一份实现
  //    (`mcp-registry/register.ts` + `auth/config-publish.ts`),问 codex 本人那一关单独住在
  //    `auth/codex-approve.ts`。断言因此改成**整条写入链逐个文件查** —— 只盯原来那一个文件的话,
  //    往新文件里写一句 spawnSync 就没人拦得住了。
  {
    const CHAIN = [
      join("auth", "user-cli-mcp.ts"),
      join("auth", "config-publish.ts"),
      join("auth", "codex-approve.ts"),
      join("mcp-registry", "register.ts"),
      join("mcp-registry", "shapes.ts"),
      join("mcp-registry", "catalog.ts"),
    ];
    // 注释里会提到旧写法(「上一版用的是 spawnSync」),按行剥掉注释再看代码本身。
    const codeOf = (rel: string) => readFileSync(join(REPO_DIR, "server", "src", rel), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const rel of CHAIN.filter((r) => !r.endsWith("codex-approve.ts"))) {
      assert.ok(!/spawnSync\(|\bspawn\(|execFile|execSync/.test(codeOf(rel)),
        `${rel}：写入侧不许自己起进程 —— 问 codex 那一问只在 codex-approve.ts 里`);
    }
    // 那一问本身:异步、带超时,命令经 resolveLaunch 解析(Windows 上的 .cmd 垫片由它决定怎么起)。
    const askCode = codeOf(join("auth", "codex-approve.ts"));
    assert.ok(!/spawnSync\(|execSync|execFileSync/.test(askCode), "问 codex 本人那一问不许同步起进程(会堵住事件循环)");
    assert.ok(/resolveLaunch\(/.test(askCode) && /timeout:/.test(askCode), "问 codex 本人那一问要经 resolveLaunch、带超时");
  }

  // ㉔ **批准期间别人存了新东西,不许被盖掉**（第 2 轮审查 F1）：批准那一问要起一次 codex、
  //    秒级,这期间用户完全可能在另一处存下新模型、加上自己的 MCP。上一版拿批准过的**旧快照**
  //    整份盖下去,那些改动当场消失、函数照样答「已接好」。要的行为:盘上内容一变就整条重做 ——
  //    重新读、在**新内容**上重新拼、重新批准,于是别人那次改动天然留在结果里。
  {
    const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
    const { host, dir } = bench({ codex: HOST });
    const file = join(dir, "config.toml");
    const before = `model = "gpt"\n`;
    writeFileSync(file, before, "utf8");
    const SAVED_MEANWHILE = `model = "gpt-5"\n\n[mcp_servers.user_added]\ncommand = "uv"\n`;
    let asked = 0;
    const state = await ensure(dir, "codex", host, async () => {
      // 第一问这十秒里,用户在设置页里按了保存。
      if (++asked === 1) writeFileSync(file, SAVED_MEANWHILE, "utf8");
      return LISTS_ASH;
    });
    assert.equal(state.configured, true, "重做一轮照样要接上");
    assert.equal(asked, 2, "内容变了就得在新内容上重新批准一遍,不许拿旧批准硬写");
    const final = readFileSync(file, "utf8");
    assert.ok(final.includes(`model = "gpt-5"`), "别人存的新模型不许被盖回去");
    assert.ok(final.includes("[mcp_servers.user_added]"), "别人加的 MCP 不许消失");
    assert.match(final, /\[mcp_servers\.ash\]/, "ash 还是要接上");
  }

  // ㉕ **一直撞上就如实说没写**（第 2 轮审查 F1 的另一半）：重做不能无限转,也不能为了「接上」
  //    去盖掉别人正在写的东西。判据只有一条:**这次什么都没写**,而且说得出为什么。
  {
    const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
    const { host, dir } = bench({ codex: HOST });
    const file = join(dir, "config.toml");
    writeFileSync(file, `model = "gpt"\n`, "utf8");
    let asked = 0;
    const state = await ensure(dir, "codex", host, async () => {
      writeFileSync(file, `model = "round-${++asked}"\n`, "utf8"); // 每一轮都被改掉
      return LISTS_ASH;
    });
    assert.equal(state.configured, false, "没落定就不许报「已接好」");
    assert.match(state.problem ?? "", /一直有别的程序在改/, `要说清是撞上了：${state.problem}`);
    assert.equal(readFileSync(file, "utf8"), `model = "round-${asked}"\n`, "盘上留着的是别人最后那次写的,不是我们的");
    assert.ok(!readFileSync(file, "utf8").includes("mcp_servers"), "一个字节都没写进去");
  }

  // ㉖ **沙盘要放在任何项目配置的祖先链之外**（第 2 轮审查 F2）：codex 读配置会**沿 cwd 往上
  //    合并**每一层的 `.codex/config.toml`。上一版为了躲开 codex 对 `%TEMP%` 的那句 PATH 抱怨
  //    把沙盘挪进了 `DATA_DIR/tmp` —— 那在 ash 自己的检出里,批准那一问于是连着仓库里的配置一起
  //    读,判的不再是「用户那份加上这段行不行」。那句抱怨改成从原因里剥掉(见下一格)。
  {
    const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
    const { host, dir } = bench({ codex: HOST });
    writeFileSync(join(dir, "config.toml"), `model = "gpt"\n`, "utf8");
    const log: Asked[] = [];
    const state = await ensure(dir, "codex", host, canned(LISTS_ASH, log));
    assert.equal(state.configured, true);
    const sandbox = log[0]!.sandbox;
    for (const ancestor of [REPO_DIR, DATA_DIR]) {
      assert.ok(!sandbox.startsWith(ancestor), `沙盘不许落在 ${ancestor} 底下 —— 那条祖先链会被一起读进来`);
    }
    // 问 codex 那一关 2026-10-31 搬进了 `auth/codex-approve.ts`,断言跟着它走。
    const code = readFileSync(join(REPO_DIR, "server", "src", "auth", "codex-approve.ts"), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.ok(/mkdtempSync\(join\(tmpdir\(\)/.test(code), "沙盘建在系统临时目录里");
    assert.ok(!/mkdtempSync\(join\(DATA_DIR/.test(code), "不许再挪回 DATA_DIR（那是 ash 检出的一部分）");
  }

  // ㉗ **codex 对临时目录的那句 PATH 抱怨不是失败原因**（第 2 轮审查 F2）：`CODEX_HOME` 在
  //    `%TEMP%` 底下时它会先喊一句「拒绝在临时目录里建帮手程序」(Windows 真机实测,退出码照样 0)。
  //    那句话混进报给用户的原因里只会把人带偏,所以挑原因的时候把 `WARNING:` 开头的行剥掉。
  {
    const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
    const { host, dir } = bench({ codex: HOST });
    const file = join(dir, "config.toml");
    const before = `model = "gpt"\n`;
    writeFileSync(file, before, "utf8");
    const noisy: CodexAskOutcome = {
      kind: "answer", code: 1, stdout: "",
      stderr: "WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir\n"
        + "missing escaped value at line 7 column 12\n",
    };
    const state = await ensure(dir, "codex", host, canned(noisy));
    assert.equal(state.configured, false);
    assert.ok(state.problem!.includes("missing escaped value"), `真正的原因要报出来：${state.problem}`);
    assert.ok(!/WARNING|PATH aliases/.test(state.problem!), `那句抱怨不该出现在原因里：${state.problem}`);
    assert.equal(readFileSync(file, "utf8"), before, "读不动就一个字节都不写");
  }

  // ㉘ **沙盘没删干净不许翻掉已经成立的判决**（第 2 轮审查 N7）：codex 退出后那个目录偶尔还被
  //    占着(Windows 真机上撞过 EBUSY)。清不掉只是留个垃圾,跟「codex 认不认这份配置」毫无关系 ——
  //    上一版让它把判决整个翻成失败,于是补接在能接的机器上随机不接。
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
    const { host, dir } = bench({ codex: HOST });
    writeFileSync(join(dir, "config.toml"), `model = "gpt"\n`, "utf8");
    let stuck: string | null = null;
    const state = await ensure(dir, "codex", host, async (sandbox) => {
      stuck = join(sandbox, "locked");
      mkdirSync(stuck);
      chmodSync(stuck, 0o000); // 里头读不进去 ⇒ 递归删会失败
      return LISTS_ASH;
    });
    assert.equal(state.configured, true, "清不掉沙盘不影响「codex 收下了」这个结论");
    assert.match(readFileSync(join(dir, "config.toml"), "utf8"), /\[mcp_servers\.ash\]/, "该写的照样写");
    chmodSync(stuck!, 0o700);
    rmSync(join(stuck!, ".."), { recursive: true, force: true });
  } else {
    console.log("⚠ Windows/root 下 chmod 拦不住删除，跳过「沙盘清不掉」那一格");
  }

  // ㉙ **两种失败的记性不一样长**（第 2 轮审查 N6）：设置页每读一次、每条任务起跑都会走到这里,
  //    同一个已知答案不该反复起 codex。但「问不出来」(没装 codex、超时)是会自己好的 ——
  //    记死了就等于装好 codex 也得重启 ash 才认。所以:**内容本身的毛病记死**(内容一变键就变了),
  //    **问不出来只记一小会儿**。这里把钟往前拨来跨过那一小会儿。
  {
    const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
    const BOOM: CodexAsk = async () => { throw new Error("这一格不该再问 codex"); };
    const realNow = Date.now;
    const jump = (ms: number) => { Date.now = () => realNow() + ms; };
    try {
      // 内容的毛病:拨多久都不再问。
      {
        const { host, dir } = bench({ codex: HOST });
        writeFileSync(join(dir, "config.toml"), `model = "gpt"\n`, "utf8");
        const bad: CodexAskOutcome = { kind: "answer", code: 1, stdout: "", stderr: "missing escaped value\n" };
        assert.equal((await ensure(dir, "codex", host, canned(bad))).configured, false);
        jump(86_400_000);
        const again = await ensure(dir, "codex", host, BOOM);
        assert.equal(again.configured, false, "内容没变、毛病也就没变,照样报失败");
        assert.ok(again.problem!.includes("missing escaped value"), "报的还是那条原因");
      }
      // 问不出来:过一会儿要肯再问一次,而且这次能接上。
      {
        Date.now = realNow;
        const { host, dir } = bench({ codex: HOST });
        const file = join(dir, "config.toml");
        writeFileSync(file, `model = "gpt"\n`, "utf8");
        const dead: CodexAskOutcome = { kind: "not-started", why: "这台机器上找不到 codex" };
        assert.equal((await ensure(dir, "codex", host, canned(dead))).configured, false);
        assert.equal((await ensure(dir, "codex", host, BOOM)).configured, false, "紧接着再问一遍不该又起一次 codex");
        jump(120_000);
        const healed = await ensure(dir, "codex", host, canned(LISTS_ASH));
        assert.equal(healed.configured, true, "装好 codex 之后不该还得重启 ash 才认");
        assert.match(readFileSync(file, "utf8"), /\[mcp_servers\.ash\]/);
      }
    } finally {
      Date.now = realNow;
    }
  }
}
