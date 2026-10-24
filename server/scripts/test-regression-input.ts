import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, root, schema, teardown, until } from "./monitors-fixture.js";
import { setupRegression } from "./regression-fixture.js";

const { regressionEvidenceReference } = await import("../src/regression-checks.js");
const { regressionSnapshot } = await import("../src/regression-snapshot.js");

try {
  const { task, repo, git, evidenceDir, manifest, start, wait, run } = await setupRegression();
  const go = join(root, "go");
  const observed = join(root, "observed");
  const finish = join(root, "finish");
  writeFileSync(join(repo, "transient.cjs"), `
    const fs = require('node:fs');
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(go)})) return;
      clearInterval(timer);
      const actual = fs.readFileSync('code.txt', 'utf8');
      fs.writeFileSync(${JSON.stringify(observed)}, actual);
      const end = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(finish)})) return;
        clearInterval(end);
        process.exit(actual === 'good' ? 0 : 1);
      }, 20);
    }, 20);
  `);
  git("add", ".");
  git("commit", "-m", "transient test");
  const transient = await start("node transient.cjs");
  await until("已记录执行前快照", async () => Boolean(
    (await db.select().from(schema.regressionChecks).where(eq(schema.regressionChecks.monitorId, transient)))[0]?.before));
  writeFileSync(join(repo, "code.txt"), "good");
  writeFileSync(go, "go");
  await until("测试实际读取了临时输入", async () => existsSync(observed));
  writeFileSync(join(repo, "code.txt"), "bad");
  writeFileSync(finish, "finish");
  await wait(transient);
  await regressionEvidenceReference(task, repo, evidenceDir);
  const record = manifest().records.find((entry) => entry.monitorId === transient)!;
  assert.equal(record.before?.tree, record.after?.tree);
  assert.equal(readFileSync(observed, "utf8"), "good");
  assert.equal(record.passed, true);
  assert.equal(record.reusable, false, "ABA 内容切换后不能批准当前坏版本复用通过结果");
  assert.match(record.reason, /执行期间源码不可变/);
  assert.equal(spawnSync(process.execPath, ["-e", "process.exit(require('fs').readFileSync('code.txt','utf8')==='good'?0:1)"], { cwd: repo }).status, 1);

  for (const input of ["settings.local", "node_modules/dependency.txt", "dist/build.txt"]) {
    const path = join(repo, input);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "good");
    const command = `node -e "process.exit(require('fs').readFileSync('${input}','utf8')==='good'?0:1)"`;
    const monitorId = await run(command);
    const before = regressionSnapshot(repo);
    writeFileSync(path, "bad");
    assert.equal(before?.tree, regressionSnapshot(repo)?.tree);
    await regressionEvidenceReference(task, repo, evidenceDir);
    const ignored = manifest().records.find((entry) => entry.monitorId === monitorId)!;
    assert.equal(ignored.passed, true);
    assert.equal(ignored.reusable, false, `${input} 不在 Git 树中，输入闭包未核实就必须拒绝复用`);
    assert.match(ignored.reason, /忽略配置、依赖、构建产物、子模块及外部输入闭包未核实/);
  }

  const submodule = join(root, "submodule");
  mkdirSync(submodule);
  const subgit = (...args: string[]) => execFileSync("git", args, { cwd: submodule, encoding: "utf8" });
  subgit("init", "-b", "main");
  subgit("config", "user.name", "Regression Test");
  subgit("config", "user.email", "regression@example.test");
  writeFileSync(join(submodule, "input.txt"), "good");
  subgit("add", ".");
  subgit("commit", "-m", "submodule");
  git("-c", "protocol.file.allow=always", "submodule", "add", submodule, "sub");
  git("commit", "-m", "add submodule");
  const subId = await run("node -e \"process.exit(require('fs').readFileSync('sub/input.txt','utf8')==='good'?0:1)\"");
  const beforeSub = regressionSnapshot(repo);
  writeFileSync(join(repo, "sub", "input.txt"), "bad");
  assert.equal(beforeSub?.tree, regressionSnapshot(repo)?.tree);
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records.find((entry) => entry.monitorId === subId)?.reusable, false);

  await db.update(schema.regressionChecks).set({ inputIdentity: null }).where(eq(schema.regressionChecks.monitorId, transient));
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.match(manifest().records.find((entry) => entry.monitorId === transient)!.reason, /旧记录或未知协议没有不可变输入证明/);
  assert.equal(manifest().records.some((entry) => entry.reusable), false);
  console.log("✓ regression input proof: ABA, ignored config/dependencies/builds, dirty submodule and legacy records fail closed");
} finally {
  await teardown();
}
