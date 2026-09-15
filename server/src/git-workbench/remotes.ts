import { isAbsolute } from "node:path";
import type { GitAction, GitWorkbenchState } from "@ash/shared/git-workbench";
import { git, digest, fail, refName } from "./core.js";
import { readScmRemotes } from "../git-status.js";
import { network } from "./sync.js";

const redact = (url: string) =>
  url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1***@");
async function remoteUrls(root: string, name: string) {
  const read = async (key: string) =>
    (
      await git(root, ["config", "--get-all", `remote.${name}.${key}`]).catch(
        () => "",
      )
    )
      .trimEnd()
      .split("\n")
      .filter(Boolean);
  const [urls, pushUrls] = await Promise.all([read("url"), read("pushurl")]);
  return {
    urls,
    pushUrls,
    version: digest(JSON.stringify({ urls, pushUrls })),
  };
}
export async function readRemoteDetails(
  root: string,
): Promise<GitWorkbenchState["remoteDetails"]> {
  return Promise.all(
    (await readScmRemotes(root)).map(async (name) => {
      const details = await remoteUrls(root, name);
      return {
        name,
        version: details.version,
        urls: details.urls.map(redact),
        pushUrls: details.pushUrls.map(redact),
      };
    }),
  );
}
function remoteUrl(url: string): string {
  if (!url || url.startsWith("-") || /[\0\r\n]/.test(url) || url.length > 4096)
    fail("远端地址不合法", 400);
  if (isAbsolute(url) || /^[A-Za-z]:[\\/]/.test(url)) return url;
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (!["https:", "http:", "ssh:", "git:", "file:"].includes(parsed.protocol))
      fail("远端仅支持 HTTP、SSH、Git 或本地路径", 400);
    if (
      parsed.password ||
      (["https:", "http:"].includes(parsed.protocol) && parsed.username)
    )
      fail("请在项目 Git 凭证设置中配置账号令牌，远端地址中不要嵌入凭证", 400);
    return url;
  } catch (error) {
    if (error instanceof TypeError)
      fail("请输入完整 Git 远端 URL 或绝对路径", 400);
    throw error;
  }
}
export async function runRemoteAction(
  root: string,
  projectId: string,
  action: GitAction,
): Promise<boolean> {
  if (
    ![
      "remote-add",
      "remote-url",
      "remote-remove",
      "remote-delete-ref",
    ].includes(action.kind)
  )
    return false;
  if (action.kind === "remote-delete-ref") {
    if (!(await readScmRemotes(root)).includes(action.remote))
      fail("远端已不存在");
    await refName(
      root,
      action.name,
      action.refKind === "tag" ? "tags" : "heads",
    );
    const ref = `refs/${action.refKind === "tag" ? "tags" : "heads"}/${action.name}`;
    await network(root, projectId, [
      "push",
      `--force-with-lease=${ref}:${action.sha}`,
      "--",
      action.remote,
      `:${ref}`,
    ]);
    return true;
  }
  if (
    action.kind !== "remote-add" &&
    action.kind !== "remote-url" &&
    action.kind !== "remote-remove"
  )
    return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(action.name))
    fail("远端名称仅支持字母、数字、点、横线和下划线", 400);
  if (action.kind !== "remote-add") {
    if (!(await readScmRemotes(root)).includes(action.name))
      fail("远端已不存在");
    if ((await remoteUrls(root, action.name)).version !== action.version)
      fail("远端配置已经改变，请刷新后重新确认");
  }
  if (action.kind === "remote-remove")
    await git(root, ["remote", "remove", action.name]);
  else if (action.kind === "remote-add")
    await git(root, [
      "remote",
      "add",
      "--",
      action.name,
      remoteUrl(action.url),
    ]);
  else
    await git(root, [
      "remote",
      "set-url",
      "--",
      action.name,
      remoteUrl(action.url),
    ]);
  return true;
}
