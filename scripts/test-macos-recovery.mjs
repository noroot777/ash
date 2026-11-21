import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  let preserveTemporary = false;
  function sceneProcesses(directory) {
    const normalized = directory.replace(/^\/private\/var\//, "/var/");
    return execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n").filter((line) => line.replaceAll("/private/var/", "/var/").includes(normalized));
  }
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
if(${JSON.stringify(version)}==='next'&&!fs.existsSync(data+'/.recovery-retry-clear')){
 const database=new DatabaseSync(data+'/navi.db');database.exec('create table failed_migration (id text)');database.close();process.exit(7);
}
const event=value=>fs.appendFileSync(data+'/../events.jsonl',JSON.stringify(value)+'\\n');
const cleanupToken=fs.readFileSync(data+'/.recovery-cleanup-token','utf8');
const server=http.createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost');
 if(url.pathname==='/__test_shutdown'&&request.headers['x-test-cleanup']===cleanupToken){
  response.end('stopping');server.close(()=>process.exit(0));return;
 }
 if(url.pathname==='/api/restart-impact'){
  if(!fs.existsSync(data+'/.recovery-retry-clear')){response.writeHead(500);response.end('{}');return}
  event({retryImpact:true,schema:url.searchParams.get('schema')});
  response.end(JSON.stringify({survives:[],resumes:[],interrupted:[],mcpDisrupted:[],runtimeHandover:{blocked:fs.existsSync(data+'/.recovery-retry-busy')?[{id:'pending',title:'尚未结束的任务',reason:'等待完成'}]:[],sessions:[],
   target:{protocol:1,schema:url.searchParams.get('schema')}}}));return;
 }
 if(url.pathname==='/api/runtime-handover'){
  let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
   const message=JSON.parse(body);event({retryHandoff:message});
   const expected=JSON.parse(fs.readFileSync(data+'/.recovery-retry-target.json'));
   if(!message.check&&!message.release&&message.schema!==expected.schema){response.writeHead(409);response.end('{}');return}
   response.end(JSON.stringify(message.check?{valid:true}:{protocol:1,lease:'retry-lease'}));
  });return;
 }
 response.end(JSON.stringify({ok:true,pid:process.pid,
 instance:{id:'restored',dataDir:data,codeDir:root,desktop:true,windowPort:Number(process.env.NAVI_WINDOW_PORT)}}));
});
server.listen(Number(process.env.PORT),'127.0.0.1');`);
    writeFileSync(join(path, ".in-use"), "");
    writeFileSync(join(path, "version.txt"), version);
    return sealRuntime(path).id;
  }

  async function scenario(options, operation) {
    const directory = mkdtempSync(join(temporary, "case-"));
    const fixtures = [];
    const data = join(directory, "data");
    const cleanupToken = randomUUID();
    let port;
    let retired = false;
    const stopLaunched = async () => {
      if (!sceneProcesses(directory).some((line) => line.includes("/server/dist/index.js"))) return;
      const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) }).then((response) => response.json());
      assert.equal(realpathSync(health.instance.dataDir), realpathSync(data));
      assert.ok(realpathSync(health.instance.codeDir).startsWith(`${realpathSync(data)}/.mac-runtimes/`));
      const response = await fetch(`http://127.0.0.1:${port}/__test_shutdown`, {
        headers: { "x-test-cleanup": cleanupToken }, signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "stopping");
      for (let attempt = 0; attempt < 100 && sceneProcesses(directory).some((line) => line.includes("/server/dist/index.js")); attempt++) await sleep(30);
      assert.equal(sceneProcesses(directory).some((line) => line.includes("/server/dist/index.js")), false);
    };
    await withTestResources(async () => {
      const bundled = join(directory, "Navi.app/Contents/Resources/app");
      const oldSource = join(directory, "old");
      const nextId = makeRuntime(bundled, "next");
      const oldId = makeRuntime(oldSource, "previous", options.incompatible);
      const previous = join(data, ".mac-runtimes", oldId);
      mkdirSync(join(data, ".mac-runtimes"), { recursive: true });
      writeFileSync(join(data, ".recovery-cleanup-token"), cleanupToken);
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
      dataDir:changed==='foreign'?data+'-foreign':data,codeDir:changed==='code'||options.legacy?${JSON.stringify(bundled)}:runtime,
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
      const readyInfo = JSON.parse(readFileSync(ready, "utf8"));
      const { pid } = readyInfo;
      port = readyInfo.port;
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
      const oldMetadata = JSON.parse(readFileSync(join(previous, ".handover.json"), "utf8"));
      await operation({ run, pid, data, bundled, previous, next: join(data, ".mac-runtimes", nextId), oldMetadata, recorded, backupFiles, stopLaunched });
    }, [
      async () => { for (const fixture of fixtures) await fixture.dispose(); },
      async () => {
        try {
          await stopLaunched();
          for (let attempt = 0; attempt < 100 && sceneProcesses(directory).length; attempt++) await sleep(30);
          assert.deepEqual(sceneProcesses(directory), [], "scene processes must exit before removing their runtime");
          retired = true;
        } catch (error) { preserveTemporary = true; throw error; }
      },
      () => { if (retired) rmSync(directory, { recursive: true, force: true }); },
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

    for (const impactFailure of [false, true]) {
      for (const answer of ["wait", "now"]) {
        await scenario({ legacy: true, impactFailure }, async ({ run, pid, recorded, backupFiles }) => {
          const output = await run(answer === "wait" ? 2 : 0, { ANSWERS: answer });
          assert.match(output, /等它们跑完再重启\|现在重启/);
          assert.doesNotMatch(output, /强制切换服务/);
          assert.equal(isPidAlive(pid), answer === "wait");
          assert.equal(recorded().some((event) => event.signal), answer === "now");
          assert.equal(backupFiles().length, answer === "wait" ? 0 : 1);
        });
      }
    }
    console.log("✓ legacy packaged services retain both wait and restart-now for busy or unavailable impact");

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
      assert.match(output, /REPORT 新版启动失败，已恢复旧服务和迁移前数据库/);
      assert.match(output, /RECOVERY_NOTICE_AND_PAUSE/);
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
    await scenario({ incompatible: true }, async ({ run, oldMetadata, next, recorded, data }) => {
      const output = await run(0, { START_FAILED_MIGRATION: "1", NORMAL_RETRY_AFTER_ROLLBACK: "1" });
      assert.match(output, /RECOVERY_NOTICE_AND_PAUSE/);
      assert.match(output, /RETRY_OUTCOME ready/);
      assert.ok(output.includes(`RETRY_SERVICE ${realpathSync(next)}`), output);
      assert.doesNotMatch(output, /PROMPT 3/);
      const target = JSON.parse(readFileSync(join(next, ".handover.json"), "utf8"));
      assert.notEqual(target.schema, oldMetadata.schema);
      assert.ok(recorded().some((event) => event.retryImpact && event.schema === target.schema));
      assert.ok(recorded().some((event) => event.retryHandoff?.schema === target.schema));
      assert.equal(realpathSync(join(data, ".mac-runtimes/current")), realpathSync(next));
    });
    console.log("✓ normal retry after rollback preflights, records and actually starts the new target instead of relabeling old code");
    for (const headless of [false, true]) {
      await scenario({}, async ({ run, data, previous, stopLaunched }) => {
        const output = await run(0, { START_FAILED_MIGRATION: "1", ...(headless ? { HEADLESS_RECOVERY: "1" } : { RESTART_PAUSED: "1" }) });
        assert.match(output, headless ? /HEADLESS_PAUSE_SAVED/ : /RECOVERY_NOTICE_AND_PAUSE/);
        if (!headless) assert.match(output, /PAUSED_RESTART ready/);
        const paused = JSON.parse(readFileSync(join(data, ".mac-runtime-paused.json"), "utf8"));
        assert.equal(paused.previous, realpathSync(previous));
        assert.equal(paused.version, "previous");
        await stopLaunched();
        const restarted = await run(0, { MODE: headless ? "paused-headless" : "paused-gui", ANSWERS: "" });
        assert.match(restarted, /PAUSED_OUTCOME ready/);
        assert.ok(restarted.includes(`PAUSED_SERVICE ${realpathSync(previous)} VERSION previous`), restarted);
        if (!headless) assert.match(restarted, /PERSISTED_GATE blocked/);
        assert.equal(realpathSync(join(data, ".mac-runtimes/current")), realpathSync(previous));
        assert.equal(existsSync(join(data, ".mac-runtime-recovery.json")), false);
        assert.equal(existsSync(join(data, ".mac-runtime-paused.json")), true);
        const database = new DatabaseSync(join(data, "navi.db"));
        assert.equal(database.prepare("select name from sqlite_master where name='failed_migration'").get(), undefined);
        database.close();
      });
    }
    for (const marker of ["not-json", JSON.stringify({ previous: "/untrusted/runtime", version: "previous", reason: "invalid" })]) {
      await scenario({}, async ({ run, data, pid, recorded }) => {
        writeFileSync(join(data, ".mac-runtime-paused.json"), marker);
        assert.match(await run(1, { MODE: "paused-headless", ANSWERS: "" }), /PAUSED_OUTCOME failed/);
        assert.equal(isPidAlive(pid), true);
        assert.equal(recorded().some((event) => event.signal), false);
      });
    }
    console.log("✓ durable recovery pause survives launcher and app restarts, preserves old version identity and fails closed on invalid markers");
    for (const retry of ["ready", "wait", "failure"]) {
      await scenario({}, async ({ run, data, bundled, previous, next, recorded, stopLaunched }) => {
        await run(0, { START_FAILED_MIGRATION: "1", HEADLESS_RECOVERY: "1" });
        await stopLaunched();
        rmSync(next, { recursive: true });
        writeFileSync(join(data, ".recovery-retry-clear"), "");
        copyFileSync(join(bundled, ".handover.json"), join(data, ".recovery-retry-target.json"));
        const launcher = readFileSync(join(data, ".mac-runtimes/mcp.sh"), "utf8");
        if (retry === "wait") writeFileSync(join(data, ".recovery-retry-busy"), "");
        if (retry === "failure") writeFileSync(join(bundled, "server/dist/db/schema.js"), "corrupted target");
        const output = await run(retry === "failure" ? 2 : 0, {
          MODE: "paused-gui", RETRY_PAUSED_TARGET: retry, ANSWERS: "",
        });
        assert.match(output, /PERSISTED_GATE blocked/);
        if (retry === "failure") {
          assert.match(output, /STAGING_REFUSED_OLD_PRESERVED/);
          assert.equal(realpathSync(join(data, ".mac-runtimes/current")), realpathSync(previous));
          assert.equal(existsSync(join(data, ".mac-runtime-paused.json")), true);
          assert.equal(recorded().some((event) => event.retryHandoff || event.retryImpact), false);
          assert.equal(existsSync(next), false);
        } else {
          assert.match(output, /STAGED_WITHOUT_ACTIVATION/);
          assert.match(output, /PAUSED_RETRY_OUTCOME ready/);
          assert.ok(output.includes(`PAUSED_RETRY_SERVICE ${realpathSync(next)}`), output);
          if (retry === "wait") assert.match(output, /RETRY_PROMPT/);
          const target = JSON.parse(readFileSync(join(next, ".handover.json"), "utf8"));
          assert.ok(recorded().some((event) => event.retryImpact && event.schema === target.schema));
          assert.ok(recorded().some((event) => event.retryHandoff?.schema === target.schema));
          assert.equal(existsSync(join(data, ".mac-runtime-paused.json")), false);
          assert.equal(existsSync(join(data, ".mac-runtime-recovery.json")), false);
        }
        assert.equal(readFileSync(join(data, ".mac-runtimes/mcp.sh"), "utf8"), launcher);
      });
    }
    console.log("✓ paused retry stages a missing target without activation, switches normally after idle or draining tasks and preserves the old service on staging failure");
    await scenario({}, async ({ run, data }) => {
      const output = await run(0, { ADOPTED_ROLLBACK: "1" });
      assert.match(output, /REFUSED_ADOPTED/);
      const database = new DatabaseSync(join(data, "navi.db"));
      assert.ok(database.prepare("select name from sqlite_master where name='failed_migration'").get());
      database.close();
    });
    console.log("✓ forced switch migration failure restarts the preserved runtime and database; adoption prevents stale rollback");
    console.log("✓ Sparkle install and quit never force recovery; bundle occupancy and purpose changes retain their safety gates");
    assert.deepEqual(sceneProcesses(temporary), [], "all detached recovery services must be retired");
    console.log("✓ every detached test service self-exits and no scenario process remains after cleanup");
  }, [() => {
    if (preserveTemporary) console.error(`保留未清场的测试目录：${temporary}`);
    else rmSync(temporary, { recursive: true, force: true });
  }]);
}
