import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("..", import.meta.url));

function fixture(context, script = "node regression.mjs") {
  const root = mkdtempSync(join(tmpdir(), "ash accept-test "));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  for (const name of ["accept-test.mjs", "npm.mjs"]) {
    cpSync(join(repo, "scripts", name), join(root, "scripts", name));
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({
    private: true,
    scripts: { "test:web": script },
  }));
  writeFileSync(join(root, "regression.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync("ran.json", JSON.stringify({ cwd: process.cwd(), event: process.env.npm_lifecycle_event }));
    console.log("REGRESSION_STDOUT");
    console.error("REGRESSION_STDERR");
    process.exit(Number(process.env.ACCEPT_TEST_EXIT ?? 0));
  `);
  return root;
}

function run(root, env = {}) {
  return spawnSync(process.execPath, [join(root, "scripts", "accept-test.mjs")], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

test("从外部目录调用也在脚本所属项目跑完整回归，并透传日志", (context) => {
  const root = fixture(context);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ran = JSON.parse(readFileSync(join(root, "ran.json"), "utf8"));
  assert.equal(ran.event, "test:web");
  assert.equal(readFileSync(join(ran.cwd, "ran.json"), "utf8"), JSON.stringify(ran));
  assert.match(result.stdout, /REGRESSION_STDOUT/);
  assert.match(result.stderr, /REGRESSION_STDERR/);
  assert.match(result.stdout, /前端回归通过/);
  assert.equal(existsSync(join(root, "node_modules")), false);
});

test("测试失败保留非零退出码，不冒充验收成功", (context) => {
  const result = run(fixture(context), { ACCEPT_TEST_EXIT: "7" });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.match(result.stdout, /前端回归未通过/);
  assert.doesNotMatch(result.stdout, /前端回归通过/);
});

test("旧推送开关和空 stdin 不会绕过验收测试", (context) => {
  const root = fixture(context);
  const result = run(root, { SKIP_WEB_TEST: "1", ACCEPT_TEST_EXIT: "3" });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(existsSync(join(root, "ran.json")), true);
});

test("依赖缺失导致测试无法启动时拒绝放行", (context) => {
  const result = run(fixture(context, "node missing-regression.mjs"));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /前端回归未通过/);
});

test("npm 不可用时返回失败", (context) => {
  const result = run(fixture(context), { PATH: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /前端回归未通过/);
});

test("推送钩子已移除，验收命令指向独立入口", () => {
  assert.equal(existsSync(join(repo, ".githooks", "pre-push")), false);
  assert.equal(existsSync(join(repo, "scripts", "web-test-gate.mjs")), false);
  const { scripts } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.equal(scripts["test:accept"], "node scripts/accept-test.mjs");
});
