import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runtimeManifest } from "../desktop/macos/scripts/runtime-manifest.mjs";
import { isPidAlive, sleep } from "./platform.mjs";
import { runTestProcess } from "./test-process.mjs";
import { spawnTestFixture } from "./test-process-scope.mjs";
import { withTestResources } from "./test-process-resources.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS explicit runtime recovery");
} else {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const mac = join(root, "desktop/macos");
  const temporary = mkdtempSync(join(tmpdir(), "navi-macos-recovery-"));
  const binary = join(temporary, "recovery-probe");
  const schema = createHash("sha256").update("recovery fixture schema").digest("hex");
  const impact = {
    survives: [{ id: "live", title: "可接管但未获保证的任务" }],
    resumes: [{ id: "team", title: "调度台回合" }],
    interrupted: [{ id: "lost", title: "正在起跑的任务", reason: "进程未就绪" }],
    mcpDisrupted: [{ id: "live", title: "可接管但未获保证的任务" }],
    runtimeHandoff: { blocked: [{ id: "ghost", title: "卡住的回合锁", reason: "维护操作在途" }] },
  };

  function makeRuntime(path, version, epoch = schema) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".in-use"), "");
    writeFileSync(join(path, "version.txt"), version);
    const envelope = runtimeManifest(path, epoch);
    writeFileSync(join(path, "runtime-manifest.json"), JSON.stringify(envelope));
    return envelope.id;
  }

  async function scenario(options, operation) {
    const directory = mkdtempSync(join(temporary, "case-"));
    const fixtures = [];
    await withTestResources(async () => {
      const data = join(directory, "data");
      const bundled = join(directory, "Navi.app/Contents/Resources/app");
      const oldSource = join(directory, "old");
      const nextId = makeRuntime(bundled, "next");
      const oldId = makeRuntime(oldSource, "previous", options.incompatible ? "0".repeat(64) : schema);
      const previous = join(data, ".runtimes", oldId);
      mkdirSync(join(data, ".runtimes"), { recursive: true });
      cpSync(oldSource, previous, { recursive: true });
      writeFileSync(join(bundled, "../bundle-users.sh"), "exit 0\n");
      const database = new DatabaseSync(join(data, "navi.db"));
      database.exec("create table tasks (id text); insert into tasks values ('original')");
      database.close();
      if (options.backupFailure) writeFileSync(join(data, "backups"), "not a directory");
      const ready = join(directory, "ready.json");
      const events = join(directory, "events.jsonl");
      const requestMarker = join(directory, "requested");
      const confirmMarker = join(directory, "confirmed");
      const server = join(directory, "fixture.mjs");
      writeFileSync(server, `import {createServer} from 'node:http';
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
const options=${JSON.stringify(options)}, data=${JSON.stringify(data)}, runtime=${JSON.stringify(previous)};
const event=value=>appendFileSync(${JSON.stringify(events)},JSON.stringify(value)+'\\n');
const server=createServer((request,response)=>{
  const requested=existsSync(${JSON.stringify(requestMarker)}),confirmed=existsSync(${JSON.stringify(confirmMarker)});
  const changed=confirmed&&options.change;
  if(request.url==='/api/health'){
    if((requested&&options.unidentified)||changed==='unidentified'){response.writeHead(503);response.end('{}');return}
    response.end(JSON.stringify({ok:true,pid:process.pid,instance:{id:changed==='identity'?'replacement':'original',
      dataDir:changed==='foreign'?data+'-foreign':data,codeDir:runtime,desktop:true,windowPort:45678}}));return;
  }
  if(request.url==='/api/restart-impact'){
    event({impact:true,instance:request.headers['x-ash-instance']});
    response.writeHead(options.impactFailure?500:200);
    response.end(JSON.stringify(options.impactFailure?{error:'cannot classify'}:${JSON.stringify(impact)}));return;
  }
  if(request.url==='/api/runtime-handoff')event({handoff:request.method});
  response.writeHead(409);response.end('blocked');
});
process.on('SIGTERM',()=>{event({signal:true,maintenance:existsSync(data+'/.mac-maintenance.json')});if(!options.stubborn)process.exit(0)});
server.listen(0,'127.0.0.1',()=>writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,port:server.address().port})));`);
      const fixture = spawnTestFixture(process.execPath, [server], { cwd: directory, stdio: "ignore" });
      fixtures.push(fixture);
      for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) await sleep(30);
      assert.ok(existsSync(ready));
      const { pid, port } = JSON.parse(readFileSync(ready, "utf8"));
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(NAVI_|ASH_)/.test(name)));
      const run = async (status, extra = {}) => {
        const result = await runTestProcess(binary, [], {
          cwd: directory, timeout: 45_000,
          env: { ...environment, HOME: directory, NAVI_DATA_DIR: data, NAVI_MAC_RUNTIME: bundled,
            NAVI_MAC_WINDOW_PORT: "45678", NAVI_URL: `http://127.0.0.1:${port}`,
            ANSWERS: "recover,recover", REQUEST_MARKER: requestMarker, CONFIRM_MARKER: confirmMarker, ...extra },
        }, status);
        return result.stdout;
      };
      const recorded = () => existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").map(JSON.parse) : [];
      const backupFiles = () => existsSync(join(data, "backups")) && !options.backupFailure
        ? readdirSync(join(data, "backups")).filter((name) => name.endsWith(".db")) : [];
      await operation({ run, pid, data, previous, next: join(data, ".runtimes", nextId), recorded, backupFiles });
    }, [
      async () => { for (const fixture of fixtures) await fixture.dispose(); },
      () => rmSync(directory, { recursive: true, force: true }),
    ]);
  }

  await withTestResources(async () => {
    await runTestProcess("swiftc", ["-swift-version", "5",
      ...["NaviConfig", "NaviHealth", "DatabaseBackup", "LegacyIdentity", "LoginService", "RestartImpact",
        "ServerControl", "ServerLauncher", "ServerStartLock", "UpdateGate"].map((name) => join(mac, `Sources/${name}.swift`)),
      join(mac, "Tests/Recovery/main.swift"), "-o", binary], { cwd: root });

    for (const answers of ["cancel", "wait", "recover,cancel"]) {
      await scenario({}, async ({ run, pid, data, recorded, backupFiles }) => {
        const output = await run(2, { ANSWERS: answers });
        assert.match(output, /强制切换服务…/);
        assert.equal(isPidAlive(pid), true);
        assert.equal(recorded().some((event) => event.signal || event.handoff), false);
        assert.equal(existsSync(join(data, ".mac-maintenance.json")), false);
        assert.deepEqual(backupFiles(), []);
      });
    }
    console.log("✓ waiting and both cancellation points preserve service, tasks and database");

    for (const options of [{}, { incompatible: true }, { impactFailure: true }]) {
      await scenario(options, async ({ run, pid, data, previous, next, recorded, backupFiles }) => {
        const output = await run(0);
        assert.match(output, /PROMPT 2 打断任务并切换服务？/);
        assert.match(output, /取消\|打断任务并切换/);
        if (options.impactFailure) assert.match(output, /无法取得完整任务清单.*所有任务/);
        else {
          for (const title of ["可接管但未获保证的任务", "调度台回合", "正在起跑的任务", "卡住的回合锁"]) {
            assert.ok(output.split("PROMPT 2")[1].includes(title), output);
          }
        }
        assert.equal(isPidAlive(pid), false);
        assert.deepEqual(recorded().filter((event) => event.signal), [{ signal: true, maintenance: true }]);
        assert.equal(recorded().some((event) => event.handoff), false);
        assert.ok(recorded().filter((event) => event.impact).every((event) => event.instance === "original"));
        assert.equal(backupFiles().length, 1);
        const recovery = JSON.parse(readFileSync(join(data, ".runtime-recovery.json"), "utf8"));
        assert.equal(recovery.previous, realpathSync(previous));
        assert.equal(recovery.next, realpathSync(next));
        const snapshot = new DatabaseSync(recovery.backup);
        assert.equal(snapshot.prepare("select id from tasks").get().id, "original");
        snapshot.close();
        assert.equal(existsSync(join(data, ".mac-maintenance.json")), false);
      });
    }
    console.log("✓ confirmed recovery bypasses permanent blockers and incompatible schemas, retaining backup and rollback identity");

    for (const change of ["identity", "foreign", "unidentified"]) {
      await scenario({ change }, async ({ run, pid, recorded, backupFiles }) => {
        assert.match(await run(1), /本次强制切换已取消/);
        assert.equal(isPidAlive(pid), true);
        assert.equal(recorded().some((event) => event.signal || event.handoff), false);
        assert.deepEqual(backupFiles(), []);
      });
    }
    await scenario({ unidentified: true }, async ({ run, pid, recorded }) => {
      assert.match(await run(1, { ANSWERS: "recover" }), /无法确认本机旧服务的身份/);
      assert.equal(isPidAlive(pid), true);
      assert.equal(recorded().some((event) => event.signal), false);
    });
    console.log("✓ unrecognized services and changed instance, code ownership or identity never receive a shutdown signal");

    await scenario({}, async ({ run, pid }) => {
      assert.match(await run(0, { RECONSIDER: "1", ANSWERS: "wait,recover,recover" }), /MENU 切换新版服务…/);
      assert.equal(isPidAlive(pid), false);
    });
    console.log("✓ the pending-service menu reopens recovery after choosing to wait");

    for (const [options, environment] of [[{}, { HOLD_START_LOCK: "1" }], [{ stubborn: true }, {}]]) {
      await scenario(options, async ({ run, pid, data, backupFiles }) => {
        assert.match(await run(1, environment), /REPORT/);
        assert.equal(isPidAlive(pid), true);
        assert.equal(existsSync(join(data, ".mac-maintenance.json")), false);
        assert.deepEqual(backupFiles(), []);
      });
    }
    await scenario({ backupFailure: true }, async ({ run, data }) => {
      assert.match(await run(1), /备份库没成功/);
      assert.equal(existsSync(join(data, ".runtime-recovery.json")), false);
      const database = new DatabaseSync(join(data, "navi.db"));
      assert.equal(database.prepare("select id from tasks").get().id, "original");
      database.close();
    });
    console.log("✓ launch-lock contention, unresponsive shutdown and failed backup prevent migration and release maintenance");

    await scenario({ incompatible: true }, async ({ run, data }) => {
      assert.match(await run(0, { ROLLBACK: "1" }), /RESTORED/);
      const database = new DatabaseSync(join(data, "navi.db"));
      assert.equal(database.prepare("select id from tasks").get().id, "original");
      assert.equal(database.prepare("select name from sqlite_master where name='failed_migration'").get(), undefined);
      database.close();
      assert.equal(existsSync(join(data, ".runtime-recovery.json")), false);
    });
    console.log("✓ failed migration restores the real database and previous runtime from the recorded recovery point");

    for (const [mode, expected, extra] of [["update", 0, {}], ["quit", 0, {}], ["update", 1, { HOLD_BUNDLE_LOCK: "1" }]]) {
      await scenario({}, async ({ run, pid, recorded }) => {
        const output = await run(expected, { MODE: mode, ANSWERS: "", ...extra });
        assert.doesNotMatch(output, /PROMPT|强制切换/);
        assert.equal(isPidAlive(pid), true);
        assert.equal(recorded().some((event) => event.signal || event.handoff), false);
        if (extra.HOLD_BUNDLE_LOCK) assert.match(output, /仍有进程使用 app 内的旧代码/);
      });
    }
    await scenario({}, async ({ run, pid, recorded }) => {
      await run(2, { CHANGE_TO_UPDATE: "1" });
      assert.equal(isPidAlive(pid), true);
      assert.equal(recorded().some((event) => event.signal || event.handoff), false);
    });
    console.log("✓ Sparkle install and quit never force recovery; bundle occupancy and purpose changes retain their safety gates");
  }, [() => rmSync(temporary, { recursive: true, force: true })]);
}
