import { compareVersions } from "./appcast.mjs";
import { downloadPage, itemDetails, latestItem } from "./release-state.mjs";

export async function updateDownloadChannel(github, config, release) {
  const currentFeed = await github.readFile(config.feedRepo, config.appcastPath, config.feedBranch);
  const latest = itemDetails(latestItem(currentFeed?.text));
  if (latest && compareVersions(latest.version, release.version) > 0) {
    return `Mac 下载页保持在更新源的最新版本（这次补的是 ${release.version}）`;
  }
  if (!latest || latest.version !== release.version || latest.url !== release.url) {
    throw new Error("Mac 下载页未更新：更新源尚未确认这一版及其安装包链接；重跑可补齐。");
  }
  const current = await github.findRelease(config.releaseRepo, config.downloadTag);
  const pointed = current?.body?.match(/<!-- navi-mac-build:([^ >]+) -->/)?.[1];
  if (pointed && compareVersions(pointed, release.version) > 0) return `Mac 下载页留在更新的 ${pointed}`;
  const body = [
    `<!-- navi-mac-build:${release.version} -->`,
    "此页是 Mac 最新稳定版的固定下载入口，不代表此页 tag 的源码版本。",
    "",
    `## Navi ${release.shortVersion}（${release.version}）`,
    "",
    `**[下载 Mac 安装包（Apple 芯片）](${release.url})**`,
    "",
    `要求 Apple 芯片（M 系列）、macOS 14+。[查看这一版的更新说明与源码](${release.page})。`,
    "",
    `安装与首次打开说明：https://github.com/${config.releaseRepo}#mac-客户端`,
    "",
    "已安装 Navi 的用户也可以从菜单「Navi → 检查更新…」升级。",
  ].join("\n");
  const change = { name: "Navi for macOS · 最新稳定版", body, draft: false, prerelease: false, make_latest: "false" };
  if (current?.body === body && current.name === change.name && !current.draft) {
    return `Mac 下载页已经是这一版：${downloadPage(config)}`;
  }
  if (current) {
    await github.call("PATCH", `/repos/${config.releaseRepo}/releases/${current.id}`, { body: change });
  } else {
    await github.call("POST", `/repos/${config.releaseRepo}/releases`, {
      body: { ...change, tag_name: config.downloadTag, target_commitish: await github.commitSha(config.releaseRepo, release.commit) },
    });
  }
  return `Mac 下载页已更新：${downloadPage(config)}`;
}
