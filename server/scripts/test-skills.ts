// `/` 技能补全的数据层回归测试(不起 CLI,读写全关在 mkdtemp 里):
//   listSkills / withSkillInvocation —— 扫盘、调用注入、不认识的 CLI 不假装
//   指纹 —— 改 SKILL.md 的 description,不重启也要跟着变
//   calibrateSkills —— init 事件与磁盘取**并集**,内置命令走白名单
//   scanOverview —— 设置页按已注册执行器逐行列出「谁扫到了什么」
//   parseAppSettingsPatch —— 刷新间隔按小时计的边界
// 跑:npm -w server run test:skills
//
// 只用**项目级**技能根(`<cwd>/.claude/skills`、`<cwd>/.codex/skills`),
// 这样不会读写用户真实的 ~/.claude;末尾那段会开 DB,库也指在临时目录里。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "ash-skills-"));

// 先把库指到临时目录再 import:init 校准的冷启动来源就落在库文件旁边(见
// skill-calibration-store.ts),不这么做这条测试会去写真实的 data/。
process.env.ASH_DB = join(root, "settings-test.db");

// 收尾要删的目录里就装着那个库文件,而 Windows 删不掉还开着的文件(理由见
// tmp-db.ts 的 releaseTmpDb)——断言全过,却在退出时抛 EBUSY 把整条测试判红。
// exit 回调只能同步,`await import` 到那会儿来不及,所以现在就把句柄拿在手里。
const { dbClient } = await import("../src/db/index.js");
process.on("exit", () => {
  try {
    dbClient.close();
  } catch {
    // 没真连过库也算正常,照删不误。
  }
  rmSync(root, { recursive: true, force: true });
});

const { calibrateSkills, forgetLoadedCalibrations, listSkills, nativeCliCommand, resetSkillCache, scanOverview, withSkillInvocation } =
  await import("../src/skills.js");

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
assert.ok(find(list, "compact"), "compact 是白名单里的原生命令,同样要进菜单");
assert.ok(!find(list, "cost"), "白名单之外的内置命令不进技能菜单");
assert.equal(find(list, ALPHA)?.description, "改过的描述", "磁盘上有的以磁盘为准,别被 init 覆盖成占位文案");
const builtinInvocation = withSkillInvocation({ agentType: "claude", cwd: root, text: "/review 检查改动" });
assert.match(builtinInvocation, /CLI 已报告可用的内置 skill/, "没有磁盘路径的内置 skill 也要显式调用");

// ── 原生命令(CLI 自己拦下的,不是 skill):必须保留原生消息形状 ────────────────
// 前面垫一个字它就退化成普通模型请求,压缩不会发生;当成 skill 加前言更是白烧一轮
// (模型去调 Skill({skill:"compact"}),CLI 回「built-in CLI command, not a skill」)。
assert.equal(
  withSkillInvocation({ agentType: "claude", cwd: root, text: "/compact" }),
  "/compact",
  "原生命令一个字都不能加",
);
assert.equal(
  withSkillInvocation({ agentType: "claude", cwd: root, text: "/compact 重点保留结论" }),
  "/compact 重点保留结论",
  "带参数的原生命令同样原样发出",
);
assert.equal(nativeCliCommand("claude", "  /compact\n"), "compact", "识别时容忍首尾空白");
assert.equal(nativeCliCommand("claude", `/${ALPHA}`), null, "真 skill 不是原生命令");
assert.equal(nativeCliCommand("claude", "先压一下 /compact"), null, "不在开头就不是原生命令(CLI 也不会拦)");
assert.equal(nativeCliCommand("codex", "/compact"), null, "codex 没有这个原生命令");
// 正文中间提到原生命令时:它对 CLI 不生效,也不能写进前言让模型去「执行」。
const mixed = withSkillInvocation({ agentType: "claude", cwd: root, text: `/${ALPHA} 做完后 /compact` });
assert.ok(mixed.includes(`- /${ALPHA}：`), "同一句里的真 skill 照常调用");
assert.ok(!mixed.includes("- /compact："), "原生命令不该出现在 skill 前言里");

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

// ── 冷启动:server 重启后,磁盘上根本不存在的内置命令不能从菜单里消失 ──────────
// 校准只能搭 claude 启动那一行 JSON 的便车(绝不为了拿清单主动跑 CLI),所以它先前
// 只活在内存里 —— 重启后 `/compact` 就从斜杠菜单里没了,而重启后最需要它的恰恰是
// 那些已经跑到高水位的老会话(第 3 轮审查 finding 4)。
resetSkillCache();
calibrateSkills("claude", root, [ONLY_IN_INIT], ["compact", "cost"]);
forgetLoadedCalibrations(); // = server 重启:内存那份没了,盘上那份还在
list = listSkills({ agentType: "claude", cwd: root });
assert.ok(find(list, "compact"), "重启后 `/compact` 仍要能从菜单里选到");
assert.ok(find(list, ONLY_IN_INIT), "插件/内置技能同理,靠的是同一份落盘校准");
assert.equal(list.authoritative, true, "来源仍是真 CLI 自报的那份清单,不是我们猜的名单");
assert.ok(!find(list, "cost"), "白名单之外的照旧不进菜单(落盘的本来就没收它)");

// 真·冷进程再验一次:上面那句 forget 只是等价物,这里是另起一个 node 进程从零 import。
{
  // 动态 import 的说明符必须是 file:// URL,不能是 `fileURLToPath` 还回来的本地路径:
  // Windows 上那是 `D:\…`,ESM 解析器把开头的 `d:` 当成协议直接拒
  // (ERR_UNSUPPORTED_ESM_URL_SCHEME)。POSIX 的 `/Users/…` 恰好是个合法说明符,
  // 所以这处只在 Windows 上炸,而且炸在子进程里、只露出一句 `1 !== 0`。
  const skillsModule = new URL("../src/skills.ts", import.meta.url).href;
  const probe = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `const { listSkills } = await import(${JSON.stringify(skillsModule)});` +
        `console.log(JSON.stringify(listSkills({ agentType: "claude", cwd: ${JSON.stringify(root)} }).skills.map((s) => s.name)));`,
    ],
    { encoding: "utf8", env: { ...process.env, ASH_DB: process.env.ASH_DB } },
  );
  assert.equal(probe.status, 0, `冷进程探针没跑起来:${probe.stderr}`);
  const names = JSON.parse(probe.stdout.trim().split("\n").at(-1)!) as string[];
  assert.ok(names.includes("compact"), `全新进程里也要有 /compact,实际:${names.join(", ")}`);
}

// worktree 被清掉之后,`/compact` 不能跟着一起消失 —— 校准几乎都记在
// `<repo>/.worktrees/<id>` 上,而菜单是按项目根问的。落盘那边真按目录存在与否硬删的话,
// 最后一个 worktree 被合并清理掉时这个模块就白做了(第 4 轮审查建议 2)。
resetSkillCache();
const merged = join(root, ".worktrees", "gone-after-merge");
mkdirSync(merged, { recursive: true });
calibrateSkills("claude", merged, [], ["compact"]);
rmSync(join(root, ".worktrees"), { recursive: true, force: true }); // 验收合并后连 .worktrees 一起清
// 触发重写的这次校准**必须落在 root 之外**:认亲是按前缀取最新的一条(skills.ts
// calibrationFor),记在 `<root>/*` 底下的话它天然比上提来的那条新,会把上提结果盖掉 ——
// 于是这条测试就只在「两次校准撞进同一毫秒」时才绿(macOS 上约 5/6,Windows 慢得多,
// 基本常红)。它的作用只是「任意一次新校准都会重写整份 JSON」,落在哪无所谓。
const stillHere = mkdtempSync(join(tmpdir(), "ash-skills-other-"));
process.on("exit", () => rmSync(stillHere, { recursive: true, force: true }));
calibrateSkills("claude", stillHere, [ONLY_IN_INIT], []);
forgetLoadedCalibrations(); // = server 重启:只剩盘上那份
list = listSkills({ agentType: "claude", cwd: root });
assert.ok(find(list, "compact"), "worktree 清掉后,那次校准要上提到还活着的祖先目录上继续认亲");

// 「忘掉一切重来」只有测试会走(界面上的「重新扫描」是 listSkills 的 force,不碰校准 ——
// 照着这行去「对齐」路由的话,会把上面这一整段修复一键删掉)。
resetSkillCache();
forgetLoadedCalibrations();
list = listSkills({ agentType: "claude", cwd: root });
assert.ok(!find(list, "compact"), "resetSkillCache 之后连落盘那份也不该再冒出来");

// 分隔符是裸 NUL 的话,git 会把整份 store 记成二进制:diff / blame / 审查者全打不开
// (第 4 轮审查就是这么被挡在门外的)。按字节钉住。
{
  const store = fileURLToPath(new URL("../src/skill-calibration-store.ts", import.meta.url));
  assert.ok(!readFileSync(store).includes(0), "skill-calibration-store.ts 里不能有裸 NUL:用 String.fromCharCode(0)");
}

// ── 不认识的 CLI:宁可空,也不拿本机磁盘冒充 ────────────────────────────────

assert.deepEqual(listSkills({ agentType: "grok", cwd: root }).skills, [], "没有技能目录约定的 CLI 返回空清单");

// ── 设置页的「谁扫到了什么」:按 CLI 类型归并 ─────────────────────────────────
// 同一个 CLI 的几个 profile 只差供应商,扫出来必然是同一份,逐行列出去是噪声。

const overview = scanOverview({
  cwd: root,
  executors: [
    { label: "claude@官方", agentType: "claude" },
    { label: "claude@公司自建", agentType: "claude" },
    { label: "grok@本机", agentType: "grok" },
  ],
});
assert.deepEqual(
  overview.rows.map((row) => row.agentType),
  ["claude", "grok"],
  "同类型的 profile 合成一行",
);
assert.deepEqual(
  overview.rows[0]!.executors,
  ["claude@官方", "claude@公司自建"],
  "被归并掉的 profile 名字要留在行里,好让人确认自己注册的那几个都在",
);
assert.ok(overview.rows[0]!.count >= 2, "claude 那行要有条数");
assert.ok(overview.rows[0]!.bySource.project >= 2, "项目级技能要计进 project 桶");
assert.ok(overview.rows[0]!.sample.every((command) => command.startsWith("/")), "样本是可直接补全的命令");
assert.equal(overview.rows[1]!.scannable, false, "没有技能目录约定的 CLI 要标出来,而不是显示 0 条");

// 一个 profile 都没注册时(路由那边兜的 fallback):不能凭空造出一个空名字
const bare = scanOverview({ cwd: root, executors: [{ label: "", agentType: "claude" }] });
assert.deepEqual(bare.rows[0]!.executors, [], "没有 profile 名字时给空数组,不是 ['']");

// ── 刷新间隔:按小时计,0 或 1~24 小时 ────────────────────────────────────────
// 动态 import:app-settings 会连带打开 DB(库已在文件开头指到临时文件)。
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
