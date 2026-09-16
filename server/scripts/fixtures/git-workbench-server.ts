import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "ash-git-workbench-browser-")),
);
process.env.ASH_DB = join(directory, "ash.db");
delete process.env.ASH_PREVIEW;
process.env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(
  process.env.GIT_CONFIG_GLOBAL,
  "[user]\nname = Ash Browser Test\nemail = browser@example.test\n[commit]\ngpgsign = false\n",
);
const root = join(directory, "repo");
const remote = join(directory, "origin.git");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const write = (path: string, value: string) =>
  writeFileSync(join(root, path), value);
execFileSync("git", ["init", "-q", "-b", "main", root]);
execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
write(
  "sample.txt",
  "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\n",
);
write("conflict.txt", "base\n");
git("add", ".");
git("commit", "-qm", "初始化示例仓库");
const base = git("rev-parse", "HEAD");
git("checkout", "-qb", "feature/conflict");
write("conflict.txt", "feature version\n");
git("commit", "-qam", "功能分支改动");
git("checkout", "-q", "main");
write("conflict.txt", "main version\n");
git("commit", "-qam", "主分支改动");
for (let i = 1; i <= 3; i++) {
  write(`history-${i}.txt`, `history ${i}\n`);
  git("add", ".");
  git("commit", "-qm", `历史提交 ${i}`);
}
git("branch", "feature/clean");
git("tag", "v0.1", base);
git("remote", "add", "origin", remote);
git("push", "-qu", "origin", "main");
write(
  "sample.txt",
  "alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\nIOTA\nkappa\n",
);
write("新增文件.txt", "new file\n");
const secondRoot = join(directory, "repo-alt");
const secondRemote = join(directory, "origin-alt.git");
const secondGit = (...args: string[]) =>
  execFileSync("git", ["-C", secondRoot, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const secondWrite = (path: string, value: string) =>
  writeFileSync(join(secondRoot, path), value);
execFileSync("git", ["init", "-q", "-b", "main", secondRoot]);
execFileSync("git", ["init", "--bare", "-q", "-b", "main", secondRemote]);
secondWrite("alternate.txt", "alternate repository\n");
secondGit("add", ".");
secondGit("commit", "-qm", "备用仓库初始提交");
secondWrite("alternate.txt", "alternate repository\nsecond revision\n");
secondGit("commit", "-qam", "备用仓库独有历史");
secondGit("remote", "add", "origin", secondRemote);
secondGit("push", "-qu", "origin", "main");
secondWrite("alternate.txt", "alternate repository\nsecond revision\nuncommitted\n");
const nonGitRoot = join(directory, "plain-directory");
mkdirSync(nonGitRoot);
writeFileSync(join(nonGitRoot, "README.txt"), "This directory is intentionally not a Git repository.\n");
const { Hono } = await import("hono");
const { serve } = await import("@hono/node-server");
const { db, dbClient, ensureSchema } = await import("../../src/db/index.js");
const { projects } = await import("../../src/db/schema.js");
const { mountGitWorkbenchRoutes } = await import(
  "../../src/git-workbench/routes.js"
);
const { mountProjectGitRoutes } = await import(
  "../../src/project-git-routes.js"
);
await ensureSchema();
const projectId = "workbench-browser";
const secondProjectId = "workbench-browser-alt";
const nonGitProjectId = "workbench-browser-plain";
await db
  .insert(projects)
  .values([
    {
      id: projectId,
      name: "Git 工作台验证",
      repoPath: root,
      createdAt: new Date().toISOString(),
    },
    {
      id: secondProjectId,
      name: "备用 Git 项目",
      repoPath: secondRoot,
      createdAt: new Date().toISOString(),
    },
    {
      id: nonGitProjectId,
      name: "普通目录项目",
      repoPath: nonGitRoot,
      createdAt: new Date().toISOString(),
    },
  ]);
const app = new Hono();
const api = new Hono();
mountGitWorkbenchRoutes(api);
mountProjectGitRoutes(api);
app.route("/api", api);
const server = serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
  (info) => {
    console.log(
      JSON.stringify({
        port: info.port,
        projectId,
        root,
        base,
        secondProjectId,
        secondRoot,
        nonGitProjectId,
        nonGitRoot,
        directory,
      }),
    );
  },
);
let closed = false;
const close = () => {
  if (closed) return;
  closed = true;
  server.close(() => {
    dbClient.close();
    rmSync(directory, { recursive: true, force: true });
    if (process.connected) process.disconnect();
    process.exit(0);
  });
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
process.on("message", (message) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "close"
  ) {
    close();
  }
});
