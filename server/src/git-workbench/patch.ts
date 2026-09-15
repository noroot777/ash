import { spawn } from "node:child_process";
import { readScmFileDiff } from "../git-status.js";
import { assertPathShape, gateScmPaths } from "../scm-paths.js";
import { fail } from "./core.js";

export function selectedPatch(
  diff: string,
  selected: number[],
  reverse = false,
): string {
  const lines = diff.split("\n");
  const selectedSet = new Set(selected);
  if (
    !selected.length ||
    selected.some(
      (i) =>
        !Number.isInteger(i) ||
        i < 0 ||
        i >= lines.length ||
        !/^[+-]/.test(lines[i]) ||
        /^---|^\+\+\+/.test(lines[i]),
    )
  )
    fail("请选择改动行", 400);
  if (
    /^(rename|copy|new file mode|deleted file mode|old mode|new mode|Binary)/m.test(
      diff,
    )
  )
    fail("新增、删除、重命名或二进制文件请按整个文件暂存");
  const first = lines.findIndex((line) => line.startsWith("@@ "));
  if (first < 0) fail("没有可暂存的改动块");
  const result = lines.slice(0, first);
  let delta = 0;
  for (let start = first; start < lines.length; ) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[start]);
    if (!header) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith("@@ ")) end++;
    const body: string[] = [];
    let touched = false;
    for (let i = start + 1; i < end; i++) {
      const line = lines[i];
      if (!line && i === lines.length - 1) continue;
      if (line.startsWith("\\")) fail("无末尾换行的改动请按整个文件暂存");
      const sign = reverse
        ? line[0] === "+"
          ? "-"
          : line[0] === "-"
            ? "+"
            : line[0]
        : line[0];
      if (sign === " ") body.push(line);
      else if (sign === "+" || sign === "-") {
        if (selectedSet.has(i)) {
          body.push(sign + line.slice(1));
          touched = true;
        } else if (sign === "-") body.push(" " + line.slice(1));
      }
    }
    if (touched) {
      const oldCount = body.filter((line) => line[0] !== "+").length;
      const newCount = body.filter((line) => line[0] !== "-").length;
      const oldStart = Number(header[reverse ? 2 : 1]);
      result.push(
        `@@ -${oldStart},${oldCount} +${oldStart + delta},${newCount} @@`,
        ...body,
      );
      delta += newCount - oldCount;
    }
    start = end;
  }
  if (result.length === first) fail("选择的改动已不存在");
  if (reverse) {
    for (let i = 0; i < result.length; i++) {
      if (result[i].startsWith("index "))
        result[i] = result[i].replace(
          /index ([a-f0-9]+)\.\.([a-f0-9]+)/,
          "index $2..$1",
        );
    }
  }
  return result.join("\n") + "\n";
}
async function applyPatch(
  root: string,
  patch: string,
  cached: boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-C",
        root,
        "apply",
        ...(cached ? ["--cached"] : []),
        "--recount",
        "--whitespace=nowarn",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let error = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      if (error.length < 16000) error += chunk;
    });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(error || `git apply exited ${code}`)),
    );
    child.stdin.end(patch);
  });
}
export async function stageSelected(
  root: string,
  path: string,
  source: "staged" | "unstaged",
  diff: string,
  lines: number[],
): Promise<void> {
  assertPathShape([path]);
  if (!["staged", "unstaged"].includes(source)) fail("差异来源不合法", 400);
  await gateScmPaths(root, { paths: [path], rejectConflicted: true });
  const current = await readScmFileDiff(root, path, source);
  if (current.truncated || current.binary || current.diff !== diff)
    fail("差异已变化或不能部分暂存，请重新打开文件");
  await applyPatch(root, selectedPatch(diff, lines, source === "staged"), true);
}

export async function discardSelected(
  root: string,
  path: string,
  diff: string,
  lines: number[],
): Promise<void> {
  assertPathShape([path]);
  await gateScmPaths(root, { paths: [path], rejectConflicted: true });
  const current = await readScmFileDiff(root, path, "unstaged");
  if (current.truncated || current.binary || current.diff !== diff)
    fail("差异已变化或不能部分丢弃，请重新打开文件");
  await applyPatch(root, selectedPatch(diff, lines, true), false);
}
