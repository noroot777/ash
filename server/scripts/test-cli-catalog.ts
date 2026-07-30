// 智能体目录(server/src/executors/catalog/)的回归测试。
// B 阶段每个执行者改完自己的 spec 都该跑一遍:
//   npm -w server run test:cli-catalog
//
// 钉住的是「目录这层机制」的不变量,不是各 CLI 的参数对不对(那要本机实测):
//   ① 目录与 shared 的 AGENT_TYPES 严格一一对应,两张登记表(模型/思考强度)全键;
//   ② 每个 spec 的必填字段齐、prompt 声明自洽;
//   ③ 只有 claude 支持常驻会话 —— 「谁能当团队调度者」全靠 openResident 过滤;
//   ④ GenericCliExecutor 按 spec 装配出的命令行符合预期(含 model/effort/加速档/自带参数);
//   ⑤ resume 三档语义:未声明 → 忽略 sessionId 起新会话 + 诚实占位说明;
//   ⑥ 预检失败(bin 不在 PATH)必须由事件流报错并以 done 收尾 —— 少一个 done 就是任务卡死。
import assert from "node:assert/strict";
import type { AgentEvent } from "@harness/shared";
import { AGENT_TYPES, CLI_MODEL_PRESETS, REASONING_EFFORT_VALUES } from "@harness/shared";
import { CLI_SPECS, CLI_SPEC_BY_KEY } from "../src/executors/catalog/index.js";
import { GenericCliExecutor } from "../src/executors/generic.js";
import type { CliSpec } from "../src/executors/catalog/types.js";

const MISSING_BIN = "harness-definitely-not-installed-cli";

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

// ③ 常驻会话只有 claude —— 团队调度者的过滤就靠这一条,破了它下拉里会冒出跑不了的 CLI
const residentKeys = CLI_SPECS.filter((s) => {
  const ex = s.factory ? s.factory({}) : new GenericCliExecutor(s, {});
  return !!ex.openResident;
}).map((s) => s.key);
assert.deepEqual(residentKeys, ["claude"], "只有 claude 支持常驻会话(GenericCliExecutor 一律不实现)");

// 每个执行器的 type 必须等于自己的 key(展示、筛选、降级都按它认人)
for (const s of CLI_SPECS) {
  const ex = s.factory ? s.factory({}) : new GenericCliExecutor(s, {});
  assert.equal(ex.type, s.key, `${s.key}: 执行器 type 与目录 key 不一致`);
}

// ④ GenericCliExecutor 的命令行装配。用一个不存在的 bin:既拿到完整 commandLine,
// 又顺带验证预检失败路径(见 ⑥)。
const fake = (over: Partial<CliSpec["exec"]> = {}): CliSpec => ({
  key: "gemini", // 借一个已登记的 key,内容全部由下面的 exec 决定
  name: "Fake CLI",
  description: "测试用",
  bins: [MISSING_BIN],
  docsUrl: "https://example.com",
  installCommand: "echo noop",
  exec: { prompt: { via: "stdin" }, ...over },
});

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

// ⑤ resume 三档
{
  // (a) 未声明 session:忽略传进来的 sessionId、发一个新的,恢复命令给诚实说明
  const ex = new GenericCliExecutor(fake(), {});
  const h = ex.run({ prompt: "hi", cwd: process.cwd(), sessionId: "old-session" });
  assert.notEqual(h.sessionId, "old-session", "没有 resume 通道时不许假装接上旧会话");
  assert.match(h.sessionId, /^[0-9a-f-]{36}$/, "应生成一个新 sessionId 供追溯");
  assert.ok(!h.commandLine.includes("old-session"), "命令行里不该出现旧 sessionId");
  assert.match(ex.resumeCommand("/tmp", h.sessionId), /^# .*暂无已知的会话恢复命令/);
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

// 交互式恢复命令:声明了就带 cd 前缀,没声明就给说明(claude/codex/antigravity 保持原样)
assert.equal(
  new GenericCliExecutor(CLI_SPEC_BY_KEY.antigravity, {}).resumeCommand("/tmp/x", "sid"),
  "cd /tmp/x && antigravity --resume sid",
);

const collect = async (events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

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

console.log("cli catalog tests passed");
