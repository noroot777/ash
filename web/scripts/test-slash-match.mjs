import assert from "node:assert/strict";
import { isMenuPickKeyEvent } from "../src/lib/sendKey.ts";
import { applySlashPick, mergeSlashItems, removeSlashToken, slashMatchIndex, slashPickAt, slashQuery, slashSendsAsTyped, slashToken } from "../src/lib/slashMatch.ts";

const skill = (command, description = "") => ({
  name: command.replace(/^\//, ""),
  command,
  description,
  source: "user",
  realPath: null,
  alsoIn: [],
});

const NAVI = [
  { command: "/team", label: "派生团队", kind: "navi" },
  { command: "/duet", label: "派生讨论", kind: "navi" },
];

const SKILLS = [
  skill("/design-taste-frontend"),
  skill("/high-end-visual-design"),
  skill("/codex:rescue"),
  skill("/grill-me"),
];

// 子串匹配:关键词在名字中段也要能选中(这是这次改动的正题)。
assert.equal(slashMatchIndex("/high-end-visual-design", "/design"), 16);
assert.equal(slashMatchIndex("/codex:rescue", "/rescue"), 6);
assert.equal(slashMatchIndex("/grill-me", "/xyz"), -1);
// 大小写不敏感;斜杠两边都剥掉,所以带不带斜杠敲都一样。
assert.equal(slashMatchIndex("/Grill-Me", "/GRILL"), 0);
assert.equal(slashMatchIndex("/grill-me", "grill"), 0);
// 只敲一个斜杠 = 还没输入内容,全列出来。
assert.equal(slashMatchIndex("/team", "/"), 0);

// 命中位置升序:前缀命中排在中段命中前面。
assert.deepEqual(
  mergeSlashItems([], SKILLS, slashQuery("/design")).map((item) => item.command),
  ["/design-taste-frontend", "/high-end-visual-design"],
);

// navi 自己的命令永远在最前,排序只在各自组内进行:
// `/me` 在技能里既有中段命中(grill-me)也有,navi 组空了也不能把技能提上去当 navi。
const teamMatch = mergeSlashItems(NAVI, SKILLS, slashQuery("/me"));
assert.deepEqual(teamMatch.map((item) => item.command), ["/grill-me"]);
assert.deepEqual(
  mergeSlashItems(NAVI, SKILLS, slashQuery("/e")).map((item) => item.kind),
  ["navi", "navi", "skill", "skill", "skill", "skill"],
);

// 没有 token 就一条都不给(菜单据此决定弹不弹)。
assert.deepEqual(mergeSlashItems(NAVI, SKILLS, null), []);
// 一个斜杠 = 全量候选,navi 在前。
assert.equal(mergeSlashItems(NAVI, SKILLS, slashQuery("/")).length, NAVI.length + SKILLS.length);

// token 只在「整段正文就是一个斜杠 token」时成立,句中的 `/` 不弹菜单。
assert.equal(slashToken("  /Design"), "/design");
assert.equal(slashToken("看下 a/b 这个路径"), null);
assert.equal(slashToken("/team 去做这件事"), null);
assert.equal(slashToken("用/grill"), null);
assert.equal(slashToken("看下 /usr/local"), null);

// 已经写了正文,接着在空白或标点后面敲 `/` 也要弹:只换掉末尾那个 token,前文原样留着。
assert.deepEqual(slashQuery("帮我看看这个 /Gri"), { token: "/gri", start: 7, end: 11, leading: false });
assert.equal(slashToken("先想清楚，/grill"), "/grill");
assert.equal(applySlashPick("帮我看看这个 /gri", "/grill-me"), "帮我看看这个 /grill-me ");
assert.equal(applySlashPick("  /gri", "/grill-me"), "/grill-me ");

const native = { ...skill("/goal", "持续目标"), native: true, source: "builtin" };
const grouped = mergeSlashItems(NAVI, [skill("/goal-helper"), native], slashQuery("/"));
assert.deepEqual(grouped.map((item) => item.kind), ["navi", "navi", "native", "skill"]);
assert.equal(grouped[2].command, "/goal");
// 句中不给原生命令(它得是整条消息的开头才生效);navi 的叫人命令照给,排法同在开头时(选中它只是叫人,命令本身被拿掉)。
assert.deepEqual(
  mergeSlashItems(NAVI, [skill("/goal-helper"), native], slashQuery("先这样 /")).map((item) => item.command),
  ["/team", "/duet", "/goal-helper"],
);

// —— 按光标认:开头、两句话中间、引用块后面、文末都弹;光标后面的字不影响。
const quoted = "> 该改测试的模拟数据\n这条红测试你去修。/派";
assert.equal(slashToken(quoted), "/派", "引用块后面、话说到一半敲斜杠");
assert.equal(slashToken("第一句。/派第二句。", "第一句。/派".length), "/派", "两句话中间");
assert.equal(slashToken("/派 后面还有字", 2), "/派", "开头,光标后面还有字");
assert.equal(slashToken("第一句 /派 第二句"), null, "光标在文末、斜杠在句中已经敲完:不弹");
assert.equal(slashToken("看下 web/src", "看下 web/".length), null, "路径里的斜杠照旧不弹");
assert.equal(slashToken("见 http://x", "见 http:/".length), null);
assert.equal(slashQuery("第一句。/派第二句。", "第一句。/派".length).end, "第一句。/派".length);

// 选中技能:只换掉光标前那个 token,光标后面的字原样留着,光标落在补进去的命令后面。
assert.deepEqual(slashPickAt("先想想 /gri 再说", "/grill-me", "先想想 /gri".length), { text: "先想想 /grill-me 再说", caret: "先想想 /grill-me ".length });
assert.deepEqual(slashPickAt("/gri", "/grill-me"), { text: "/grill-me ", caret: 10 });

// 选中叫人的命令:只拿掉命令本身,两边都是空格时并成一个,光标停在原处;开头的连后面的空白一起去掉。
const middle = slashQuery("先这样 /派 你去修", "先这样 /派".length);
assert.deepEqual(removeSlashToken("先这样 /派 你去修", middle), { text: "先这样 你去修", caret: 4 });
const tail = slashQuery(quoted);
assert.deepEqual(removeSlashToken(quoted, tail), { text: "> 该改测试的模拟数据\n这条红测试你去修。", caret: quoted.length - 2 });
assert.deepEqual(removeSlashToken("/派 你去修", slashQuery("/派 你去修", 2)), { text: "你去修", caret: 0 });
assert.deepEqual(removeSlashToken("  /讨", slashQuery("  /讨")), { text: "", caret: 0 });

// 回车直接发只给「原生命令且已一字不差敲全」:没敲全要补全,技能永远补全,navi 命令走派生配置。
const compact = mergeSlashItems([], [{ ...skill("/compact", "原生压缩"), native: true, source: "builtin" }], slashQuery("/com"))[0];
assert.equal(compact.kind, "native");
assert.equal(slashSendsAsTyped(compact, "/com"), false);
assert.equal(slashSendsAsTyped(compact, " /compact"), true);
assert.equal(slashSendsAsTyped(compact, "/COMPACT"), false);
assert.equal(applySlashPick("/COMPACT", compact.command), "/compact ");
assert.equal(slashSendsAsTyped(grouped[3], "/goal-helper"), false);
assert.equal(slashSendsAsTyped(grouped[0], grouped[0].command), false);
assert.equal(slashSendsAsTyped(undefined, "/compact"), false);

// 菜单开着时只有裸回车算「选中这条」:选中可能直接把敲全的原生命令发出去,
// 所以选词中的回车、Shift/Alt+回车(换行)、⌘/Ctrl+回车(发送键)都不算。
const key = (patch) => ({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...patch });
assert.equal(isMenuPickKeyEvent(key({})), true);
assert.equal(isMenuPickKeyEvent(key({ shiftKey: true })), false);
assert.equal(isMenuPickKeyEvent(key({ altKey: true })), false);
assert.equal(isMenuPickKeyEvent(key({ metaKey: true })), false);
assert.equal(isMenuPickKeyEvent(key({ nativeEvent: { isComposing: true } })), false);
assert.equal(isMenuPickKeyEvent(key({ isComposing: true })), false);
assert.equal(isMenuPickKeyEvent(key({ keyCode: 229 })), false);
assert.equal(isMenuPickKeyEvent(key({ key: "Tab" })), false);

console.log("slash match tests passed");
