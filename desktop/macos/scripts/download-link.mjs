// 仓库根 README「下载 mac 版」那一行：正式发版发完之后改成刚发的那个 dmg 的直链，只提交 README.md、不推送。
//
// 为什么写死成某一版的直链、而不是指 releases/latest：发版仓库（release.json 的 releaseRepo）以后可能还发
// 别的 Release，latest 不一定是 mac 包。为什么发完才改、只在本地提交：发版要从干净的提交构建，改动留在
// 工作区会挡住下一次发版；推不推、什么时候推交给人（不替人动远端的 main）。没推之前 GitHub 首页还是上一
// 版的链接，那一版照样装得上，装上之后自己会更新到最新。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { compareVersions } from "./appcast.mjs";

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

/** 标记之间那一行现在指向的版本（renderLink 写的「（构建号）」）；还是占位文字就是 null。 */
export function linkedVersion(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return null;
  return /（([^（）]+)）\]\(/.exec(text.slice(start, end))?.[1] ?? null;
}

/**
 * 改写并单独提交 README.md。返回一句给人看的结果；做不了（README 有没提交的改动、标记缺了、已经指向更新的
 * 一版、git 失败）就只说明、不报错 —— 这时包和 appcast 都已经发完了，这一行是锦上添花。
 *
 * 只动能确认是自己写的内容：从开头干净检查到提交，别处（编辑器保存、另一次发版）随时可能写这个文件。
 * 提交前文件已经不是自己写的那份就不提交；提交失败时只有文件仍是自己写的那份才写回原文，否则保留现场。
 */
export function commitLink(readme, release) {
  const manual = `下载链接请手动改成 ${release.url}`;
  if (!existsSync(readme)) return `没找到 ${readme}，${manual}`;
  const cwd = dirname(readme);
  const name = basename(readme);
  const git = (...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  if (git("status", "--porcelain", "--", name).stdout.trim()) return `${readme} 有没提交的改动，没替你改：${manual}`;
  const head = git("rev-parse", "HEAD").stdout.trim();
  const text = readFileSync(readme, "utf8");
  const next = replaceLink(text, renderLink(release));
  if (next === null) return `${readme} 里没有成对的 ${START} / ${END}，${manual}`;
  if (next === text) return "README 的下载链接已经是这一版";
  // 首页只往新版走：补旧版的收尾、或者另一次发版已经把它改到更新的一版，都不倒回去。
  const linked = linkedVersion(text);
  if (linked && compareVersions(release.version, linked) < 0) return `README 的下载链接留在更新的 ${linked}`;
  writeFileSync(readme, next);
  const untouched = () => readFileSync(readme, "utf8") === next;
  if (!untouched() || git("rev-parse", "HEAD").stdout.trim() !== head) {
    return `${readme} 刚被别处改过，没提交、也没动它（保留现场）：${manual}`;
  }
  const message = `${LINK_COMMIT_PREFIX} ${release.shortVersion}（${release.version}）`;
  const commit = git("commit", "--only", "-m", message, "--", name);
  if (commit.status !== 0) {
    const why = (commit.stderr || commit.stdout).trim();
    if (!untouched()) return `提交 ${readme} 失败（${why}）；文件期间被别处改过，保留现场没还原：${manual}`;
    writeFileSync(readme, text);
    return `提交 ${readme} 失败（${why}），已还原；${manual}`;
  }
  if (git("show", `HEAD:${name}`).stdout !== next) {
    return `README 的下载链接已提交（${message}），但提交里的 ${name} 跟这次写的不一致，像是同时有别处在写：推送前看一眼 HEAD`;
  }
  return `README 的下载链接已改成这一版并提交（${message}，没推送：推上去之后 GitHub 首页才是新链接）`;
}
