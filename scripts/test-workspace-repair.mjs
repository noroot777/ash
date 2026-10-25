import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairEmptyWorkspaces } from "./workspace-repair.mjs";
import { inspectWorkspaces } from "./workspace-check.mjs";

const temporary = mkdtempSync(join(tmpdir(), "ash-workspace-repair-"));
let number = 0;

function fixture(workspaces = ["shared", "server", "web", "mcp"]) {
  const repo = join(temporary, String(++number));
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "-q");
  git("config", "user.name", "Workspace test");
  git("config", "user.email", "workspace@example.invalid");
  git("config", "core.hooksPath", join(temporary, "no-hooks"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ workspaces }));
  for (const directory of workspaces) {
    mkdirSync(join(repo, directory), { recursive: true });
    writeFileSync(join(repo, directory, "package.json"), JSON.stringify({ name: `@ash/${directory}` }));
    writeFileSync(join(repo, directory, "source.txt"), `source of ${directory}`);
  }
  git("add", ".");
  git("commit", "-qm", "fixture");
  const empty = (directory) => {
    rmSync(join(repo, directory), { recursive: true });
    mkdirSync(join(repo, directory));
  };
  return { repo, git, empty };
}

try {
  {
    const { repo, git, empty } = fixture();
    for (const directory of ["shared", "server", "web", "mcp"]) empty(directory);
    assert.equal(inspectWorkspaces(repo).ok, false);
    assert.deepEqual(repairEmptyWorkspaces(repo).restored, ["shared", "server", "web", "mcp"]);
    assert.equal(inspectWorkspaces(repo).ok, true);
    assert.equal(git("status", "--porcelain"), "");
    assert.deepEqual(repairEmptyWorkspaces(repo).restored, []);
  }
  {
    const { repo, git, empty } = fixture();
    empty("server");
    git("add", "server");
    const before = git("diff", "--cached");
    const repaired = repairEmptyWorkspaces(repo);
    assert.deepEqual(repaired.restored, []);
    assert.match(repaired.warnings[0], /暂存区/);
    assert.equal(git("diff", "--cached"), before);
    assert.equal(existsSync(join(repo, "server", "package.json")), false);
  }
  {
    const { repo, empty } = fixture();
    empty("web");
    writeFileSync(join(repo, "web", "source.txt"), "uncommitted work");
    assert.deepEqual(repairEmptyWorkspaces(repo).restored, []);
    assert.equal(readFileSync(join(repo, "web", "source.txt"), "utf8"), "uncommitted work");
    assert.equal(existsSync(join(repo, "web", "package.json")), false);
  }
  {
    const { repo, empty } = fixture();
    empty("mcp");
    rmSync(join(repo, "mcp"), { recursive: true });
    const outside = join(temporary, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, "mcp"), process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(repairEmptyWorkspaces(repo).restored, []);
    assert.equal(existsSync(join(outside, "package.json")), false);
  }
  {
    const { repo, git, empty } = fixture();
    empty("shared");
    git("config", "core.sparseCheckout", "true");
    assert.deepEqual(repairEmptyWorkspaces(repo).restored, []);
  }
  {
    const { repo, empty } = fixture();
    empty("shared");
    rmSync(join(repo, ".git"), { recursive: true });
    assert.deepEqual(repairEmptyWorkspaces(repo).restored, []);
  }
  {
    const { repo } = fixture();
    rmSync(join(repo, "server"), { recursive: true });
    assert.deepEqual(repairEmptyWorkspaces(repo).restored, ["server"]);
    writeFileSync(join(repo, "server", "package.json"), "broken JSON");
    assert.deepEqual(repairEmptyWorkspaces(repo).restored, []);
    assert.equal(readFileSync(join(repo, "server", "package.json"), "utf8"), "broken JSON");
  }
  console.log("✓ empty workspace recovery: deletion, index protection, existing files, links, sparse checkout, archive, invalid JSON");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
