// `/` 技能补全的数据层回归测试(不起 CLI,读写全关在 mkdtemp 里):
//   listSkills / withSkillInvocation —— 扫盘、调用注入、ssh 执行器不假装
//   指纹 —— 改 SKILL.md 的 description,不重启也要跟着变
//   calibrateSkills —— init 事件与磁盘取**并集**,内置命令走白名单
//   scanOverview —— 设置页按已注册执行器逐行列出「谁扫到了什么」
//   parseAppSettingsPatch —— 刷新间隔按小时计的边界
// 跑:npm -w server run test:skills
//
// 只用**项目级**技能根(`<cwd>/.claude/skills`、`<cwd>/.codex/skills`),
// 这样不会读写用户真实的 ~/.claude;末尾那段会开 DB,库也指在临时目录里。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrateSkills, listSkills, resetSkillCache, scanOverview, withSkillInvocation } from "../src/skills.js";

const root = mkdtempSync(join(tmpdir(), "harness-skills-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// 名字取得刁钻些:用户 ~/.claude/skills 里的真技能也会一起列出来,别撞名。
const ALPHA = "zz-probe-alpha";
const BETA = "zz-probe-beta";

function writeSkill(cli: "claude" | "codex", name: string, description: string): string {
  const dir = join(root, `.${cli}`, "skills", name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`);
  return dir;
}

const find = (list: ReturnType<typeof listSkills>, name: string) =>
  list.skills.find((skill) => skill.name === name);

// ── 扫盘:项目级技能能被看见,description 从 frontmatter 来 ───────────────────

const alphaDir = writeSkill("claude", ALPHA, "第一版描述");
resetSkillCache();
let list = listSkills({ agentType: "claude", cwd: root });
assert.equal(find(list, ALPHA)?.command, `/${ALPHA}`, "项目级技能应该出现在清单里");
assert.equal(find(list, ALPHA)?.description, "第一版描述");
assert.equal(find(list, ALPHA)?.source, "project");
assert.equal(list.authoritative, false, "没有 init 校准时不能自称权威");

// 无人值守/完成协议前言会让 slash 不再位于 prompt 开头，所以必须显式指向 SKILL.md。
const invoked = withSkillInvocation({ agentType: "claude", cwd: root, text: `/${ALPHA} 做一件事` });
assert.match(invoked, /已选择 skill/);
assert.ok(invoked.includes(JSON.stringify(join(find(list, ALPHA)!.realPath!, "SKILL.md"))), "命中已安装 skill 要注入准确 SKILL.md 路径");
assert.ok(invoked.endsWith(`/${ALPHA} 做一件事`), "原始命令与参数仍然保留");
const inlineInvocation = withSkillInvocation({ agentType: "claude", cwd: root, text: `请用 /${ALPHA} 检查方案` });
assert.match(inlineInvocation, /已选择 skill/, "句子中间有边界的已安装 skill 也必须调用");
const trailingInvocation = withSkillInvocation({ agentType: "claude", cwd: root, text: `长段任务需求\n/${ALPHA}` });
assert.match(trailingInvocation, /已选择 skill/, "正文末尾独立一行的 skill 也必须调用");
assert.equal(withSkillInvocation({ agentType: "claude", cwd: root, text: `路径 /${ALPHA}/file.txt` }), `路径 /${ALPHA}/file.txt`, "skill 名只是路径前缀时不误调用");
assert.equal(withSkillInvocation({ agentType: "claude", cwd: root, text: `https://example.com/${ALPHA}` }), `https://example.com/${ALPHA}`, "URL 里的 skill 名不误调用");
assert.equal(withSkillInvocation({ agentType: "claude", cwd: root, text: "/zz-not-installed 做事" }), "/zz-not-installed 做事", "未安装命令不改写");
assert.equal(withSkillInvocation({ agentType: "claude", cwd: root, text: `/${ALPHA} 做事`, remote: true }), `/${ALPHA} 做事`, "ssh 不能注入本机路径");

// ── 热加:不清缓存、不重启,新加的技能目录也要出现(指纹变了就重扫) ─────────

writeSkill("claude", BETA, "后来才加的");
list = listSkills({ agentType: "claude", cwd: root });
assert.ok(find(list, BETA), "新加的技能目录必须不重启就能出现");
const multiple = withSkillInvocation({ agentType: "claude", cwd: root, text: `/${ALPHA}\n完成任务\n/${BETA}` });
assert.ok(multiple.includes(`- /${ALPHA}：`) && multiple.includes(`- /${BETA}：`), "同一任务声明多个 skill 时要全部调用");

// ── 指纹逐文件 stat:只改 SKILL.md 内容(根目录 mtime 不变)也要跟着变 ────────
// 这是「改 description 菜单永远显示旧文案」那个 bug 的回归用例。
const alphaFile = join(alphaDir, "SKILL.md");
writeFileSync(alphaFile, `---\nname: ${ALPHA}\ndescription: 改过的描述\n---\n\n正文\n`);
const future = new Date(Date.now() + 2000);
utimesSync(alphaFile, future, future); // 同一毫秒内写入时 mtime 可能不变,手动推一下
list = listSkills({ agentType: "claude", cwd: root });
assert.equal(find(list, ALPHA)?.description, "改过的描述", "改了 description 必须跟着变");

// ── 软链 + 跨 CLI 去重:同一份物理技能给 codex 也挂一个,claude 侧打「也在」角标 ──
// 用 statSync 跟随软链才看得见;readdirSync(withFileTypes).isDirectory() 会静默漏掉。
mkdirSync(join(root, ".codex", "skills"), { recursive: true });
symlinkSync(alphaDir, join(root, ".codex", "skills", ALPHA));
resetSkillCache();
const codex = listSkills({ agentType: "codex", cwd: root });
assert.ok(find(codex, ALPHA), "软链过来的技能目录必须被 codex 看见");
assert.ok(!find(codex, BETA), "没软链过来的不该出现在 codex 清单里");
list = listSkills({ agentType: "claude", cwd: root });
assert.deepEqual(find(list, ALPHA)?.alsoIn, ["codex"], "同一份物理技能要标出还在哪个 CLI 里");
assert.deepEqual(find(list, BETA)?.alsoIn, [], "只有一处的不该标角标");

// ── init 校准:与磁盘取并集,内置命令只放行白名单 ─────────────────────────────

const ONLY_IN_INIT = "zz-probe-from-init";
calibrateSkills("claude", root, [ALPHA, ONLY_IN_INIT], ["review", "compact", "cost"]);
list = listSkills({ agentType: "claude", cwd: root });
assert.equal(list.authoritative, true, "拿到 init 事件后算权威清单");
assert.ok(find(list, ONLY_IN_INIT), "init 报了但磁盘上没有的(内置/插件)也要列出来");
assert.equal(find(list, ONLY_IN_INIT)?.source, "builtin");
assert.ok(find(list, BETA), "**并集**:init 那一轮之后新装的技能不能被交集抹掉");
assert.ok(find(list, "review"), "白名单里的内置斜杠命令要放行");
assert.ok(!find(list, "compact"), "白名单之外的内置命令不进技能菜单");
assert.ok(!find(list, "cost"), "白名单之外的内置命令不进技能菜单");
assert.equal(find(list, ALPHA)?.description, "改过的描述", "磁盘上有的以磁盘为准,别被 init 覆盖成占位文案");
const builtinInvocation = withSkillInvocation({ agentType: "claude", cwd: root, text: "/review 检查改动" });
assert.match(builtinInvocation, /CLI 已报告可用的内置 skill/, "没有磁盘路径的内置 skill 也要显式调用");

// ── 校准按 cwd 前缀认亲:任务多半跑在 <repo>/.worktrees/<id> 里 ───────────────

resetSkillCache();
calibrateSkills("claude", join(root, ".worktrees", "abc123"), [ONLY_IN_INIT], []);
list = listSkills({ agentType: "claude", cwd: root });
assert.ok(find(list, ONLY_IN_INIT), "worktree 里跑出来的校准要能算到项目根上");
resetSkillCache();
calibrateSkills("claude", `${root}-sibling`, [ONLY_IN_INIT], []);
list = listSkills({ agentType: "claude", cwd: root });
assert.ok(!find(list, ONLY_IN_INIT), "只是前缀像的兄弟目录不算自家 worktree");

// 空 init(claude 有时先吐一个不带 skills 的事件)不能把已有校准打成空白
resetSkillCache();
calibrateSkills("claude", root, [ONLY_IN_INIT], []);
calibrateSkills("claude", root, [], []);
list = listSkills({ agentType: "claude", cwd: root });
assert.ok(find(list, ONLY_IN_INIT), "空的 init 事件应当被忽略,不能清掉上一次校准");

// ── ssh 执行器 / 不认识的 CLI:宁可空,也不拿本机磁盘冒充 ─────────────────────

const remote = listSkills({ agentType: "claude", cwd: root, remote: true });
assert.deepEqual(remote.skills, [], "ssh 执行器扫的是本机盘,那不是它要跑的地方");
assert.equal(remote.remote, true, "要把 remote 如实告诉前端,好让菜单说人话而不是显示空");
assert.deepEqual(listSkills({ agentType: "grok", cwd: root }).skills, [], "没有技能目录约定的 CLI 返回空清单");

// ── 设置页的「谁扫到了什么」:按 CLI 类型 × 本机/远端归并 ──────────────────────
// 同一个 CLI 的几个 profile 只差供应商,扫出来必然是同一份,逐行列出去是噪声。

const overview = scanOverview({
  cwd: root,
  executors: [
    { label: "claude@官方", agentType: "claude", remote: false },
    { label: "claude@公司自建", agentType: "claude", remote: false },
    { label: "claude@远端", agentType: "claude", remote: true },
    { label: "grok@本机", agentType: "grok", remote: false },
  ],
});
assert.deepEqual(
  overview.rows.map((row) => `${row.agentType}${row.remote ? "@ssh" : ""}`),
  ["claude", "claude@ssh", "grok"],
  "同类型的本机 profile 合成一行,ssh 的另算一行",
);
assert.deepEqual(
  overview.rows[0]!.executors,
  ["claude@官方", "claude@公司自建"],
  "被归并掉的 profile 名字要留在行里,好让人确认自己注册的那几个都在",
);
assert.ok(overview.rows[0]!.count >= 2, "本机那行要有条数");
assert.ok(overview.rows[0]!.bySource.project >= 2, "项目级技能要计进 project 桶");
assert.ok(overview.rows[0]!.sample.every((command) => command.startsWith("/")), "样本是可直接补全的命令");
assert.equal(overview.rows[1]!.count, 0, "ssh 那行不拿本机结果冒充");
assert.equal(overview.rows[1]!.remote, true);
assert.equal(overview.rows[2]!.scannable, false, "没有技能目录约定的 CLI 要标出来,而不是显示 0 条");

// 一个 profile 都没注册时(路由那边兜的 fallback):不能凭空造出一个空名字
const bare = scanOverview({ cwd: root, executors: [{ label: "", agentType: "claude", remote: false }] });
assert.deepEqual(bare.rows[0]!.executors, [], "没有 profile 名字时给空数组,不是 ['']");

// ── 刷新间隔:按小时计,0 或 1~24 小时 ────────────────────────────────────────
// 动态 import:app-settings 会连带打开 DB,先把库指到临时文件,别碰用户真实的 data/。
process.env.HARNESS_DB = join(root, "settings-test.db");
const { parseAppSettingsPatch } = await import("../src/app-settings.js");
const rejects = (seconds: number) =>
  assert.throws(() => parseAppSettingsPatch({ skillRefreshSeconds: seconds }), /1~24 小时/);

assert.deepEqual(parseAppSettingsPatch({ skillRefreshSeconds: 0 }), { skillRefreshSeconds: 0 }, "0 = 关闭轮询");
assert.deepEqual(parseAppSettingsPatch({ skillRefreshSeconds: 3600 }), { skillRefreshSeconds: 3600 });
assert.deepEqual(parseAppSettingsPatch({ skillRefreshSeconds: 86400 }), { skillRefreshSeconds: 86400 });
rejects(60); // 旧的分钟级档位
rejects(900);
rejects(3599);
rejects(86401); // 超过 24 小时
assert.throws(
  () => parseAppSettingsPatch({ skillRefreshSecond: 3600 }),
  /未知设置项/,
  "拼错的 key 要当场被拒(线上那次「未知设置项」就是前端比服务端新)",
);

console.log("skills tests passed");
