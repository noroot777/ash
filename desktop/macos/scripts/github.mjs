// 发版脚本跟 GitHub 说话的那一层：有 gh 就用 gh 拿凭证，没有就退回环境变量和 git 自己存的凭证，
// 一律直接打 REST API（不依赖 gh 的子命令行为）。
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const API = "https://api.github.com";

/** 按顺序找：GH_TOKEN / GITHUB_TOKEN → `gh auth token` → git 凭证助手里 github.com 那一条。 */
export function resolveToken() {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    if (process.env[name]?.trim()) return { token: process.env[name].trim(), source: name };
  }
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (gh.status === 0 && gh.stdout.trim()) return { token: gh.stdout.trim(), source: "gh auth token" };
  // git push 用的就是这一条（macOS 上通常存在钥匙串里）。只读、不触发交互输入。
  const cred = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });
  const password = cred.status === 0 ? cred.stdout.match(/^password=(.+)$/m)?.[1] : null;
  if (password) return { token: password, source: "git credential" };
  return null;
}

export const NO_TOKEN_HINT = [
  "找不到能调 GitHub API 的凭证。任选一种：",
  "  · 装 gh 并登录：brew install gh && gh auth login",
  "  · 或者给一个有该仓库 contents 写权限的 token：export GH_TOKEN=…（fine-grained token，仓库权限 Contents: Read and write）",
  "  · 或者让 git 记住 github.com 的凭证（git push 过一次、存进钥匙串的那种）",
].join("\n");

export class GitHub {
  constructor(token) {
    this.token = token;
  }

  async call(method, url, { body, headers = {}, allow = [] } = {}) {
    const response = await fetch(url.startsWith("http") ? url : `${API}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
    });
    if (allow.includes(response.status)) return { status: response.status, json: null };
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub ${method} ${url} → HTTP ${response.status}：${text.slice(0, 500)}`);
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  async repoExists(repo) {
    return (await this.call("GET", `/repos/${repo}`, { allow: [404] })).status !== 404;
  }

  /** 建公开仓库（带一个初始提交，这样 main 分支一开始就在）。 */
  async createPublicRepo(repo, description) {
    const [owner, name] = repo.split("/");
    const me = (await this.call("GET", "/user")).json.login;
    const path = owner === me ? "/user/repos" : `/orgs/${owner}/repos`;
    return (await this.call("POST", path, { body: { name, description, private: false, auto_init: true } })).json;
  }

  async releaseByTag(repo, tag) {
    const { status, json } = await this.call("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allow: [404] });
    return status === 404 ? null : json;
  }

  async createRelease(repo, { tag, branch, name, body }) {
    return (await this.call("POST", `/repos/${repo}/releases`, {
      body: { tag_name: tag, target_commitish: branch, name, body, draft: false, prerelease: false },
    })).json;
  }

  /** 传附件。同名附件已经在、大小也对就当传过了；大小不对说明是另一份，拒绝覆盖。 */
  async uploadAsset(release, file) {
    const name = basename(file);
    const size = statSync(file).size;
    const existing = (release.assets || []).find((a) => a.name === name);
    if (existing) {
      if (existing.size === size) return existing;
      throw new Error(`Release ${release.tag_name} 里已经有一份 ${name}，大小 ${existing.size}，和这次的 ${size} 不一样：不覆盖。先在网页上删掉它再重跑。`);
    }
    const url = release.upload_url.replace(/\{.*$/, `?name=${encodeURIComponent(name)}`);
    return (await this.call("POST", url, {
      body: new Uint8Array(readFileSync(file)),
      headers: { "content-type": "application/zip", "content-length": String(size) },
    })).json;
  }
}
