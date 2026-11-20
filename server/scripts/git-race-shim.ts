// 「先看一眼、再动手」竞态的回归夹具：PATH 上放一个 git 包装，第一次见到指定的那条 git 命令时，
// 像另一个终端那样在项目目录里 `git switch` 一次，再照常执行（或执行完再 switch）。
//
// 那一下 switch 不带被包装命令的 GIT_* 环境（真有另一个终端时也没有）：不然它会跟着 GIT_INDEX_FILE
// 去锁一份临时索引，绕过被测代码持着的那把 index.lock。它的退出码和 stderr 记进 mark 文件，
// 用例据此断言「切成了」还是「被 git 拒了」。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Race = {
  /** 项目目录（switch 在这里跑）。 */
  repo: string;
  /** 切到哪个分支。 */
  branch: string;
  /** 被包装命令的参数里要同时出现这几个（逐个精确匹配），才算「那一条」。 */
  when: string[];
  /** true = 那条命令执行完再 switch（「看完一眼」之后）；缺省 = 执行之前。 */
  after?: boolean;
  /** true = `switch -c`：在当前提交上新建分支切过去（不拿索引锁）。 */
  create?: boolean;
  /** switch 之前先跑的 sh 片段（`$SHIM_GIT` 是真 git，`$SHIM_REPO` 是项目目录），同样不带被包装命令的 GIT_* 环境。 */
  prep?: string;
};

export function raceShim(root: string) {
  const dir = join(root, "git-race-shim");
  mkdirSync(dir, { recursive: true });
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const clean = "env -u GIT_INDEX_FILE -u GIT_DIR -u GIT_WORK_TREE -u GIT_OPTIONAL_LOCKS";
  const other = `{ [ -z "$SHIM_PREP" ] || ${clean} SHIM_GIT="${realGit}" sh -c "$SHIM_PREP" >>"$SHIM_MARK" 2>&1; }; `
    + `${clean} "${realGit}" -C "$SHIM_REPO" switch -q $SHIM_CREATE "$SHIM_BRANCH" 2>>"$SHIM_MARK"; echo "switch=$?" >>"$SHIM_MARK"`;
  writeFileSync(join(dir, "git"), [
    "#!/bin/sh",
    'if [ -n "$SHIM_REPO" ] && [ ! -e "$SHIM_MARK" ]; then',
    "  hit=1",
    "  for want in $SHIM_WHEN; do",
    "    found=",
    '    for a in "$@"; do [ "$a" = "$want" ] && found=1; done',
    '    [ -n "$found" ] || hit=',
    "  done",
    '  if [ -n "$hit" ]; then',
    '    : >"$SHIM_MARK"',
    `    if [ -n "$SHIM_AFTER" ]; then "${realGit}" "$@"; rc=$?; ${other}; exit $rc; fi`,
    `    ${other}`,
    "  fi",
    "fi",
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  let seq = 0;
  const keys = ["PATH", "SHIM_REPO", "SHIM_BRANCH", "SHIM_MARK", "SHIM_WHEN", "SHIM_AFTER", "SHIM_CREATE", "SHIM_PREP"];
  /** 跑 `run`，期间第一条命中的 git 触发一次 switch。`switched` = null 时没触发。 */
  return async <T>(race: Race, run: () => Promise<T>): Promise<{ value: T; switched: boolean | null; log: string }> => {
    const mark = join(dir, `mark-${seq++}`);
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, SHIM_REPO: race.repo, SHIM_BRANCH: race.branch,
      SHIM_MARK: mark, SHIM_WHEN: race.when.join(" "), SHIM_AFTER: race.after ? "1" : "", SHIM_CREATE: race.create ? "-c" : "",
      SHIM_PREP: race.prep ?? "" });
    try {
      const value = await run();
      const log = existsSync(mark) ? readFileSync(mark, "utf8") : "";
      return { value, switched: existsSync(mark) ? /switch=0\s*$/.test(log) : null, log };
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };
}
