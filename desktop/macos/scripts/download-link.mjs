// 仓库根 README「下载 mac 版」那一行：正式发版发完之后改成刚发的那个 dmg 的直链，只提交 README.md、不推送。
//
// 为什么写死成某一版的直链、而不是指 releases/latest：发版仓库（release.json 的 releaseRepo）以后可能还发
// 别的 Release，latest 不一定是 mac 包。为什么发完才改、只在本地提交：发版要从干净的提交构建，改动留在
// 工作区会挡住下一次发版；推不推、什么时候推交给人（不替人动远端的 main）。没推之前 GitHub 首页还是上一
// 版的链接，那一版照样装得上，装上之后自己会更新到最新。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const START = "<!-- ash-mac-download -->";
const END = "<!-- /ash-mac-download -->";
/** 这类提交的标题前缀：更新说明里不列它们（每一版都有一条，对用户没信息量）。 */
export const LINK_COMMIT_PREFIX = "docs(README): mac 版下载指向";

export function renderLink({ url, shortVersion, version }) {
  return `**[下载 ash ${shortVersion}（${version}）](${url})**`;
}

/** 把两个标记之间换成新的一行；标记缺了或不成对返回 null（不猜该写在哪）。 */
export function replaceLink(text, line) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < start || text.indexOf(START, start + 1) >= 0) return null;
  return `${text.slice(0, start + START.length)}\n${line}\n${text.slice(end)}`;
}

/**
 * 改写并单独提交 README.md。返回一句给人看的结果；做不了（README 有没提交的改动、标记缺了、git 失败）
 * 就只说明、不报错 —— 这时包和 appcast 都已经发完了，这一行是锦上添花。
 */
export function commitLink(readme, release) {
  if (!existsSync(readme)) return `没找到 ${readme}，下载链接请手动改成 ${release.url}`;
  const cwd = dirname(readme);
  const git = (...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  if (git("status", "--porcelain", "--", basename(readme)).stdout.trim()) {
    return `${readme} 有没提交的改动，没替你改：下载链接请手动改成 ${release.url}`;
  }
  const text = readFileSync(readme, "utf8");
  const next = replaceLink(text, renderLink(release));
  if (next === null) return `${readme} 里没有成对的 ${START} / ${END}，下载链接请手动改成 ${release.url}`;
  if (next === text) return "README 的下载链接已经是这一版";
  writeFileSync(readme, next);
  const message = `${LINK_COMMIT_PREFIX} ${release.shortVersion}（${release.version}）`;
  const commit = git("commit", "--only", "-m", message, "--", basename(readme));
  if (commit.status !== 0) {
    git("checkout", "--", basename(readme));
    return `提交 ${readme} 失败（${(commit.stderr || commit.stdout).trim()}），已还原；下载链接请手动改成 ${release.url}`;
  }
  return `README 的下载链接已改成这一版并提交（${message}，没推送：推上去之后 GitHub 首页才是新链接）`;
}
