// 发版脚本跟 GitHub 说话的那一层：有 gh 就用 gh 拿凭证，没有就退回环境变量和 git 自己存的凭证，
// 一律直接打 REST API（不依赖 gh 的子命令行为）。传附件和改 appcast 都走这一张凭证 —— 不另起
// git 子进程去推（那样用的是 git 自己的凭证，和这里查过权限的不是同一个身份）。
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

// ASH_MAC_GITHUB_API 只给回归测试指向一个本地假的 GitHub。
const API = process.env.ASH_MAC_GITHUB_API || "https://api.github.com";

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
  "找不到能调 GitHub API 的凭证，或者它对 release.json 里的两个仓库（releaseRepo 放安装包、feedRepo 放 appcast）不是都能写。",
  "任选一种（传附件、改 appcast 都只用这一张）：",
  "  · 装 gh 并登录：brew install gh && gh auth login",
  "  · 或者给一个对这两个仓库都有 contents 写权限的 token：export GH_TOKEN=…（fine-grained token，两个仓库都选上，权限 Contents: Read and write）",
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

  /**
   * 这张凭证能不能往仓库里写（建 Release、传附件、改 appcast 都是同一项 Contents 写权限）。
   * 仓库信息里的 permissions.push 说的是账号对仓库的权限，不是这张 token 的：fine-grained token 没选这个
   * 仓库、或没给 Contents 写权限时它照样是 true。所以真写一次 —— 建一个不挂到任何提交、分支上的 blob：
   * 和改文件同一项权限，外面看不见，没有引用会被 GitHub 回收。
   */
  async canWrite(repo) {
    if (!(await this.call("GET", `/repos/${repo}`)).json?.permissions?.push) return false;
    const { status } = await this.call("POST", `/repos/${repo}/git/blobs`, {
      body: { content: "ash release: write check", encoding: "utf-8" }, allow: [401, 403, 404, 422],
    });
    return status === 201;
  }

  /**
   * 分支上挡着「经 Contents API 直接提交」的东西：经典分支保护，或 ruleset 里除了不许删、不许强推、
   * 线性历史以外的规则（要 PR、限制更新、要状态检查……）。读不到详情（要管理员权限）也算挡着：
   * 证明不了能直接提交，就当不能。
   */
  async branchRestrictions(repo, branch) {
    const found = [];
    const { status, json } = await this.call("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`, { allow: [404] });
    if (status === 404) return [`分支 ${branch} 不存在`];
    if (json.protected) found.push("开着分支保护");
    const rules = (await this.call("GET", `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`, { allow: [404] })).json || [];
    for (const rule of rules) if (!HARMLESS_RULES.has(rule.type)) found.push(`ruleset 规则 ${rule.type}`);
    return found;
  }

  /** 仓库里有没有这个提交（短 sha 也认），有就给出完整 sha，没有是 null。 */
  async commitSha(repo, ref) {
    const { status, json } = await this.call("GET", `/repos/${repo}/commits/${encodeURIComponent(ref)}`, { allow: [404, 422] });
    return status === 404 || status === 422 ? null : json.sha;
  }

  /** 读分支上的一个文件：{ sha, text }；不存在是 null。 */
  async readFile(repo, path, branch) {
    const { status, json } = await this.call("GET", `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`, { allow: [404] });
    if (status === 404) return null;
    if (json.encoding !== "base64") throw new Error(`${repo}/${path} 太大，Contents API 不给内容（${json.size} 字节）`);
    return { sha: json.sha, text: Buffer.from(json.content, "base64").toString("utf8") };
  }

  /**
   * 在分支上提交一个文件的新内容。`sha` 是读出来时那一版（新文件不传）：这期间别人改过，
   * GitHub 拒绝（409），不会盖掉别人的改动。
   */
  async writeFile(repo, { path, branch, text, sha, message }) {
    return (await this.call("PUT", `/repos/${repo}/contents/${encodePath(path)}`, {
      body: { message, branch, content: Buffer.from(text, "utf8").toString("base64"), ...(sha ? { sha } : {}) },
    })).json;
  }

  /** 建公开仓库（带一个初始提交，这样 main 分支一开始就在）。 */
  async createPublicRepo(repo, description) {
    const [owner, name] = repo.split("/");
    const me = (await this.call("GET", "/user")).json.login;
    const path = owner === me ? "/user/repos" : `/orgs/${owner}/repos`;
    return (await this.call("POST", path, { body: { name, description, private: false, auto_init: true } })).json;
  }

  /** 这个 tag 的 Release，草稿也算（草稿还没有 tag，按 tag 查不到，只能从列表里认 tag_name）。 */
  async findRelease(repo, tag) {
    const { status, json } = await this.call("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allow: [404] });
    if (status !== 404) return json;
    const list = (await this.call("GET", `/repos/${repo}/releases?per_page=100`)).json || [];
    return list.find((release) => release.draft && release.tag_name === tag) ?? null;
  }

  /** tag 指向哪个提交（附注 tag 剥到底）；tag 不存在是 null。 */
  async tagCommit(repo, tag) {
    const { status, json } = await this.call("GET", `/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, { allow: [404] });
    if (status === 404) return null;
    let object = json.object;
    for (let depth = 0; object.type === "tag" && depth < 5; depth++) {
      object = (await this.call("GET", `/repos/${repo}/git/tags/${object.sha}`)).json.object;
    }
    return object.type === "commit" ? object.sha : null;
  }

  /** 建草稿 Release：谁都看不见，tag 要到公开时才在 target（分支名或完整 sha）上打出来。 */
  async createDraftRelease(repo, { tag, target, name, body }) {
    return (await this.call("POST", `/repos/${repo}/releases`, {
      body: { tag_name: tag, target_commitish: target, name, body, draft: true, prerelease: false },
    })).json;
  }

  /** 草稿 → 公开（draft=false）或退回草稿（draft=true）。 */
  async setDraft(repo, release, draft) {
    return (await this.call("PATCH", `/repos/${repo}/releases/${release.id}`, { body: { draft } })).json;
  }

  /** 经 API 下回一个附件（草稿的附件也下得到，公开地址那时还不通）。 */
  async downloadAsset(asset) {
    const response = await fetch(asset.url, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/octet-stream", "x-github-api-version": "2022-11-28" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`下载附件 ${asset.name} → HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
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
      headers: { "content-type": CONTENT_TYPES[extname(name)] || "application/octet-stream", "content-length": String(size) },
    })).json;
  }
}

const HARMLESS_RULES = new Set(["deletion", "non_fast_forward", "required_linear_history"]);
const CONTENT_TYPES = { ".dmg": "application/x-apple-diskimage", ".zip": "application/zip" };
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
