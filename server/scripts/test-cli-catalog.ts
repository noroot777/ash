// 智能体目录(server/src/executors/catalog/)的回归测试。
// B 阶段每个执行者改完自己的 spec 都该跑一遍:
//   npm -w server run test:cli-catalog
//
// 钉住的是「目录这层机制」的不变量,不是各 CLI 的参数对不对(那要本机实测):
//   ① 目录与 shared 的 AGENT_TYPES 严格一一对应,两张登记表(模型/思考强度)全键;
//   ② 每个 spec 的必填字段齐、prompt 声明自洽;
//   ③ 只有 claude 支持常驻会话 —— 「谁能当团队调度者」全靠 openResident 过滤;
//   ④ GenericCliExecutor 按 spec 装配出的命令行符合预期(含 model/effort/加速档/自带参数);
//   ⑤ resume 三档语义:未声明 → 忽略 sessionId 起新会话 + 诚实占位说明;只写
//      interactive(拿不到 CLI 真实 id)一律不展示可执行的恢复命令;
//   ⑥ 预检失败(bin 不在 PATH)必须由事件流报错并以 done 收尾 —— 少一个 done 就是任务卡死;
//   ⑦ 备用命令名:检测命中 bins[1] 时执行也要用它(死认 bins[0] = 目录说可用、派任务 ENOENT);
//   ⑧ Grok 的 token 级 thought 必须按连续段聚合,不能在 UI 生成几百个「思考过程」。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import {
  CLI_MODEL_PRESETS,
  MODEL_EFFORT_RULES,
  REASONING_EFFORT_VALUES,
  normalizeReasoningEffort,
  reasoningEffortsFor,
  resolveReasoningEfforts,
} from "@harness/shared/cli-presets";
import { CLI_SPECS, CLI_SPEC_BY_KEY } from "../src/executors/catalog/index.js";
import { GenericCliExecutor, hasTrustedSessionId, interactiveResumeInner } from "../src/executors/generic.js";
import { execBinFor, probeBins } from "../src/executors/bin-probe.js";
import { resumeCommandFor } from "../src/executors/resume.js";
import { normalizeProfileExtraArgs } from "../src/executors/args.js";
import type { CliSpec } from "../src/executors/catalog/types.js";

const MISSING_BIN = "harness-definitely-not-installed-cli";

assert.deepEqual(
  normalizeProfileExtraArgs(["--settings ~/test/claude-settings.json"], { kind: "local" }),
  ["--settings", join(homedir(), "test/claude-settings.json")],
  "整段粘贴的 flag + 路径应拆成两个 argv，并展开本地 home",
);
assert.deepEqual(
  normalizeProfileExtraArgs([`--settings '{"fastMode": true}'`], { kind: "local" }),
  ["--settings", '{"fastMode": true}'],
  "带空格的引号值仍应保持为单个 argv",
);
assert.deepEqual(
  normalizeProfileExtraArgs(["--define=hello world"], { kind: "local" }),
  ["--define=hello world"],
  "带等号的单 token 不应被启发式拆分",
);

// ① 目录 ↔ AGENT_TYPES ↔ 两张登记表
assert.deepEqual(
  CLI_SPECS.map((s) => s.key),
  [...AGENT_TYPES],
  "目录顺序与 AGENT_TYPES 必须逐项一致(它就是展示顺序)",
);
for (const type of AGENT_TYPES) {
  assert.ok(CLI_SPEC_BY_KEY[type], `${type} 缺 spec`);
  assert.ok(Array.isArray(CLI_MODEL_PRESETS[type]), `${type} 没登记 CLI_MODEL_PRESETS`);
  assert.ok(Array.isArray(REASONING_EFFORT_VALUES[type]), `${type} 没登记 REASONING_EFFORT_VALUES`);
}

// ①b 档位按模型能力解析：规则写完整允许集合，不是只写一个 ceiling。这样既能表达
// codex 的连续档位，也能表达 anthropic 的 high/max、Haiku 的空集合等非连续/无档位情形。
const ruleIds = new Set<string>();
for (const rule of MODEL_EFFORT_RULES) {
  assert.ok(!ruleIds.has(rule.id), `模型 effort 规则 id 重复: ${rule.id}`);
  ruleIds.add(rule.id);
  assert.ok(rule.types.length > 0, `${rule.id}: 至少挂一个 CLI type`);
  assert.ok(rule.match.provider || rule.match.model, `${rule.id}: provider/model 至少写一个匹配条件`);
  for (const type of rule.types) {
    assert.ok(
      rule.efforts.every((effort) => REASONING_EFFORT_VALUES[type].includes(effort)),
      `${rule.id}: efforts 必须是 ${type} 档位并集的子集`,
    );
  }
}
assert.deepEqual(
  reasoningEffortsFor("codex", "gpt-5.5"),
  ["low", "medium", "high", "xhigh"],
  "gpt-5.5 顶到 xhigh:ultra/max 不能出现在候选里",
);
assert.deepEqual(
  reasoningEffortsFor("codex", "openai/gpt-5.5-codex"),
  ["low", "medium", "high", "xhigh"],
  "带 provider 前缀/后缀名的同一模型也要收窄",
);
assert.deepEqual(
  reasoningEffortsFor("codex", "gpt-5.6-sol"),
  ["low", "medium", "high", "xhigh", "ultra"],
  "gpt-5.6 系列恢复 ultra；未确认的 max 不应混进来",
);
assert.deepEqual(
  reasoningEffortsFor("opencode", "anthropic/claude-opus-4-8"),
  ["high", "max"],
  "多 provider CLI 必须保留 provider 语义，并支持非连续档位集合",
);
assert.deepEqual(
  reasoningEffortsFor("claude", "claude-haiku-4-5"),
  [],
  "无独立 effort 的模型应返回空集合，让 UI 跳过强度步骤",
);
assert.deepEqual(
  reasoningEffortsFor("antigravity", "gemini-3.6-flash-medium"),
  [],
  "强度已编码进 model slug 时不能再叠一层 effort",
);
assert.deepEqual(
  resolveReasoningEfforts("codex", "future-model").source,
  "cli-fallback",
  "未知模型要明确走 CLI 并集 fallback，不能伪装成已知能力",
);
assert.deepEqual(
  reasoningEffortsFor("codex", null),
  REASONING_EFFORT_VALUES.codex,
  "不知道模型时退回该 CLI 的并集",
);
assert.equal(
  normalizeReasoningEffort("codex", "gpt-5.5", "ultra"),
  null,
  "换模型后旧档位已不支持时要自动清回跟随 CLI",
);
assert.equal(
  normalizeReasoningEffort("codex", "gpt-5.6-sol", "ultra"),
  "ultra",
  "仍受新模型支持的档位必须保留",
);

// ② 每个 spec 的必填字段与自洽性
for (const s of CLI_SPECS) {
  assert.ok(s.bins.length > 0 && s.bins.every((b) => b && !b.includes(" ")), `${s.key}: bins 不合法`);
  assert.ok(s.name && s.description, `${s.key}: name/description 不能空`);
  assert.ok(/^https?:\/\//.test(s.docsUrl), `${s.key}: docsUrl 要是完整链接`);
  assert.ok(s.installCommand.trim(), `${s.key}: installCommand 不能空`);
  if (s.fallbackVersionMatch) assert.ok(s.bins.length > 1, `${s.key}: fallbackVersionMatch 只对备用 bin 有意义`);
  const p = s.exec.prompt;
  if (p.via === "flag") assert.ok(p.flag, `${s.key}: prompt.via="flag" 必须给 flag 名`);
  if (p.stdinArg) assert.equal(p.via, "stdin", `${s.key}: stdinArg 只在 via="stdin" 时有意义`);
  // untested 的必须留下「要核实什么」,否则 B 阶段接手的人只能重新猜一遍。
  if (s.untested) assert.ok((s.notes ?? "").length > 20, `${s.key}: 标了 untested 就得在 notes 里写清待核实的点`);
}

// ③ 常驻会话只有专用类实现 —— 团队调度者的过滤就靠这一条,破了它下拉里会冒出跑不了的 CLI。
// claude:进程级常驻(stdin 双向注入);codex:会话级常驻(每回合一个 `exec resume` 进程,
// 见 executors/codex-resident.ts)。GenericCliExecutor 一律不实现。
const residentKeys = CLI_SPECS.filter((s) => {
  const ex = s.factory ? s.factory({}) : new GenericCliExecutor(s, {});
  return !!ex.openResident;
}).map((s) => s.key);
assert.deepEqual(residentKeys, ["claude", "codex"], "只有 claude/codex 支持常驻会话(GenericCliExecutor 一律不实现)");

// 每个执行器的 type 必须等于自己的 key(展示、筛选、降级都按它认人)
for (const s of CLI_SPECS) {
  const ex = s.factory ? s.factory({}) : new GenericCliExecutor(s, {});
  assert.equal(ex.type, s.key, `${s.key}: 执行器 type 与目录 key 不一致`);
}

// ④ GenericCliExecutor 的命令行装配。用一个不存在的 bin:既拿到完整 commandLine,
// 又顺带验证预检失败路径(见 ⑥)。
const fake = (over: Partial<CliSpec["exec"]> = {}, entry: Partial<CliSpec> = {}): CliSpec => ({
  key: "gemini", // 借一个已登记的 key,内容全部由下面的 exec 决定
  name: "Fake CLI",
  description: "测试用",
  bins: [MISSING_BIN],
  docsUrl: "https://example.com",
  installCommand: "echo noop",
  ...entry,
  exec: { prompt: { via: "stdin" }, ...over },
});

// 收事件流直到 done。放在这里(而不是靠后)是因为下面的备用 bin 端到端用例要用。
const collect = async (events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

{
  const ex = new GenericCliExecutor(
    fake({
      subcommand: ["run"],
      baseArgs: ["--yolo"],
      prompt: { via: "flag", flag: "-p" },
      model: { flag: "-m" },
      reasoningEffort: (v) => ["-c", `effort="${v}"`],
      fastArgs: ["--fast"],
    }),
    { model: "m1", reasoningEffort: "high", speed: "fast", extraArgs: ["--extra"] },
  );
  const h = ex.run({ prompt: "hi there", cwd: process.cwd() });
  assert.equal(
    h.commandLine,
    `${MISSING_BIN} run --yolo -m m1 -c effort="high" --fast --extra -p hi there`,
    "装配顺序:subcommand → baseArgs → 会话 → model → effort → 加速档 → 自带参数 → prompt",
  );
  h.kill();
}

{
  // via:"stdin" + 占位位置参数(codex 的 `-`);speed 无 fastArgs 时静默忽略
  const ex = new GenericCliExecutor(fake({ baseArgs: ["--json"], prompt: { via: "stdin", stdinArg: "-" } }), {
    speed: "fast",
  });
  const h = ex.run({ prompt: "hi", cwd: process.cwd() });
  assert.equal(h.commandLine, `${MISSING_BIN} --json - <prompt via stdin>`);
  h.kill();
}

// 长 prompt 走 argv 时,展示用命令行只留个头 —— 它会存进 sessions.command_line
// 并在 UI 展示,原样带上等于把任务正文抄一遍进会话表。
{
  const long = "x".repeat(400);
  const h = new GenericCliExecutor(fake({ prompt: { via: "arg" } }), {}).run({ prompt: long, cwd: process.cwd() });
  assert.ok(!h.commandLine.includes(long), "长 prompt 不该原样进 commandLine");
  assert.ok(h.commandLine.includes("<prompt 共 400 字>"), "应标出被压掉的正文长度");
  h.kill();
}

// ⑤ resume 三档
{
  // (a) 未声明 session:忽略传进来的 sessionId、发一个新的,恢复命令给诚实说明
  const ex = new GenericCliExecutor(fake(), {});
  const h = ex.run({ prompt: "hi", cwd: process.cwd(), sessionId: "old-session" });
  assert.notEqual(h.sessionId, "old-session", "没有 resume 通道时不许假装接上旧会话");
  assert.match(h.sessionId, /^[0-9a-f-]{36}$/, "应生成一个新 sessionId 供追溯");
  assert.ok(!h.commandLine.includes("old-session"), "命令行里不该出现旧 sessionId");
  assert.match(ex.resumeCommand("/tmp", h.sessionId), /^# .*无法恢复会话/);
  h.kill();
}
{
  // (b) 声明了 newIdFlag:harness 自己发 id,resume 时按模板拼
  const spec = fake({ session: { newIdFlag: "--session-id", resumeArgs: (id) => ["--resume", id] } });
  const fresh = new GenericCliExecutor(spec, {}).run({ prompt: "hi", cwd: process.cwd() });
  assert.ok(fresh.commandLine.includes(`--session-id ${fresh.sessionId}`));
  fresh.kill();
  const cont = new GenericCliExecutor(spec, {}).run({ prompt: "hi", cwd: process.cwd(), sessionId: "sid-1" });
  assert.equal(cont.sessionId, "sid-1");
  assert.ok(cont.commandLine.includes("--resume sid-1"));
  cont.kill();
}
{
  // (c) 声明了 resumeArgs 但 id 由 CLI 自己产生:不占位假 id(靠 parser 回报)
  const ex = new GenericCliExecutor(fake({ session: { resumeArgs: (id) => ["resume", id] } }), {});
  const h = ex.run({ prompt: "hi", cwd: process.cwd() });
  assert.equal(h.sessionId, "", "CLI 自己产生 id 时不许写一个假 id 进 sessions 表");
  h.kill();
}

// ⑤bis 恢复命令的**诚实性**:只有「CLI 真认得这个 id」时才给可执行命令。
// 只写 interactive、却既没有 newIdFlag(我们把 id 告诉 CLI)也没有 resumeArgs
// (id 由 parser 回报)的 spec,拿到的 id 是纯 harness 侧记录,拼出来的
// `--resume <uuid>` 引用的是一个不存在的会话 —— 用户会当真复制去执行。
{
  const only = fake({ session: { interactive: (id) => `fake --resume ${id}` } });
  assert.equal(hasTrustedSessionId(only), false);
  assert.equal(interactiveResumeInner(only, "made-up"), null, "不可信的 id 不许拼成命令");
  const note = new GenericCliExecutor(only, {}).resumeCommand("/tmp/x", "made-up");
  assert.match(note, /^# /, "应退化成一句说明(以 # 开头,粘到终端也不会误执行)");
  assert.ok(!note.includes("fake --resume"), "说明里不能夹带那条命令");
  assert.match(note, /不能用来 --resume/, "要讲清为什么不能恢复");
  // 展示侧(会话详情的 resumeCommand)走同一个判定,不能各写一套。目录里真实存在
  // 这一档 —— 典型是 kiro:它有 `--resume-id` 无头通道,但首轮 id 由 CLI 产生、纯文本
  // 输出不回报,harness 捕获不到,所以刻意不声明 session。这里**动态挑**一个这样的
  // spec,不写死某个 key:B 阶段谁把自己那家的 id 通道查通了(antigravity 就是这么
  // 从这一档毕业的),这条断言都不该跟着炸。
  const untrusted = CLI_SPECS.find((s) => !hasTrustedSessionId(s));
  if (untrusted) {
    const shown = resumeCommandFor(untrusted.key, null, "/tmp/x", "made-up");
    assert.match(shown, /^# .*无法恢复会话/, `${untrusted.key}: 展示侧应退化成诚实说明`);
    assert.ok(!shown.includes("--resume made-up"), "展示侧同样不许拼出引用不存在会话的命令");
  }
}
{
  // 可信的两档照常给命令(claude 有 newIdFlag、codex 有 resumeArgs)
  assert.equal(resumeCommandFor("claude", null, "/tmp/x", "sid"), "cd /tmp/x && claude --resume sid");
  assert.equal(resumeCommandFor("codex", null, "/tmp/x", "sid"), "cd /tmp/x && codex resume sid");
  // 未知类型不再回落到 claude 的模板(那会给一条跑到别家 CLI 上的命令)
  assert.match(resumeCommandFor("no-such-cli", null, "/tmp/x", "sid"), /^# 未知的执行器类型/);
  // id 还没拿到时也不给命令
  assert.match(resumeCommandFor("codex", null, "/tmp/x", ""), /^# /);
}

// ⑤ter 备用命令名:检测能命中 bins[1],执行就必须用同一个 —— 死认 bins[0] 会让
// 「目录显示可用」的环境派任务稳定 ENOENT(cursor 的 agent、antigravity 的 agy)。
// 用真实存在的 `echo` 当备用名,断言不依赖本机装了哪些 CLI:
//   `echo --version` 会把参数原样打出来 → 版本自证含 "version" 通过、含 "cursor" 失败。
{
  const bins = ["harness-missing-primary-bin", "echo"];
  assert.equal(await execBinFor(fake({}, { bins })), "echo", "主 bin 缺失时应改用可用的备用名");
  assert.equal(
    await execBinFor(fake({}, { bins, fallbackVersionMatch: "version" })),
    "echo",
    "备用名 --version 自证通过就认",
  );
  assert.equal(
    await execBinFor(fake({}, { bins, fallbackVersionMatch: "definitely-not-in-version-output" })),
    undefined,
    "自证不过就当没探到(别把别家的命令认成自己)",
  );
  assert.equal(await execBinFor(fake({}, { bins }), { kind: "ssh", host: "h" }), undefined, "ssh 目标不拿本机结果去猜");
  assert.equal(await execBinFor(CLI_SPEC_BY_KEY.claude), undefined, "单候选的 spec 不做任何探测");

  // 端到端:主 bin 不在本机、备用名可用 → 照样跑得通(第 1 轮审查的复现场景)
  const spec = fake({ prompt: { via: "arg" } }, { bins });
  const ex = new GenericCliExecutor(spec, { bin: await execBinFor(spec) });
  const h = ex.run({ prompt: "fallback-works", cwd: process.cwd() });
  const events = await collect(h.events);
  assert.ok(!events.some((e) => e.kind === "error"), "备用 bin 可用时不该报找不到命令");
  assert.equal(
    events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join("").trim(),
    "fallback-works",
  );
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 });
}

// ⑤quater 版本自证必须跑「已解析出的绝对路径」,不是裸命令名。
// resolveBin 除 PATH 外还扫 EXTRA_PATHS(/opt/homebrew/bin、~/.local/bin、~/.bun/bin…),
// 那是给「从 GUI/预览启动 server、PATH 缺 Homebrew 目录」准备的。自证若用裸名,就会
// 「找得到文件、却证不了身份」—— cursor 的官方备用名 agent 在 GUI 环境下被误判不可用。
// 造场景:把 fixture 放进 ~/.local/bin(EXTRA_PATHS 之一)、再把 PATH 清成不含它,
// 于是只有走绝对路径才拿得到版本号。该目录不可写就跳过(别让测试依赖环境)。
{
  const dir = join(homedir(), ".local", "bin");
  const name = `harness-probe-fixture-${process.pid}`;
  const file = join(dir, name);
  let usable = false;
  try {
    writeFileSync(file, "#!/bin/sh\necho 'fixture-cli 1.2.3'\n", { mode: 0o755 });
    usable = true;
  } catch {
    console.log(`(跳过绝对路径自证用例:${dir} 不可写)`);
  }
  if (usable) {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-for-harness-test";
    try {
      const probe = await probeBins([name]);
      assert.ok(probe, "EXTRA_PATHS 里的命令必须能被探到(PATH 缺它也算装了)");
      assert.equal(probe!.path, file);
      assert.equal(probe!.version, "fixture-cli 1.2.3", "自证要跑绝对路径,裸命令名在这个 PATH 下必然拿不到版本");
      // 备用名的自证同理:PATH 缺目录时也得能证明身份,否则整项被判不可用
      const alt = await probeBins(["harness-missing-primary-bin", name], "fixture-cli");
      assert.equal(alt?.bin, name, "备用名在 PATH 缺目录时仍应自证通过");
    } finally {
      process.env.PATH = originalPath;
      rmSync(file, { force: true });
    }
  }
}

// ⑥ 预检失败:bin 不在 PATH。必须由事件流报出来并以 done 收尾 ——
// 抢在有监听者之前 emit 'error' 会变成 uncaughtException,任务永远卡 running。
{
  const h = new GenericCliExecutor(fake(), {}).run({ prompt: "hi", cwd: process.cwd() });
  const events = await collect(h.events);
  const err = events.find((e) => e.kind === "error");
  assert.ok(err && "message" in err && err.message.includes(MISSING_BIN), "应报出「找不到命令」");
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 1 }, "事件流必须以 done 收尾");
}

// 真跑一次:stdout 转文本事件 + exit 0 收尾(textParser 的正常路径)
{
  const ex = new GenericCliExecutor(fake({ prompt: { via: "arg" } }), { bin: "echo" });
  const h = ex.run({ prompt: "hello-generic", cwd: process.cwd() });
  const events = await collect(h.events);
  const text = events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join("");
  assert.equal(text.trim(), "hello-generic");
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 });
}

// 非 0 退出:报错文案带 exit 码,并且仍以 done 收尾
{
  const ex = new GenericCliExecutor(fake({ subcommand: ["-c", "echo boom >&2; exit 3"], prompt: { via: "stdin" } }), {
    bin: "sh",
  });
  const h = ex.run({ prompt: "", cwd: process.cwd() });
  const events = await collect(h.events);
  const err = events.find((e) => e.kind === "error");
  assert.ok(err && "message" in err && err.message.includes("exit 3") && err.message.includes("boom"));
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 3 });
}

// 手停:被杀掉不算故障,不该往时间线塞错误
{
  const ex = new GenericCliExecutor(fake({ subcommand: ["-c", "sleep 30"], prompt: { via: "stdin" } }), { bin: "sh" });
  const h = ex.run({ prompt: "", cwd: process.cwd() });
  setTimeout(() => h.kill(), 150);
  const events = await collect(h.events);
  assert.ok(!events.some((e) => e.kind === "error"), "手停不该报错");
  assert.equal(events.at(-1)?.kind, "done");
}

// ⑧ Grok 原始流一个 thought token 一行。连续 token 合成一段，正文和 end
// 都会收口；否则 377 个 token 就会在新版前端变成 377 个折叠块。
{
  const dir = mkdtempSync(join(tmpdir(), "harness-grok-stream-"));
  const script = join(dir, "stub.mjs");
  const lines = [
    { type: "thought", data: "first" },
    { type: "thought", data: " thought" },
    { type: "text", data: "answer" },
    { type: "thought", data: "second" },
    { type: "thought", data: " thought" },
    { type: "end", sessionId: "grok-session-1" },
  ];
  writeFileSync(
    script,
    lines.map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + "\n")});`).join("\n"),
  );
  try {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    const parser = CLI_SPEC_BY_KEY.grok.exec.parser!;
    const events = await collect(parser({
      child,
      bin: "grok",
      label: "grok@test",
      lifecycle: { stopRequested: false },
    }));
    assert.deepEqual(
      events.filter((event) => event.kind === "thinking"),
      [
        { kind: "thinking", text: "first thought" },
        { kind: "thinking", text: "second thought" },
      ],
      "每个连续 thought 段只应生成一个思考事件",
    );
    assert.deepEqual(events.filter((event) => event.kind === "text"), [{ kind: "text", text: "answer" }]);
    assert.ok(events.some((event) => event.kind === "session" && event.cliSessionId === "grok-session-1"));
    assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("cli catalog tests passed");
