import assert from "node:assert/strict";
import { pathsOf } from "../src/scm/scmModel.ts";

// 「这一行要送哪些路径上去」的回归测试。
//
// 送多了和送少了都是静默的破坏，而且两种都真出现过：
//   • 重命名只送新路径 → 索引里留下一条没人看见的 old 删除
//   • 复制跟着展开原路径 → 用户点的是副本，被取消暂存的还有他自己挑好的源文件
// 判据因此必须是 `kind === "renamed"`，不是「有没有 origPath」。

const change = (path, kind, origPath = null) => ({
  path,
  kind,
  origPath,
  staged: true,
  conflict: null,
});

// 重命名：两条都送，新路径在前（列表顺序就是显示顺序）。
assert.deepEqual(
  pathsOf([change("new.txt", "renamed", "old.txt")]),
  ["new.txt", "old.txt"],
);

// 复制：只送目标。仓库配了 status.renames=copies 时，origPath 是另一个仍然存在的文件。
assert.deepEqual(
  pathsOf([change("copy.txt", "copied", "source.txt")]),
  ["copy.txt"],
);

// 正题：复制的源文件自己也有暂存改动时，点副本那一行不许把它一起带走。
const staged = [
  change("source.txt", "modified"),
  change("copy.txt", "copied", "source.txt"),
];
assert.deepEqual(pathsOf([staged[1]]), ["copy.txt"], "点复制条目只能送目标路径");
assert.ok(
  !pathsOf([staged[1]]).includes("source.txt"),
  "源文件的暂存改动不能被副本那一行连带取消",
);

// 整组批量：复制条目在组里也只算一条，不因为混在一起就展开。
assert.deepEqual(pathsOf(staged), ["source.txt", "copy.txt"]);

// origPath 缺失的重命名（理论上不该出现）按单条处理，不许送 undefined 上去。
assert.deepEqual(pathsOf([change("new.txt", "renamed")]), ["new.txt"]);

// 普通条目原样透传。
assert.deepEqual(
  pathsOf([change("a.txt", "modified"), change("b.txt", "untracked")]),
  ["a.txt", "b.txt"],
);

console.log("scm paths ok");
