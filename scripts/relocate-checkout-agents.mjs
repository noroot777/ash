// 本地目录迁移的清点：各家 CLI 的配置文件，以及只报不改的 shell 配置、登录项、crontab。只读。
// 配置文件清单来自 relocate-checkout-roots.mjs 的 resolveRoots（此刻的位置）；一份配置里有几处要换、
// 能不能安全改，全交给 relocate-checkout-config.mjs 的 analyzeConfig（按解码后的值判）。
import { readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { analyzeConfig } from "./relocate-checkout-config.mjs";
import { countRefs, mapPath } from "./relocate-checkout-paths.mjs";
import { isLink, lexists, listDir, readTextOr, sh } from "./relocate-checkout-fs.mjs";

/** 只报不改的地方：用户自己的 shell 配置、登录项、定时任务。 */
function reportOnlyFiles(home, errors) {
  const files = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"].map((f) => join(home, f));
  const agents = join(home, "Library", "LaunchAgents");
  for (const f of listDir(agents, errors)) if (f.endsWith(".plist")) files.push(join(agents, f));
  return files;
}

export function scanConfigs(home, rules, { files, from, to, errors }) {
  const rewrite = [];
  const relink = [];
  for (const { file, kind } of files) {
    if (!lexists(file)) continue;
    // 配置是链接（dotfiles 仓库里那种）：指着树里的，链接本身要改指；正文改它指着的那一份。
    if (isLink(file)) {
      const target = readlinkSync(file);
      const abs = isAbsolute(target) ? target : resolve(dirname(file), target);
      const next = mapPath(abs, from, to);
      if (next) relink.push({ path: file, target, next: isAbsolute(target) ? next : relative(dirname(file), next) });
    }
    let real;
    try { real = realpathSync(file); } catch (error) { if (!relink.some((r) => r.path === file)) errors.push(`配置 ${file} 是断掉的链接（${error.code}）`); continue; }
    const text = readTextOr(real, errors);
    if (text === null) continue;
    const { count, problems } = analyzeConfig(text, kind, rules);
    if (!count) continue;
    rewrite.push({ file, real, kind, count, problems });
  }
  const reportOnly = [];
  for (const file of reportOnlyFiles(home, errors)) {
    const text = readTextOr(file, errors);
    if (text === null) continue;
    const lines = text.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => countRefs(l, rules));
    if (lines.length) reportOnly.push({ file, lines: lines.slice(0, 8) });
  }
  const cron = sh("crontab", ["-l"], [], { okCodes: [0, 1] });
  if (cron === null) errors.push("读不了 crontab");
  else if (cron.status === 0) {
    const cronLines = cron.stdout.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => countRefs(l, rules));
    if (cronLines.length) reportOnly.push({ file: "crontab -l", lines: cronLines });
  } else if (!/no crontab/i.test(cron.stderr)) errors.push(`读不了 crontab（${cron.stderr.trim().slice(0, 120)}）`);
  return { rewrite, relink, reportOnly };
}
