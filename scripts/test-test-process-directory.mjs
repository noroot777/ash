import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestProcessScope, disposeTestProcessResourcesSync, disposeTestScopesSync } from "./test-process-scope.mjs";
import { cleanupTestResources, withTestResources } from "./test-process-resources.mjs";
import native from "./test-process-native.cjs";

const temporary = fs.mkdtempSync(join(tmpdir(), "ash-test-directory-"));
const cleanup = fileURLToPath(new URL("test-process-cleanup.mjs", import.meta.url));
const scopeURL = new URL("test-process-scope.mjs", import.meta.url).href;
const owned = [];
const links = [];
const makeScope = () => { const scope = new TestProcessScope(); owned.push(scope); return scope; };
const runCleanup = (directory, input) => spawnSync(process.execPath, [cleanup, ...(input ? [] : [directory])], {
  encoding: "utf8", input: input && JSON.stringify(input), timeout: 30_000,
});
const makeVictim = (directory) => {
  fs.mkdirSync(join(directory, "nested"), { recursive: true });
  fs.writeFileSync(join(directory, "nested", "data.txt"), "UNRELATED_DATA");
};
const assertVictim = (directory) => {
  assert.equal(fs.readFileSync(join(directory, "nested", "data.txt"), "utf8"), "UNRELATED_DATA");
  assert.equal(fs.existsSync(join(directory, "stopped")), false);
};

await withTestResources(async () => {
  const victim = join(temporary, "unrelated");
  makeVictim(victim);
  assert.throws(() => new TestProcessScope(victim), { code: "EOWNERSHIP" });
  assert.throws(() => new TestProcessScope(victim, { name: "unproven", executable: "unproven" }), { code: "EOWNERSHIP" });
  for (const input of [undefined, [{ directory: victim }]]) {
    const result = runCleanup(victim, input);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /拒绝清理无法确认归属/);
    assert.match(result.stdout, /ASH_TEST_SCOPE_CLEANUP=\[\]/);
    assertVictim(victim);
  }
  const implicit = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict'; import {TestProcessScope} from ${JSON.stringify(scopeURL)};
    assert.throws(() => new TestProcessScope(${JSON.stringify(victim)}), {code:'EOWNERSHIP'});
    console.log('REFUSED_BEFORE_EXIT');
  `], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(implicit.error);
  assert.equal(implicit.status, 0, implicit.stderr);
  assert.match(implicit.stdout, /REFUSED_BEFORE_EXIT/);
  assertVictim(victim);
  const lookalike = join(temporary, "ash-test-scope-ABC123");
  makeVictim(lookalike);
  assert.throws(() => new TestProcessScope(lookalike), { code: "EOWNERSHIP" });
  assertVictim(lookalike);
  console.log("✓ 无关目录在构造/argv/stdin/正常退出均拒收,不写 stopped、不递归删除,异地同名前缀也不算归属");

  for (const [filename, content] of [["started", "not-a-timestamp"], ["domain.json", "null"], ["domain.json", "{}"]]) {
    const malformed = join(temporary, `malformed-${filename}-${content.length}`);
    makeVictim(malformed);
    fs.writeFileSync(join(malformed, filename), content);
    assert.throws(() => new TestProcessScope(malformed), { code: "EOWNERSHIP" });
    assert.equal(fs.readFileSync(join(malformed, filename), "utf8"), content);
    assertVictim(malformed);
  }
  const slot = new TestProcessScope();
  const link = slot.directory;
  slot.remove();
  links.push(link);
  fs.symlinkSync(victim, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => new TestProcessScope(link), { code: "EOWNERSHIP" });
  assert.equal(runCleanup(link).status, 1);
  assertVictim(victim);
  fs.rmSync(link, { recursive: true, force: true });
  console.log("✓ 非法标记/空域描述与临时命名空间中的符号链接拒收,目标目录及内容保持不变");

  const partial = makeScope();
  fs.unlinkSync(join(partial.directory, "started"));
  fs.writeFileSync(join(partial.directory, "leftover.lock"), "partial");
  const recovered = new TestProcessScope(partial.directory);
  owned.push(recovered);
  await recovered.stop();
  recovered.remove();
  assert.equal(fs.existsSync(partial.directory), false);
  const marked = join(temporary, "marked-domain");
  fs.mkdirSync(marked);
  fs.writeFileSync(join(marked, "started"), "12345");
  const remembered = new TestProcessScope(marked);
  owned.push(remembered);
  assert.throws(() => { remembered.directory = victim; }, TypeError);
  assert.throws(() => { remembered.directoryIdentity.ino = "0"; }, TypeError);
  fs.unlinkSync(join(marked, "started"));
  fs.writeFileSync(join(marked, "leftover.lock"), "partial");
  disposeTestScopesSync();
  disposeTestScopesSync();
  assert.equal(fs.existsSync(marked), false);
  assertVictim(victim);
  console.log("✓ 精确临时命名空间的残壳与原进程记住的目录实例仍可回收,路径/身份不可改写");

  const replaced = makeScope();
  const saved = join(temporary, "original-scope");
  await withTestResources(async () => {
    fs.renameSync(replaced.directory, saved);
    makeVictim(replaced.directory);
    await assert.rejects(() => replaced.stop(), (error) => error.errors.some((entry) => entry.code === "EOWNERSHIP"));
    assert.throws(() => replaced.remove(), { code: "EOWNERSHIP" });
    assert.throws(() => disposeTestScopesSync(), /拒绝清理无法确认归属/);
    assertVictim(replaced.directory);
  }, [
    () => { if (fs.existsSync(saved)) fs.rmSync(replaced.directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 }); },
    () => { if (fs.existsSync(saved)) fs.renameSync(saved, replaced.directory); },
    () => replaced.stop(), () => replaced.remove(),
  ]);
  console.log("✓ 同路径替换目录在直接停止/回收和退出子进程均拒写拒删,恢复原目录后可正常退役");

  const vanished = makeScope();
  fs.rmSync(vanished.directory, { recursive: true, force: true });
  const absent = new TestProcessScope(vanished.directory);
  owned.push(absent);
  await absent.stop();
  absent.remove();
  vanished.remove();
  await withTestResources(async () => {
    makeVictim(absent.directory);
    assert.throws(() => absent.remove(), { code: "EOWNERSHIP" });
    assertVictim(absent.directory);
  }, [() => fs.rmSync(absent.directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 })]);
  console.log("✓ 已消失路径可幂等清理,无原实例的旧对象不能删除后来新建的同路径目录");

  if (process.platform === "win32") {
    const active = makeScope();
    active.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const domain = { ...active.domain };
    fs.unlinkSync(join(active.directory, "started"));
    const restored = new TestProcessScope(active.directory);
    owned.push(restored);
    assert.deepEqual(restored.domain, domain);
    assert.ok((await restored.active()).length > 0);
    disposeTestScopesSync();
    assert.equal(fs.existsSync(active.directory), false);
    assert.deepEqual(JSON.parse(native.invoke(native.executable(), ["state", domain.name])), { exists: false, processes: [] });
    console.log("✓ Windows 目录实例跨进程身份一致,仅剩 domain.json 仍恢复并终止真实活动 Job");
  } else console.log(`⏭ ${process.platform}: 无原生后端,不声称 Windows Job 业务通过`);
}, [
  () => cleanupTestResources(owned.flatMap((scope) => [() => scope.stop(), () => scope.remove()])),
  disposeTestProcessResourcesSync,
  () => cleanupTestResources(links.map((link) => () => fs.rmSync(link, { recursive: true, force: true }))),
  () => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 }),
]);
