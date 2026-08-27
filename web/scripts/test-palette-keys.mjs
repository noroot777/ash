import assert from "node:assert/strict";
import { keysSearchText, matchesKeysQuery, normalizeKeys } from "../src/overlays/paletteKeys.ts";
import { TASK_MODE_SHORTCUT_LABEL } from "../src/workspace/taskScope.ts";

// 两种写法都得筛得到：`G T` 是显示出来的样子，`gt` 是照着敲进去的样子。
const haystack = (keys) => keysSearchText(keys).toLocaleLowerCase();
assert.equal(haystack(TASK_MODE_SHORTCUT_LABEL).includes("gt"), true);
assert.equal(haystack(TASK_MODE_SHORTCUT_LABEL).includes("g t"), true);
assert.equal(haystack(undefined), "");
assert.equal(haystack("NI").includes("ni"), true);

// 回车直达：整串输入正好是那条的键位才算，大小写和空格都不挑。
assert.equal(matchesKeysQuery(TASK_MODE_SHORTCUT_LABEL, "gt"), true);
assert.equal(matchesKeysQuery(TASK_MODE_SHORTCUT_LABEL, "G T"), true);
assert.equal(matchesKeysQuery(TASK_MODE_SHORTCUT_LABEL, "GT"), true);
assert.equal(matchesKeysQuery("NI", "ni"), true);

// 半截、多打一个字符、以及没有键位的条目都不能被直达劫走。
assert.equal(matchesKeysQuery(TASK_MODE_SHORTCUT_LABEL, "g"), false);
assert.equal(matchesKeysQuery(TASK_MODE_SHORTCUT_LABEL, "gtt"), false);
assert.equal(matchesKeysQuery(TASK_MODE_SHORTCUT_LABEL, "任务"), false);
// 空输入下的回车该按高亮行走，不能被「键位恰好也是空」认成命中。
assert.equal(matchesKeysQuery(undefined, ""), false);
assert.equal(matchesKeysQuery("", ""), false);
assert.equal(matchesKeysQuery(TASK_MODE_SHORTCUT_LABEL, "   "), false);

assert.equal(normalizeKeys("G T"), "gt");
assert.equal(normalizeKeys(undefined), "");

console.log("palette keys tests passed");
