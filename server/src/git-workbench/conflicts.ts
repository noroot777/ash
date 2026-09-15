import {
  lstat,
  readFile,
  writeFile,
  mkdir,
  unlink,
  realpath,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { GitAction, GitConflict } from "@ash/shared/git-workbench";
import {
  EMPTY_CHERRY_PICK_MESSAGE,
  isEmptyCherryPick,
} from "@ash/shared/git-workbench";
import { assertPathShape } from "../scm-paths.js";
import { literalPathspec, readScmStatus } from "../git-status.js";
import { cappedGitStdout } from "../git-exec.js";
import { isInsidePath } from "../platform.js";
import { digest, fail, git } from "./core.js";
import { cleanupRebaseHelpers } from "./maintenance.js";

async function conflictStages(root: string, path: string) {
  assertPathShape([path]);
  const raw = await git(root, [
    "ls-files",
    "-u",
    "-z",
    "--",
    literalPathspec(path),
  ]);
  if (!raw) fail("这个文件已经没有未解决的冲突，请刷新");
  const records = raw
    .split("\0")
    .filter(Boolean)
    .map((line) => line.slice(0, line.indexOf("\t")).split(" "));
  return { raw, records };
}
async function safePath(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  let parent = dirname(absolute);
  while (!(await lstat(parent).catch(() => null))) parent = dirname(parent);
  if (!isInsidePath(await realpath(root), await realpath(parent), sep))
    fail("冲突文件的父目录在仓库外", 400);
  const stat = await lstat(absolute).catch(() => null);
  if (stat && !stat.isFile())
    fail("符号链接或特殊文件不能在文本冲突编辑器中处理");
  return absolute;
}
export async function readConflict(
  root: string,
  path: string,
): Promise<GitConflict> {
  const { raw, records } = await conflictStages(root, path);
  const regular = records.every(
    ([mode]) => mode === "100644" || mode === "100755",
  );
  const versions = await Promise.all(
    ["1", "2", "3"].map(async (stage) => {
      const record = records.find((r) => r[2] === stage);
      if (!record || !regular) return null;
      const blob = await cappedGitStdout(
        root,
        ["cat-file", "blob", record[1]],
        1024 * 1024,
      );
      return blob.truncated ||
        blob.text.includes("\0") ||
        blob.text.includes("\ufffd")
        ? null
        : blob.text;
    }),
  );
  const absolute = await safePath(root, path);
  const stat = await lstat(absolute).catch(() => null);
  const bytes =
    stat && stat.size <= 1024 * 1024 ? await readFile(absolute) : null;
  const content =
    bytes && !bytes.includes(0) && !bytes.toString("utf8").includes("\ufffd")
      ? bytes.toString("utf8")
      : null;
  const binary =
    !regular ||
    records.some((r) => versions[Number(r[2]) - 1] === null) ||
    (!!stat && content === null);
  return {
    path,
    base: versions[0],
    ours: versions[1],
    theirs: versions[2],
    content,
    binary,
    available: {
      base: records.some((r) => r[2] === "1"),
      ours: records.some((r) => r[2] === "2"),
      theirs: records.some((r) => r[2] === "3"),
    },
    version: digest(
      raw +
        (bytes
          ? digest(bytes.toString("base64"))
          : `${stat?.mtimeMs}:${stat?.size}`),
    ),
  };
}
export async function resolveConflict(
  root: string,
  action: Extract<GitAction, { kind: "resolve" }>,
) {
  const current = await readConflict(root, action.path);
  if (current.version !== action.version)
    fail("冲突内容已变化，请重新读取后再保存");
  const absolute = await safePath(root, action.path);
  if (action.choice === "delete") {
    await unlink(absolute).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await git(root, ["add", "-A", "--", literalPathspec(action.path)]);
    return;
  }
  if (action.choice === "ours" || action.choice === "theirs") {
    const { records } = await conflictStages(root, action.path);
    const stage = action.choice === "ours" ? "2" : "3";
    if (!records.some((r) => r[2] === stage))
      fail("这一侧删除了文件，请选择“删除文件”");
    await git(root, [
      "checkout",
      `--${action.choice}`,
      "--",
      literalPathspec(action.path),
    ]);
  } else {
    if (current.binary) fail("二进制或过大的文件只能选择一侧版本");
    if (
      typeof action.content !== "string" ||
      Buffer.byteLength(action.content) > 1024 * 1024
    )
      fail("解决内容为空或超过 1 MB", 400);
    if (/^(<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(action.content))
      fail("结果中仍有冲突标记，请解决后再保存");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, action.content);
  }
  await git(root, ["add", "--", literalPathspec(action.path)]);
}
export async function continueOperation(
  root: string,
  action: "continue" | "abort" | "skip",
  executeSequence: typeof git = git,
): Promise<void> {
  const status = await readScmStatus(root);
  if (!status.operation)
    fail(
      "当前没有可继续或中止的 Git 操作；未解决的冲突可解决并暂存后提交，或在冲突面板放弃冲突改动",
    );
  if (action === "continue" && status.merge.length) fail("还有未解决的冲突");
  if (action === "continue" && isEmptyCherryPick(status))
    fail(EMPTY_CHERRY_PICK_MESSAGE);
  if (action === "skip" && status.operation === "merge")
    fail("合并不能跳过提交", 400);
  try {
    const execute = action === "abort" ? git : executeSequence;
    await execute(root, [status.operation, `--${action}`]);
  } finally {
    if (status.operation === "rebase") await cleanupRebaseHelpers(root);
  }
}
