import assert from "node:assert/strict";
import { mergeSlashItems, slashMatchIndex, slashToken } from "../src/lib/slashMatch.ts";

const skill = (command, description = "") => ({
  name: command.replace(/^\//, ""),
  command,
  description,
  source: "user",
  realPath: null,
  alsoIn: [],
});

const HARNESS = [
  { command: "/team", label: "派生团队", kind: "harness" },
  { command: "/duet", label: "派生讨论", kind: "harness" },
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
  mergeSlashItems([], SKILLS, "/design").map((item) => item.command),
  ["/design-taste-frontend", "/high-end-visual-design"],
);

// harness 自己的命令永远在最前,排序只在各自组内进行:
// `/me` 在技能里既有中段命中(grill-me)也有,harness 组空了也不能把技能提上去当 harness。
const teamMatch = mergeSlashItems(HARNESS, SKILLS, "/me");
assert.deepEqual(teamMatch.map((item) => item.command), ["/grill-me"]);
assert.deepEqual(
  mergeSlashItems(HARNESS, SKILLS, "/e").map((item) => item.kind),
  ["harness", "harness", "skill", "skill", "skill", "skill"],
);

// 没有 token 就一条都不给(菜单据此决定弹不弹)。
assert.deepEqual(mergeSlashItems(HARNESS, SKILLS, null), []);
// 一个斜杠 = 全量候选,harness 在前。
assert.equal(mergeSlashItems(HARNESS, SKILLS, "/").length, HARNESS.length + SKILLS.length);

// token 只在「整段正文就是一个斜杠 token」时成立,句中的 `/` 不弹菜单。
assert.equal(slashToken("  /Design"), "/design");
assert.equal(slashToken("看下 a/b 这个路径"), null);
assert.equal(slashToken("/team 去做这件事"), null);

console.log("slash match tests passed");
