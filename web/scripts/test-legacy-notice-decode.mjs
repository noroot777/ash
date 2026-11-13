// 没有类型的老记录里，夹着你写的字的那几句（工作流跑的命令、验收前置命令的摘要）怎么认成败。
// 记录一律拿服务端那份生成函数（@ash/shared/command-note）造，再走一遍读进来、展示前归一的整条链：
// 引文写什么都只能让结果变成「认不出」，不会把成败认反，也不会被认成审查轮、待裁定这些别的事。
import assert from "node:assert/strict";
import { commandFailedNote, commandPassedNote } from "@ash/shared/command-note";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { commandVerdict, legacyTier } from "../src/task-detail/legacyNoticeTable.ts";
import { noticeView } from "../src/task-detail/timelineNoticeCopy.ts";

const UNKNOWN = "跑了一条命令，老记录里认不出它通过没有";
const ran = (text, commands) => noticeView({ text, tone: "neutral", variant: "note" }, { commands });

// —— 直接认字面：切得出来就认，切不出来就说认不出，给了工作流里写的命令就逐字对上 ——
const okMultiline = "跑了一条命令：`printf '%s\\n' '`（没通过）\n只是文字'`（通过）\n执行输出";
const failMultiline = "跑了一条命令：`printf '%s\\n' '`（通过）\n只是文字'; exit 1`（没通过）\n只是文字";
const failQuotingPass = "跑了一条命令：`npm test`（没通过）\n输出里有一行：`（通过）";
for (const text of [okMultiline, failMultiline, failQuotingPass]) {
  assert.deepEqual(
    (({ tier, tone, text: said, detail }) => [tier, tone, said, detail])(ran(text)),
    ["alert", "warn", UNKNOWN, text],
    `切不出来的那一句不替它猜成败：${text.slice(0, 30)}…`,
  );
}
assert.equal(ran(okMultiline, ["printf '%s\\n' '`（没通过）\n只是文字'"]).tier, "receipt", "对上了工作流里的命令：成功就是回执");
assert.equal(ran(failMultiline, ["printf '%s\\n' '`（通过）\n只是文字'; exit 1"]).tier, "alert", "对上了工作流里的命令：失败就是提醒");
assert.equal(ran(failQuotingPass, ["npm test"]).tier, "alert");
assert.equal(ran(okMultiline, ["npm test"]).text, UNKNOWN, "对不上的命令不拿来猜");
assert.equal(ran("跑了一条命令：`npm test`（通过）").tier, "receipt");
assert.equal(ran("跑了一条命令：`npm test`（没通过）\n命令失败").tier, "alert");
// 输出里引了一段「`（没通过）」、停在最后：跟「命令多写了这一截、跑挂了只吐空白」那一条字字相同。
const passedQuotingFail = "跑了一条命令：`printf '%s\\n' '`（没通过）只是文字'`（通过）\n`（没通过）";
assert.equal(ran(passedQuotingFail).text, UNKNOWN, "两种都可能：认不出");
assert.equal(ran(passedQuotingFail, ["printf '%s\\n' '`（没通过）只是文字'"]).tier, "receipt");
assert.equal(ran(passedQuotingFail, ["printf '%s\\n' '`（没通过）只是文字'`（通过）\n"]).tier, "alert");
const passedQuotingNote = "跑了一条命令：`npm test`（通过）\n输出里有一行：跑了一条命令：`x`（没通过）";
assert.equal(ran(passedQuotingNote).text, UNKNOWN);
assert.equal(ran(passedQuotingNote, ["npm test"]).tier, "receipt");
assert.equal(commandVerdict("跑了一条命令：`npm test"), "unknown", "起头是命令那一句、一种切法都列不出来：认不出，不落回执");
assert.equal(ran("跑了一条命令：`npm test").text, UNKNOWN);

// —— 第 2 轮审查实跑的两条：只吐一个空格、以退出码 1 结束 ——
// 空格不算「没输出」，原因裁完是空串，那句话以「（没通过）\n」结尾，展示前再裁成「（没通过）」。
const blank = commandFailedNote(`printf " "; exit 1`, { stdout: " ", stderr: "", message: "Command failed" }, 30).text;
assert.ok(blank.endsWith("（没通过）\n"), "生成那一头确实会写出空原因");
assert.equal(commandVerdict(blank), "failed");
assert.equal(ran(blank).tier, "alert", "空原因的失败要摆出来");
const quotingCmd = "printf ' ';#`（通过）\nfalse";
const quoting = commandFailedNote(quotingCmd, { stdout: " ", stderr: "", message: "Command failed" }, 30).text;
assert.equal(ran(quoting).text, UNKNOWN, "命令里引了「`（通过）」、原因又是空的：没有工作流命令可对就认不出");
assert.equal(ran(quoting, [quotingCmd]).tier, "alert", "给了真命令：认成失败");
assert.notEqual(ran(quoting, [quotingCmd]).text, UNKNOWN);

// —— 命令里写的别的说法：不当成审查轮、待裁定、工作区恢复 ——
for (const cmd of ["echo 自由工作流第 2 轮审查通过; false", "echo 第 1 轮审查开始; false", "echo 现在由你裁定：; false",
  "echo 原工作目录(worktree 与分支)已不存在 已重建为空目录; false"]) {
  const text = commandFailedNote(cmd, { stdout: "", stderr: "boom" }, 30).text;
  const [item] = items(text);
  assert.equal(item.verify, false, `命令里的「审查」字样不是审查轮：${cmd}`);
  const view = noticeView(item, { commands: [cmd] });
  assert.deepEqual([view.tier, view.topic, view.dispute], ["alert", "other", false], `命令里的说法不改它是一条没通过的命令：${cmd}`);
}

// —— 不变量：服务端可能写出的每一种记录，读进来、归一、展示以后 ——
// 没通过的一定是提醒（认不出也是提醒）；通过的要么是回执、要么认不出；给了真命令就一定认对。
function items(text) {
  const session = { id: "s1", taskId: "t1", agentType: "codex", role: "main", startedAt: "2026-08-10T03:23:00.000Z" };
  const output = ["回合说的话。", `\x1e${JSON.stringify({ t: "system", text, at: "2026-08-10T03:27:00.000Z", aside: true })}`].join("\n");
  return buildConversationItems([{ session, output, trace: [] }], [session], []).filter((item) => item.kind === "event");
}
const pieces = ["`（通过）", "`（没通过）", "\n", " ", "\t", "a", "`", "（", "` 通过（rc=0）。", "` 未通过：超时", "。",
  " http://localhost:3000/x", "第 2 轮审查通过", "现在由你裁定：", "〔系统〕"];
let seed = 7;
const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed >>> 8; };
const junk = (min = 0) => Array.from({ length: min + (next() % 6) }, () => pieces[next() % pieces.length]).join("");
let unknown = 0;
for (let i = 0; i < 4000; i += 1) {
  const cmd = `x${junk()}`;
  const stdout = junk();
  const stderr = next() % 3 ? "" : junk();
  const passed = i % 2 === 0;
  const text = passed
    ? commandPassedNote(cmd, stdout, stderr)
    : commandFailedNote(cmd, { stdout, stderr, message: next() % 2 ? "Command failed" : undefined, killed: next() % 9 === 0 }, 30).text;
  const [item] = items(text);
  assert.equal(item.verify, false, `命令那一句被认成了审查轮：${JSON.stringify(text)}`);
  const blind = noticeView(item);
  if (passed) assert.ok(blind.tier === "receipt" || blind.text === UNKNOWN, `通过的命令认反了：${JSON.stringify(text)}`);
  else assert.equal(blind.tier, "alert", `没通过的命令没摆出来：${JSON.stringify(text)}`);
  if (blind.text === UNKNOWN) unknown += 1;
  const known = noticeView(item, { commands: [cmd] });
  assert.equal(known.tier, passed ? "receipt" : "alert", `给了真命令还认不对：${JSON.stringify(text)}`);
  assert.notEqual(known.text, UNKNOWN, `给了真命令还认不出：${JSON.stringify(text)}`);
  // 门禁摘要同样：命令和超时说明里引的最后一行塞什么，都不改变它是回执还是提醒。
  const gate = passed
    ? `验收前置命令 \`${cmd}\` 通过（rc=0）。`
    : `验收前置命令 \`${cmd}\` 未通过：超时。 跑满 30 分钟被收掉，停在 \`${stdout}\`，最近一次输出在 2 分钟前、累计产出 1.0KB。`;
  assert.equal(legacyTier(gate), passed ? "receipt" : "alert", `门禁摘要认反了：${JSON.stringify(gate)}`);
  const [gateItem] = items(gate);
  assert.equal(noticeView(gateItem).tier, passed ? "receipt" : "alert", `门禁摘要走完整条链认反了：${JSON.stringify(gate)}`);
}
assert.ok(unknown > 0 && unknown < 4000, "随机样本里两种都该有：认得出的、认不出的");

console.log("legacy-notice-decode ok");
