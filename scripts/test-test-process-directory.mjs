import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestProcessScope, disposeTestProcessResourcesSync, disposeTestScopesSync } from "./test-process-scope.mjs";
import { cleanupTestResources, withTestResources } from "./test-process-resources.mjs";
import native from "./test-process-native.cjs";

const temporary = fs.mkdtempSync(join(tmpdir(), "ash-test-directory-"));
const cleanup = fileURLToPath(new URL("test-process-cleanup.mjs", import.meta.url));
const scopeURL = new URL("test-process-scope.mjs", import.meta.url).href;
const owned = [];
const links = [];
const victims = [];
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

  const credentials = makeScope();
  for (const shape of ["started", "domain", "temporary-name", "copied-record"]) {
    const directory = shape === "temporary-name" ? fs.mkdtempSync(join(tmpdir(), "ash-test-scope-")) : join(temporary, shape);
    victims.push(directory);
    makeVictim(directory);
    if (shape === "started") fs.writeFileSync(join(directory, "started"), "1762000000000");
    if (shape === "domain") fs.writeFileSync(join(directory, "domain.json"), JSON.stringify({ name: "x", executable: "y" }));
    if (shape === "copied-record") fs.copyFileSync(credentials.directoryOwnership.record, join(directory, "ownership.json"));
    assert.throws(() => new TestProcessScope(directory), { code: "EOWNERSHIP" });
    const stat = fs.lstatSync(directory, { bigint: true });
    const identity = { dev: String(stat.dev), ino: String(stat.ino) };
    assert.throws(() => new TestProcessScope(directory, undefined, identity), { code: "EOWNERSHIP" });
    const borrowed = { ...credentials.directoryOwnership, directoryIdentity: identity };
    assert.throws(() => new TestProcessScope(directory, undefined, borrowed), { code: "EOWNERSHIP" });
    for (const input of [undefined, [{ directory }], [{ directory, directoryOwnership: borrowed }]]) {
      const result = runCleanup(directory, input);
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assertVictim(directory);
    }
  }
  console.log("✓ 数字 started/完整 domain/临时目录名/复制凭证文件均不授予归属,仅知道 dev:ino 或借用别域凭证也拒收");

  const authorized = makeScope();
  const proof = authorized.directoryOwnership;
  const originalRecord = fs.readFileSync(proof.record, "utf8");
  const wrongProof = { ...proof, token: randomBytes(32).toString("hex") };
  assert.notEqual(wrongProof.token, proof.token);
  assert.throws(() => new TestProcessScope(authorized.directory, undefined, wrongProof), { code: "EOWNERSHIP" });
  assert.equal(runCleanup(authorized.directory, [{ directory: authorized.directory, directoryOwnership: wrongProof }]).status, 1);
  assert.equal(fs.existsSync(join(authorized.directory, "stopped")), false);
  await withTestResources(async () => {
    fs.writeFileSync(proof.record, JSON.stringify({ ...JSON.parse(originalRecord), token: wrongProof.token }));
    await assert.rejects(() => authorized.stop(), (error) => error.errors.some((entry) => entry.code === "EOWNERSHIP"));
    assert.throws(() => authorized.remove(), { code: "EOWNERSHIP" });
    assert.equal(fs.existsSync(join(authorized.directory, "stopped")), false);
    fs.unlinkSync(proof.record);
    assert.throws(() => authorized.remove(), { code: "ENOENT" });
  }, [() => fs.writeFileSync(proof.record, originalRecord)]);
  assert.throws(() => { authorized.directoryOwnership.token = "changed"; }, TypeError);
  assert.throws(() => { authorized.directoryOwnership.directoryIdentity.ino = "0"; }, TypeError);
  fs.unlinkSync(join(authorized.directory, "started"));
  const request = [{ directory: authorized.directory, directoryOwnership: proof }];
  const result = spawnSync(process.execPath, [cleanup, "--scopes", JSON.stringify(request)], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(authorized.directory), false);
  assert.equal(fs.existsSync(dirname(proof.record)), false);
  await withTestResources(async () => {
    makeVictim(authorized.directory);
    assert.equal(runCleanup(authorized.directory, request).status, 1);
    assertVictim(authorized.directory);
  }, [() => fs.rmSync(authorized.directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 })]);
  console.log("✓ 随机凭证不匹配/丢失时拒写拒删,有效跨进程凭证可回收残壳和独立凭证目录,旧凭证不能重放删除新目录");

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
  const remembered = makeScope();
  const marked = remembered.directory;
  assert.throws(() => { remembered.directory = victim; }, TypeError);
  assert.throws(() => { remembered.directoryIdentity.ino = "0"; }, TypeError);
  fs.unlinkSync(join(marked, "started"));
  fs.writeFileSync(join(marked, "leftover.lock"), "partial");
  disposeTestScopesSync();
  disposeTestScopesSync();
  assert.equal(fs.existsSync(marked), false);
  assertVictim(victim);
  console.log("✓ 两份域元数据缺失时仍由独立凭证恢复残壳,路径/实例身份不可改写");

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

  const raced = makeScope();
  const racedOriginal = join(temporary, "raced-original");
  const invoke = native.invoke;
  await withTestResources(async () => {
    raced.domain = { name: "raced-domain", executable: "raced-controller" };
    native.invoke = () => {
      fs.renameSync(raced.directory, racedOriginal);
      makeVictim(raced.directory);
      return JSON.stringify({ exists: false, processes: [] });
    };
    assert.throws(() => raced.remove(), { code: "EOWNERSHIP" });
    assertVictim(raced.directory);
  }, [
    () => { native.invoke = invoke; raced.domain = undefined; },
    () => { if (fs.existsSync(racedOriginal)) fs.rmSync(raced.directory, { recursive: true, force: true }); },
    () => { if (fs.existsSync(racedOriginal)) fs.renameSync(racedOriginal, raced.directory); },
    () => raced.stop(), () => raced.remove(),
  ]);
  console.log("✓ 内核状态查询期间发生目录替换时,递归删除前再次核对凭证与实例并拒绝误删");

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

  const originals = { mkdtempSync: fs.mkdtempSync, writeFileSync: fs.writeFileSync };
  for (const phase of ["record-directory", "record-write"]) {
    const created = [];
    fs.mkdtempSync = (prefix, ...args) => {
      if (phase === "record-directory" && prefix.includes("ash-test-owner-")) throw Object.assign(new Error("INJECTED_OWNER_EACCES"), { code: "EACCES" });
      const directory = originals.mkdtempSync(prefix, ...args);
      created.push(directory);
      return directory;
    };
    fs.writeFileSync = (target, ...args) => {
      if (phase === "record-write" && String(target).endsWith("ownership.json")) throw Object.assign(new Error("INJECTED_OWNER_ENOSPC"), { code: "ENOSPC" });
      return originals.writeFileSync(target, ...args);
    };
    syncBuiltinESMExports();
    try { assert.throws(() => new TestProcessScope(), { code: phase === "record-directory" ? "EACCES" : "ENOSPC" }); }
    finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
    assert.deepEqual(created.filter((directory) => fs.existsSync(directory)), []);
  }
  console.log("✓ 凭证目录创建/记录写入失败保留初始化原错,自有域目录及独立凭证目录均回滚");

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
  () => cleanupTestResources(victims.map((directory) => () => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 }))),
  () => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 }),
]);
