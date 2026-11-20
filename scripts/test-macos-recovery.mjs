import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { sealRuntime } from "../desktop/macos/scripts/runtime-store.mjs";
import { isPidAlive, sleep } from "./platform.mjs";
import { runTestProcess } from "./test-process.mjs";
import { spawnTestFixture } from "./test-process-scope.mjs";
import { withTestResources } from "./test-process-resources.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS explicit runtime recovery");
} else {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const mac = join(root, "desktop/macos");
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "navi-macos-recovery-")));
  const binary = join(temporary, "recovery-probe");
  const impact = {
    survives: [{ id: "live", title: "可接管但未获保证的任务" }],
    resumes: [{ id: "team", title: "调度台回合" }],
    interrupted: [{ id: "lost", title: "正在起跑的任务", reason: "进程未就绪" }],
    mcpDisrupted: [{ id: "live", title: "可接管但未获保证的任务" }],
    runtimeHandover: { blocked: [{ id: "ghost", title: "卡住的回合锁", reason: "维护操作在途" }], sessions: [] },
  };

  function makeRuntime(path, version, incompatible = false) {
    for (const folder of ["node/bin", "scripts", "server/dist/db"]) mkdirSync(join(path, folder), { recursive: true });
    writeFileSync(join(path, "node/bin/node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    for (const script of ["runtime-store.mjs", "start-detached.mjs"]) {
      copyFileSync(join(root, script === "runtime-store.mjs" ? "desktop/macos/scripts" : "scripts", script), join(path, "scripts", script));
    }
    writeFileSync(join(path, "server/dist/db/schema.js"), incompatible ? "old incompatible schema" : "schema");
    writeFileSync(join(path, "server/dist/index.js"), `const fs=require('node:fs'),http=require('node:http');
const {DatabaseSync}=require('node:sqlite');
const data=process.env.NAVI_DATA_DIR,root=fs.realpathSync(__dirname+'/../..');
if(${JSON.stringify(version)}==='next'){
 const database=new DatabaseSync(data+'/navi.db');database.exec('create table failed_migration (id text)');database.close();process.exit(7);
}
http.createServer((request,response)=>response.end(JSON.stringify({ok:true,pid:process.pid,
 instance:{id:'restored',dataDir:data,codeDir:root,desktop:true,windowPort:Number(process.env.NAVI_WINDOW_PORT)}})))
 .listen(Number(process.env.PORT),'127.0.0.1');`);
    writeFileSync(join(path, ".in-use"), "");
    writeFileSync(join(path, "version.txt"), version);
    return sealRuntime(path).id;
  }

  async function scenario(options, operation) {
    const directory = mkdtempSync(join(temporary, "case-"));
    const fixtures = [];
    await withTestResources(async () => {
      const data = join(directory, "data");
      const bundled = join(directory, "Navi.app/Contents/Resources/app");
      const oldSource = join(directory, "old");
      const nextId = makeRuntime(bundled, "next");
      const oldId = makeRuntime(oldSource, "previous", options.incompatible);
      const previous = join(data, ".mac-runtimes", oldId);
      mkdirSync(join(data, ".mac-runtimes"), { recursive: true });
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
import {appendFileSync,existsSync,readdirSync,writeFileSync} from 'node:fs';
const options=${JSON.stringify(options)}, data=${JSON.stringify(data)}, runtime=${JSON.stringify(previous)};
const event=value=>appendFileSync(${JSON.stringify(events)},JSON.stringify(value)+'\\n');
const server=createServer((request,response)=>{
  const url=new URL(request.url,'http://localhost');
  const requested=existsSync(${JSON.stringify(requestMarker)}),confirmed=existsSync(${JSON.stringify(confirmMarker)});
  const afterBackup=options.changeAfterBackup&&existsSync(data+'/backups')&&
    readdirSync(data+'/backups').some(name=>name.endsWith('.db'));
  const changed=((confirmed&&!options.changeAfterBackup)||afterBackup)&&options.change;
  if(request.url==='/api/health'){
    if((requested&&options.unidentified)||changed==='unidentified'){response.writeHead(503);response.end('{}');return}
    response.end(JSON.stringify({ok:true,pid:changed==='pid'?process.pid+100:process.pid,instance:{id:changed==='identity'?'replacement':'original',
      dataDir:changed==='foreign'?data+'-foreign':data,codeDir:changed==='code'?${JSON.stringify(bundled)}:runtime,
      desktop:true,windowPort:45678}}));return;
  }
  if(url.pathname==='/api/restart-impact'){
    event({impact:true,instance:request.headers['x-ash-instance'],protocol:url.searchParams.get('protocol'),schema:url.searchParams.get('schema')});
    response.writeHead(options.impactFailure?500:200);
    const impact=options.clearImpact?
      {survives:[],resumes:[],interrupted:[],mcpDisrupted:[],runtimeHandover:{blocked:[],sessions:[]}}:${JSON.stringify(impact)};
    if(url.searchParams.has('schema')&&!options.omitTarget)impact.runtimeHandover.target={
      protocol:1,schema:options.targetMismatch?'wrong-target':url.searchParams.get('schema')};
    response.end(JSON.stringify(options.impactFailure?{error:'cannot classify'}:impact));return;
  }
  if(request.url==='/api/runtime-handover')event({handoff:request.method});
  response.writeHead(409);response.end('blocked');
});
process.on('SIGTERM',()=>{event({signal:true,maintenance:existsSync(data+'/.mac-maintenance.json')});if(!options.stubborn)process.exit(0)});
server.listen(0,'127.0.0.1',()=>writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,port:server.address().port})));`);
      const fixture = spawnTestFixture(process.execPath, [server], { cwd: directory, stdio: "ignore" });
      fixtures.push(fixture);
      for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) await sleep(30);
      assert.ok(existsSync(ready));
      const { pid, port } = JSON.parse(readFileSync(ready, "utf8"));
      writeFileSync(join(data, "navi.db.navi.lock"), JSON.stringify({ pid, token: "fixture-token" }));
      writeFileSync(join(data, ".mac-server.json"), JSON.stringify({ pid, bundleVersion: "previous" }));
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
      await operation({ run, pid, data, previous, next: join(data, ".mac-runtimes", nextId), recorded, backupFiles });
    }, [
      async () => { for (const fixture of fixtures) await fixture.dispose(); },
      () => rmSync(directory, { recursive: true, force: true }),
    ]);
  }

  await withTestResources(async () => {
    await runTestProcess("swiftc", ["-swift-version", "5",
      ...["NaviConfig", "NaviHealth", "DatabaseBackup", "LegacyIdentity", "LoginService", "RestartImpact",
        "BundleRuntimeUse", "RuntimeRecovery", "ServerControl", "ServerLauncher", "ServerStartLock", "UpdateGate"].map((name) => join(mac, `Sources/${name}.swift`)),
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
        if (options.impactFailure) assert.match(output, /无法获取完整影响清单.*所有任务/);
        else {
          for (const title of ["可接管但未获保证的任务", "调度台回合", "正在起跑的任务", "卡住的回合锁"]) {
            assert.ok(output.split("PROMPT 2")[1].includes(title), output);
          }
        }
        assert.equal(isPidAlive(pid), false);
        assert.deepEqual(recorded().filter((event) => event.signal), [{ signal: true, maintenance: true }]);
        assert.equal(recorded().some((event) => event.handoff), false);
        assert.ok(recorded().filter((event) => event.impact).every((event) => event.instance === "original"));
        assert.equal(backupFiles().length, 2);
        const recovery = JSON.parse(readFileSync(join(data, ".mac-runtime-recovery.json"), "utf8"));
        assert.equal(recovery.finalized, true);
        assert.equal(recovery.previous, realpathSync(previous));
        assert.ok(existsSync(next), JSON.stringify({ next, recovery, entries: readdirSync(join(data, ".mac-runtimes")), output }));
        assert.equal(recovery.next, realpathSync(next));
        const snapshot = new DatabaseSync(recovery.backup);
        assert.equal(snapshot.prepare("select id from tasks").get().id, "original");
        snapshot.close();
        assert.equal(existsSync(join(data, ".mac-maintenance.json")), false);
      });
    }
    console.log("✓ confirmed recovery bypasses permanent blockers and incompatible schemas, retaining backup and rollback identity");

    for (const change of ["identity", "foreign", "unidentified", "code", "pid"]) {
      await scenario({ change }, async ({ run, pid, recorded, backupFiles }) => {
        assert.match(await run(1), /本次强制切换已取消/);
        assert.equal(isPidAlive(pid), true);
        assert.equal(recorded().some((event) => event.signal || event.handoff), false);
        assert.deepEqual(backupFiles(), []);
      });
    }
    for (const change of ["identity", "foreign", "code", "pid"]) {
      await scenario({ change, changeAfterBackup: true }, async ({ run, pid, recorded, backupFiles }) => {
        assert.match(await run(1), /本次强制切换已取消|端口上换成了别的 Navi/);
        assert.equal(isPidAlive(pid), true);
        assert.equal(recorded().some((event) => event.signal || event.handoff), false);
        assert.equal(backupFiles().length, 1);
      });
    }
    await scenario({}, async ({ run, pid, recorded }) => {
      assert.match(await run(1, { MISSING_NEXT: "1" }), /新版运行时未完整准备/);
      assert.equal(isPidAlive(pid), true);
      assert.equal(recorded().some((event) => event.signal), false);
    });
    await scenario({ unidentified: true }, async ({ run, pid, recorded }) => {
      assert.match(await run(1, { ANSWERS: "recover" }), /无法确认本机外置旧服务的身份/);
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
        assert.equal(backupFiles().length, options.stubborn ? 1 : 0);
      });
    }
    await scenario({ backupFailure: true }, async ({ run, data }) => {
      assert.match(await run(1), /迁移前备份失败/);
      assert.equal(existsSync(join(data, ".mac-runtime-recovery.json")), false);
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
      assert.equal(existsSync(join(data, ".mac-runtime-recovery.json")), false);
    });
    console.log("✓ failed migration restores the real database and previous runtime from the recorded recovery point");

    for (const [mode, expected, extra] of [["update", 0, {}], ["quit", 0, {}], ["update", 1, { HOLD_BUNDLE_LOCK: "1" }]]) {
      await scenario({}, async ({ run, pid, recorded }) => {
        const output = await run(expected, { MODE: mode, ANSWERS: "", ...extra });
        assert.doesNotMatch(output, /PROMPT|强制切换/);
        assert.equal(isPidAlive(pid), true);
        assert.equal(recorded().some((event) => event.signal || event.handoff), false);
        if (extra.HOLD_BUNDLE_LOCK) assert.match(output, /app 内的代码仍被/);
      });
    }
    await scenario({}, async ({ run, pid, recorded }) => {
      await run(0, { CHANGE_TO_UPDATE: "1" });
      assert.equal(isPidAlive(pid), true);
      assert.equal(recorded().some((event) => event.signal || event.handoff), false);
    });
    for (const mode of ["UPDATE_DURING_PREPARE", "QUIT_DURING_PREPARE"]) {
      await scenario({}, async ({ run, recorded }) => {
        const quitting = mode === "QUIT_DURING_PREPARE";
        const output = await run(quitting ? 0 : 1, {
          [mode]: "1", HOLD_BUNDLE_LOCK: "1", ANSWERS: quitting ? "recover,recover,cancel" : "recover,recover",
        });
        assert.match(output, /app 内的代码仍被/);
        assert.doesNotMatch(output, /INSTALL_ALLOWED|QUIT_ALLOWED true/);
        if (quitting) assert.match(output, /QUIT_ALLOWED false/);
        assert.equal(recorded().filter((event) => event.signal).length, 1);
      });
    }
    console.log("✓ concurrent Sparkle and quit requests run their own package checks instead of inheriting force consent");

    await scenario({ clearImpact: true }, async ({ run, pid, recorded }) => {
      const output = await run(0, { RECONSIDER: "1", VERIFY_BLOCKED_PAUSE: "1" });
      assert.match(output, /打断任务并切换服务/);
      assert.match(output, /BLOCKED_PAUSE/);
      assert.match(output, /MENU 重试切换新版服务/);
      assert.equal(isPidAlive(pid), false);
      assert.equal(recorded().filter((event) => event.handoff).length, 1);
      const impacts = recorded().filter((event) => event.impact);
      assert.ok(impacts.some((event) => event.protocol === "1" && event.schema));
      assert.equal(impacts.at(-1).schema, null);
    });
    console.log("✓ compatibility or consumer barriers absent from impact still expose recovery through the retry menu");

    for (const option of ["targetMismatch", "omitTarget"]) {
      await scenario({ [option]: true }, async ({ run, pid, recorded }) => {
        const output = await run(0);
        assert.match(output, /旧服务未核对新版兼容性/);
        assert.match(output, /可接管但未获保证的任务/);
        assert.equal(isPidAlive(pid), false);
        assert.equal(recorded().some((event) => event.handoff), false);
        assert.equal(recorded().filter((event) => event.signal).length, 1);
      });
    }
    console.log("✓ missing or mismatched target preflight never permits normal takeover, but explicit fresh recovery remains available");

    await scenario({}, async ({ run, previous, data }) => {
      const output = await run(0, { START_FAILED_MIGRATION: "1" });
      assert.match(output, /OUTCOME ready/);
      assert.ok(output.includes(`RESTORED_SERVICE ${realpathSync(previous)}`), output);
      const database = new DatabaseSync(join(data, "navi.db"));
      assert.equal(database.prepare("select id from tasks").get().id, "original");
      assert.equal(database.prepare("select name from sqlite_master where name='failed_migration'").get(), undefined);
      database.close();
      assert.equal(realpathSync(join(data, ".mac-runtimes/current")), realpathSync(previous));
    });
    await scenario({}, async ({ run, next }) => {
      const output = await run(0, { START_FAILED_MIGRATION: "1", RETRY_AFTER_ROLLBACK: "1", ANSWERS: "recover,recover,recover,recover" });
      assert.ok(output.includes(`RETRY_TARGET ${realpathSync(next)}`), output);
    });
    await scenario({}, async ({ run, data }) => {
      const output = await run(0, { ADOPTED_ROLLBACK: "1" });
      assert.match(output, /REFUSED_ADOPTED/);
      const database = new DatabaseSync(join(data, "navi.db"));
      assert.ok(database.prepare("select name from sqlite_master where name='failed_migration'").get());
      database.close();
    });
    console.log("✓ forced switch migration failure restarts the preserved runtime and database; adoption prevents stale rollback");
    console.log("✓ Sparkle install and quit never force recovery; bundle occupancy and purpose changes retain their safety gates");
  }, [() => rmSync(temporary, { recursive: true, force: true })]);
}
