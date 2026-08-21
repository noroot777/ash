// 仓库地址的解析规则。住在 shared 是因为**两端要算出同一个答案**：前端在表单里按地址
// 自动填目录名和项目名，服务端在名字留空时也照同一条规则兜底。各写一份的话，用户在表单里
// 看到的目录名和库里最终记下的名字会悄悄分叉。
//
// 这里只做「地址长什么样」的判断，不判断它是否可达 —— 那要联网，且只有服务端说了算。

/**
 * 从仓库地址取仓库名：`https://host/foo/bar.git` → `bar`，`git@host:foo/bar` → `bar`，
 * `ssh://host:22/foo/bar/` → `bar`。取不出来返回空串（调用方自己决定兜底值）。
 *
 * 按 `/` 和 `:` 一起切：scp 形式的 `git@host:foo/bar` 里，主机和路径之间是冒号而不是
 * 斜杠，只切斜杠会把 `git@host:foo` 整段当成一节。
 */
export function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[/\\]+$/, "");
  if (!trimmed) return "";
  const tail = trimmed.split(/[/:\\]/).filter(Boolean).pop() ?? "";
  return tail.replace(/\.git$/i, "");
}

/**
 * 地址明显不对时给一句人话，没问题返回 null。**只挡显然写错的**：真正的判据是 git 自己
 * 克隆成功与否，前端在这里拦一道只是为了不让人白等一次网络往返。
 *
 * `-` 开头那条跟服务端是同一个理由（会被 git 当选项解析），服务端另有硬拦。
 */
export function repoUrlError(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null; // 空 = 还没填，不是错
  if (trimmed.startsWith("-")) return "仓库地址不能以 - 开头";
  if (/\s/.test(trimmed)) return "仓库地址里不能有空格";
  // 所有真实形式都至少有一个分隔符：`https://…/x`、`git@host:x`、`/path/to/repo`。
  if (!/[/:]/.test(trimmed)) return "看起来不像仓库地址（缺少 / 或 :）";
  return null;
}
