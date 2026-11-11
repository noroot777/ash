import assert from "node:assert/strict";
import { isMenuPickKeyEvent } from "../src/lib/sendKey.ts";
import { applySlashPick, mergeSlashItems, slashMatchIndex, slashQuery, slashSendsAsTyped, slashToken } from "../src/lib/slashMatch.ts";

const skill = (command, description = "") => ({
  name: command.replace(/^\//, ""),
  command,
  description,
  source: "user",
  realPath: null,
  alsoIn: [],
});

const ASH = [
  { command: "/team", label: "派生团队", kind: "ash" },
  { command: "/duet", label: "派生讨论", kind: "ash" },
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

// ash 自己的命令永远在最前,排序只在各自组内进行:
// `/me` 在技能里既有中段命中(grill-me)也有,ash 组空了也不能把技能提上去当 ash。
const teamMatch = mergeSlashItems(ASH, SKILLS, slashQuery("/me"));
assert.deepEqual(teamMatch.map((item) => item.command), ["/grill-me"]);
assert.deepEqual(
  mergeSlashItems(ASH, SKILLS, slashQuery("/e")).map((item) => item.kind),
  ["ash", "ash", "skill", "skill", "skill", "skill"],
);

// 没有 token 就一条都不给(菜单据此决定弹不弹)。
assert.deepEqual(mergeSlashItems(ASH, SKILLS, null), []);
// 一个斜杠 = 全量候选,ash 在前。
assert.equal(mergeSlashItems(ASH, SKILLS, slashQuery("/")).length, ASH.length + SKILLS.length);

// token 只在「整段正文就是一个斜杠 token」时成立,句中的 `/` 不弹菜单。
assert.equal(slashToken("  /Design"), "/design");
assert.equal(slashToken("看下 a/b 这个路径"), null);
assert.equal(slashToken("/team 去做这件事"), null);
assert.equal(slashToken("用/grill"), null);
assert.equal(slashToken("看下 /usr/local"), null);

// 已经写了正文,接着在空白或标点后面敲 `/` 也要弹:只换掉末尾那个 token,前文原样留着。
assert.deepEqual(slashQuery("帮我看看这个 /Gri"), { token: "/gri", start: 7, leading: false });
assert.equal(slashToken("先想清楚，/grill"), "/grill");
assert.equal(applySlashPick("帮我看看这个 /gri", "/grill-me"), "帮我看看这个 /grill-me ");
assert.equal(applySlashPick("  /gri", "/grill-me"), "/grill-me ");

const native = { ...skill("/goal", "持续目标"), native: true, source: "builtin" };
const grouped = mergeSlashItems(ASH, [skill("/goal-helper"), native], slashQuery("/"));
assert.deepEqual(grouped.map((item) => item.kind), ["ash", "ash", "native", "skill"]);
assert.equal(grouped[2].command, "/goal");
// 句中只给技能:ash 命令和原生命令必须是整条消息的开头才生效。
assert.deepEqual(
  mergeSlashItems(ASH, [skill("/goal-helper"), native], slashQuery("先这样 /")).map((item) => item.command),
  ["/goal-helper"],
);

// 回车直接发只给「原生命令且已一字不差敲全」:没敲全要补全,技能永远补全,ash 命令走派生配置。
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
