import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { connect } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { parsePreviewConfig, previewProxyEnabled, type ProjectPreviewConfig } from "@ash/shared/preview";

const root = mkdtempSync(join(realpathSync(tmpdir()), "ash-preview-settings-"));
process.env.ASH_DB = join(root, "test.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_DEPS_DIR = join(root, "deps");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, tasks, users, projectMembers } = await import("../src/db/schema.js");
const { authGate, SESSION_COOKIE } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { mountProjectRoutes } = await import("../src/project-routes.js");
const { mountFreePreviewRoutes } = await import("../src/free-workflow-preview.js");
const { mountPreviewProxy, attachPreviewUpgrades } = await import("../src/preview-proxy.js");
const { mountPreviewOpenRoutes } = await import("../src/preview-access.js");
const { previewState } = await import("../src/preview-public.js");
const { startPreview, stopPreview, readPreview, beginPreviewStart, endPreviewStart } = await import("../src/preview.js");
const { lastPreview, readAnyPreview, readPreviewLog, writeRecord } = await import("../src/preview-store.js");
const { nodeDepsAdvice } = await import("../src/preview-deps.js");
const { previewShell } = await import("../src/preview-shell.js");
const { createSession, deleteSession } = await import("../src/auth/store.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
await ensureSchema();
const fixture = join(root, "fixture");
mkdirSync(fixture);
writeFileSync(join(fixture, "service.cjs"), `
const http = require('node:http');
const {createHash} = require('node:crypto');
const html = '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><h1>Proxy test</h1><p id="module">waiting</p><p id="api">waiting</p><p id="sse">waiting</p><p id="ws">waiting</p><p id="slash">waiting</p><p id="isolation">waiting</p><a href="/nested/">Nested page</a><script type="module" src="/entry.js"></script></body></html>';
const source = 'import message from "/chunk.js"; document.querySelector("#module").textContent=message; const slash="/"; document.querySelector("#slash").textContent=slash; fetch("/echo",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ok:true})}).then(r=>r.json()).then(r=>document.querySelector("#api").textContent=r.body); const es=new EventSource("/events"); es.onmessage=e=>{document.querySelector("#sse").textContent=e.data;es.close()};const ws=new WebSocket("ws://"+location.host+"/socket");ws.onmessage=e=>{document.querySelector("#ws").textContent=e.data;ws.close()};try{localStorage.getItem("ash");document.querySelector("#isolation").textContent="shared"}catch{document.querySelector("#isolation").textContent="isolated"}';
const server=http.createServer((req,res)=>{
 if(req.url==='/style.css'){res.setHeader('content-type','text/css');return res.end('body { color: rgb(20, 50, 80); }');}
 if(req.url==='/entry.js'){res.setHeader('content-type','text/javascript');return res.end(source);}
 if(req.url==='/chunk.js'){res.setHeader('content-type','text/javascript');return res.end('export default "module loaded";');}
 if(req.url==='/redirect'){res.writeHead(302,{location:'/nested/'});return res.end();}
 if(req.url==='/whoami'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({cookie:req.headers.cookie??null}));}
 if(req.url==='/private/set'){res.setHeader('set-cookie','narrow=secret; Path=/private; HttpOnly');res.setHeader('content-type','application/json');return res.end('{}');}
 if(req.url==='/private/whoami'||req.url==='/public/whoami'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({cookie:req.headers.cookie??null}));}
 if(req.url==='/short/set'){res.setHeader('set-cookie','short=lived; Path=/; Max-Age=1; HttpOnly');res.setHeader('content-type','application/json');return res.end('{}');}
 if(req.url==='/logout'){res.setHeader('set-cookie','session=; Path=/; Max-Age=0');res.setHeader('content-type','application/json');return res.end('{}');}
 if(req.url==='/events'){res.setHeader('content-type','text/event-stream');res.write('data: stream arrived\\n\\n');const timer=setTimeout(()=>res.end(),2000);res.on('close',()=>clearTimeout(timer));return;}
 if(req.url==='/echo'){let body='';req.on('data',d=>body+=d);req.on('end',()=>{res.setHeader('content-type','application/json');res.setHeader('set-cookie','session=app-session; Path=/; HttpOnly');res.end(JSON.stringify({body,headers:req.headers,port:Number(process.env.PORT),peer:process.env.URL2}));});return;}
 res.setHeader('content-type','text/html');res.end(html);
});
server.on('upgrade',(req,socket)=>{const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');socket.write(Buffer.concat([Buffer.from([0x81,14]),Buffer.from('socket arrived')]));socket.on('data',()=>socket.end());socket.on('error',()=>{});});
server.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('http://localhost:'+server.address().port+'/'));
`);
mkdirSync(join(fixture, "apps", "site"), { recursive: true });
writeFileSync(join(fixture, "apps", "site", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
const command = `${previewShell().quote(process.execPath)} service.cjs`;
const config: ProjectPreviewConfig = { mode: "services", proxy: "on", primaryServiceId: "web", services: [
  { id: "web", name: "网站", command, kind: "web", enabled: true },
  { id: "api", name: "接口", command, kind: "service", enabled: true },
  { id: "disabled", name: "未选服务", command: "exit 19", kind: "service", enabled: false },
] };
const stamp = new Date().toISOString();
await db.insert(projects).values({ id: "preview-project", name: "Preview", repoPath: fixture, createdAt: stamp });
await db.insert(tasks).values({ id: "preview-task", projectId: "preview-project", title: "Preview", status: "done", workflowMode: "free", mode: "single", useWorktree: false, createdAt: stamp, updatedAt: stamp });
const app = new Hono();
mountPreviewProxy(app);
app.use("*", authGate());
app.use("/api/*", resourceGate());
const api = new Hono();
mountProjectRoutes(api); mountFreePreviewRoutes(api); mountPreviewOpenRoutes(api);
app.route("/api", api);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
attachPreviewUpgrades(server as import("node:http").Server);
if (!server.listening) await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method, redirect: "manual", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const taskPath = "/api/tasks/preview-task/free-workflow/preview";
const projPath = "/api/projects/preview-project";
try {
  assert.equal(previewProxyEnabled("auto", false), false);
  assert.equal(previewProxyEnabled("auto", true), true);
  assert.equal(previewProxyEnabled("on", false), true);
  assert.equal(previewProxyEnabled("off", true), false);
  assert.throws(() => parsePreviewConfig({ ...config, primaryServiceId: "disabled" }));
  assert.throws(() => parsePreviewConfig({ ...config, services: [config.services[0], config.services[0]] }));
  const detected = await request(projPath + "/preview/detect");
  assert.equal(detected.status, 200);
  assert((await detected.json()).services.some((s: { directory: string }) => s.directory === "apps/site"));
  // repoPath 以 `~` 存盘是正常形态（tidyRepoPath 有意保留），检测端点必须自己展开：
  // 不展开只会安静地扫一个不存在的相对目录，界面说「没有识别出常见服务」，而项目
  // 健康检查（展开过）照样是绿的，用户手上一条线索都没有。
  const homeFixture = mkdtempSync(join(homedir(), ".ash-preview-home-"));
  try {
    writeFileSync(join(homeFixture, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await db.update(projects).set({ repoPath: `~/${basename(homeFixture)}` }).where(eq(projects.id, "preview-project"));
    const viaTilde = await request(projPath + "/preview/detect");
    assert.equal(viaTilde.status, 200);
    assert((await viaTilde.json()).services.length > 0, "repoPath 带 ~ 时同样能检测出服务");
  } finally {
    rmSync(homeFixture, { recursive: true, force: true });
    await db.update(projects).set({ repoPath: fixture }).where(eq(projects.id, "preview-project"));
  }
  assert.equal(nodeDepsAdvice(fixture, command).length, 0, "不为无关脚本深入扫描依赖");
  assert(nodeDepsAdvice(fixture, previewShell().cd("apps/site", "npm run dev")).some((s) => s.rel === "apps/site" && s.mentioned), "检测出的嵌套服务也能准备依赖");
  assert.equal(readPreview("preview-task"), null, "检测不启动进程");
  await request(projPath, "PATCH", { previewConfig: { ...config, proxy: "auto" } });
  const singleDefault = await (await request(taskPath, "POST")).json();
  assert.equal(singleDefault.proxied, false, "单人模式默认直连");
  assert.match(singleDefault.url, /^http:\/\/localhost:/);
  const firstRecord = readPreview("preview-task")!;
  const taskDir = dirname(firstRecord.log);
  const oldCmd = join(taskDir, `preview-${firstRecord.gen}-web.cmd`);
  writeFileSync(oldCmd, "echo old launch");
  const preserved = [join(taskDir, "preview-manual.log"), join(taskDir, `preview-${firstRecord.gen}-web.txt`)];
  for (const file of preserved) writeFileSync(file, "unrelated");
  const preservedDir = join(taskDir, `preview-${firstRecord.gen}-directory.log`);
  mkdirSync(preservedDir);
  await stopPreview("preview-task", null);
  assert.match(readPreviewLog("preview-task", 200_000, "api")!.text, /service.cjs/, "停止后仍可读取最后一轮服务日志");
  const canceledGen = beginPreviewStart("preview-task");
  await stopPreview("preview-task", null);
  try {
    const canceled = await startPreview("preview-task", { id: "cancel", kind: "preview", p: { cmd: command, mode: "frontend", ready: "port", life: "task" }, fail: null }, fixture, canceledGen, { services: config.services });
    assert.equal(canceled.ok, false);
    assert.equal(lastPreview("preview-task")!.gen, firstRecord.gen);
    assert(firstRecord.services!.every((s) => existsSync(s.log)), "新一轮落盘前取消，不清理上次日志");
    assert(existsSync(oldCmd));
  } finally { endPreviewStart("preview-task", canceledGen); }
  const saved = await request(projPath, "PATCH", { previewConfig: config, previewCommand: command + "\n" });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).previewConfig, config);
  assert.deepEqual((await (await request("/api/projects")).json()).find((p: { id: string }) => p.id === "preview-project").previewConfig, config, "重新读取保留配置");
  assert.equal((await request(projPath, "PATCH", { previewConfig: { ...config, services: [] } })).status, 400);
  const start = await request(taskPath, "POST");
  assert.equal(start.status, 200, await start.clone().text());
  const state = await start.json();
  assert(firstRecord.services!.every((s) => !existsSync(s.log)), "新一轮启动清理旧代服务日志");
  assert.equal(existsSync(oldCmd), false, "新一轮启动清理旧代命令文件");
  assert(readPreview("preview-task")!.services!.every((s) => existsSync(s.log)), "保留当前代日志");
  for (const file of preserved) assert.equal(readFileSync(file, "utf8"), "unrelated");
  assert(existsSync(preservedDir), "清理不触碰同名目录");
  assert.equal(state.services.length, 2);
  assert.equal(state.services[0].status, "ready");
  assert.notEqual(state.services[0].port, state.services[1].port);
  assert.equal(state.proxied, true);
  const open = await request(state.url);
  assert.equal(open.status, 302);
  // 记录里的地址是从日志里认出来的，认错了就可能压根不是一个能解析的 URL（2026-09-09
  // 真出过：日志里写「/api 打到 http://127.0.0.1:4317。」，句号被一起收了进来）。判读那侧
  // 已经修，这里钉的是**兜底**：坏记录必须换来一句人话，而不是 Hono 的 Internal Server Error
  // —— 那句英文既没说坏在哪，也没说重开一次就好了。
  {
    const good = readAnyPreview("preview-task")!;
    const broken = { ...good, services: good.services!.map((s) => (s.id === "web" ? { ...s, url: "http://127.0.0.1:4317。" } : s)) };
    writeRecord(broken);
    try {
      const response = await request(state.url);
      assert.equal(response.status, 502, "坏地址不该变成 500");
      assert.match(await response.text(), /重开/);
    } finally { writeRecord(good); }
    assert.equal((await request(state.url)).status, 302, "记录恢复后照旧能开");
  }
  const gateway = open.headers.get("location")!;
  assert.match(gateway, /^\/preview\/preview-task\/[a-f0-9]{48}\/web\//);
  const html = await request(gateway);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.doesNotMatch(html.headers.get("content-security-policy") ?? "", /allow-same-origin/);
  assert.match(await html.text(), new RegExp(`src="${gateway}entry.js"`));
  const js = await (await request(gateway + "entry.js")).text();
  assert(js.includes(`from "${gateway}chunk.js"`));
  assert(js.includes('const slash="/"'), "普通字符串不应被 URL 改写破坏");
  const echo = await request(gateway + "echo", "POST", { message: "你好" }, { cookie: "ash_session=SECRET", authorization: "Bearer SECRET", "x-ash-turn-token": "SECRET", origin: "null" });
  assert.equal(echo.status, 200);
  const echoed = await echo.json();
  assert.deepEqual(JSON.parse(echoed.body), { message: "你好" });
  assert.equal(echoed.headers.cookie, undefined);
  assert.equal(echoed.headers.authorization, undefined);
  assert.equal(echoed.headers["x-ash-turn-token"], undefined);
  assert.match(echo.headers.get("set-cookie") ?? "", /ashpv_.*Path=\/preview\//);
  // 预览里的应用**必须保得住自己的会话**。它设的 cookie 早先只改写成 `ashpv_…` 发回浏览器，
  // 可预览文档是 CSP sandbox 的 opaque origin —— 浏览器把它发出的请求一律当跨站，明文 http
  // 加局域网 IP（用户访问 ash 的常态）下 Lax / Strict / None / 不写 / None+Secure **五种写法
  // 一条都带不回来**（2026-09-10 用无头 Chromium 逐个试过）。于是 ash 预览 ash 的表现是：
  // 粘贴 key 登录成功，下一个请求又回到登录页。所以 cookie 改由代理自己记着、自己贴。
  // 这里的 `request()` 用的是不带 cookie 罐子的 fetch，正好等价于那个沙箱文档。
  assert.equal((await (await request(gateway + "whoami")).json()).cookie, "session=app-session", "上一步 /echo 设的 cookie 要由代理自己带回上游");
  // 罐子挂在 grant 上，所以「再打开一次预览」= 换一张凭证 = 换一个会话。这条不是洁癖：
  // 罐子要是做成全局表，别人从任务页打开同一个预览就会直接坐进你登录好的那个会话里。
  const reopened = await request(state.url);
  assert.equal(reopened.status, 302);
  const gateway2 = reopened.headers.get("location")!;
  assert.notEqual(gateway2, gateway, "每次打开预览都是一张新凭证");
  assert.equal((await (await request(gateway2 + "whoami")).json()).cookie, null, "换一次打开就是换一个会话，不继承上一次的 cookie");
  await request(gateway + "logout");
  assert.equal((await (await request(gateway + "whoami")).json()).cookie, null, "上游说删这条 cookie 就得真删掉");
  // 代理替浏览器记 cookie，就得照浏览器的规矩记 —— Path 和到期一样都不能少，否则从「登不上」
  // 换成两种更难看的坏：凭证作用域凭空放大、过期的会话继续被发出去。语义逐条钉在
  // test:preview-cookies（注入时钟、不靠 sleep），这里走真链路各钉一条端到端的。
  await request(gateway + "private/set");
  assert.equal((await (await request(gateway + "private/whoami")).json()).cookie, "narrow=secret", "Path=/private 的 cookie 要发到 /private");
  assert.equal((await (await request(gateway + "public/whoami")).json()).cookie, null, "Path=/private 的 cookie 不得发到 /public");
  await request(gateway + "short/set");
  assert.match((await (await request(gateway + "whoami")).json()).cookie ?? "", /short=lived/, "没到点照发");
  await new Promise((done) => setTimeout(done, 1200));
  assert.doesNotMatch((await (await request(gateway + "whoami")).json()).cookie ?? "", /short=lived/, "Max-Age=1 的 cookie 到期后不得继续发送");
  assert.equal((await request(gateway + "redirect")).headers.get("location"), gateway + "nested/");
  assert.equal((await request(gateway + "echo", "OPTIONS", undefined, { origin: "null", "access-control-request-headers": "content-type" })).status, 204);
  assert.equal((await request(gateway, "GET", undefined, { origin: "https://unrelated.example" })).status, 403);
  assert.equal((await request(gateway.replace(/\/[a-f0-9]{48}\//, "/" + "0".repeat(48) + "/"))).status, 404);
  const stream = await request(gateway + "events");
  const reader = stream.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /stream arrived/);
  await reader.cancel();
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket((base + gateway + "socket").replace(/^http/, "ws"));
    const timeout = setTimeout(() => { ws.close(); reject(new Error("WebSocket 超时")); }, 5000);
    ws.addEventListener("message", (event) => { try { assert.equal(event.data, "socket arrived"); clearTimeout(timeout); ws.close(); resolve(); } catch (e) { reject(e); } });
    ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket 连接失败")); });
  });
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: address.port });
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("无效 WebSocket 请求未关闭")); }, 3000);
    socket.once("connect", () => socket.write(`GET ${gateway}socket HTTP/1.1\r\nHost: [\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    socket.on("data", () => {});
    socket.on("error", () => {});
    socket.once("close", () => { clearTimeout(timeout); resolve(); });
  });
  assert.equal((await request(gateway)).status, 200, "无效升级请求不影响服务存活");
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: address.port });
    let response = "";
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("未认领的升级请求没有结束")); }, 3000);
    socket.once("connect", () => socket.write("GET /unclaimed-socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
    socket.once("close", () => {
      clearTimeout(timeout);
      try { assert.match(response, /^HTTP\/1.1 404 /); resolve(); } catch (error) { reject(error); }
    });
  });
  const otherSockets = new Set<Duplex>();
  const otherUpgrade = (incoming: IncomingMessage, socket: Duplex) => {
    if (incoming.url !== "/other-socket") return;
    otherSockets.add(socket);
    const accept = createHash("sha1").update(incoming.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, 14]), Buffer.from("other endpoint")]));
    socket.on("data", () => socket.end());
    socket.on("error", () => {});
    socket.once("close", () => otherSockets.delete(socket));
  };
  server.on("upgrade", otherUpgrade);
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/other-socket");
      const timeout = setTimeout(() => { ws.close(); reject(new Error("其他 WebSocket 端点超时")); }, 3000);
      ws.addEventListener("message", (event) => {
        clearTimeout(timeout); ws.close();
        try { assert.equal(event.data, "other endpoint"); resolve(); } catch (error) { reject(error); }
      });
      ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("预览处理器干扰了其他 WebSocket 端点")); });
    });
  } finally {
    server.off("upgrade", otherUpgrade);
    for (const socket of otherSockets) socket.destroy();
  }
  const logs = await (await request(taskPath + "/log?service=api")).json();
  assert.match(logs.text, /service.cjs/);
  assert.equal(logs.services.length, 2);
  assert.equal(logs.command, command);
  assert.equal(logs.url, state.services[1].url);
  if (process.argv.includes("--serve")) {
    const viteDir = join(fixture, "vite-site");
    mkdirSync(viteDir);
    writeFileSync(join(viteDir, "index.html"), '<!doctype html><html><head><title>Vite proxy verification</title></head><body><h1>Vite through ash</h1><p id="module">waiting</p><p id="api">waiting</p><p id="ws">waiting</p><p id="sse">waiting</p><script type="module" src="/main.js"></script></body></html>');
    writeFileSync(join(viteDir, "message.js"), 'export default "vite initial";');
    writeFileSync(join(viteDir, "main.js"), 'import message from "/message.js"; document.querySelector("#module").textContent=message; if(import.meta.hot) import.meta.hot.accept("/message.js", m=>document.querySelector("#module").textContent=m.default); fetch("/echo",{method:"POST",body:"vite api reached"}).then(r=>r.json()).then(r=>document.querySelector("#api").textContent=r.body); const es=new EventSource("/events");es.onmessage=e=>{document.querySelector("#sse").textContent=e.data;es.close()};const ws=new WebSocket("ws://"+location.host+"/socket");ws.onmessage=e=>{document.querySelector("#ws").textContent=e.data;ws.close()};');
    writeFileSync(join(viteDir, "vite.config.mjs"), 'const base=process.argv.includes("--base")?process.env.ASH_PREVIEW_BASE.slice(0,-1):""; export default { server: { proxy: Object.fromEntries(["/echo","/events","/socket"].map(path=>[base+path,{target:process.env.URL2,ws:true,rewrite:p=>p.slice(base.length)}])) } };');
    const viteBin = join(dirname(fileURLToPath(import.meta.resolve("vite/package.json"))), "bin", "vite.js");
    const viteCommand = previewShell().cd("vite-site", `${previewShell().quote(process.execPath)} ${previewShell().quote(viteBin)} --host 127.0.0.1 --port ${previewShell().ref("PORT")}`);
    await db.insert(tasks).values({ id: "vite-task", projectId: "preview-project", title: "Vite preview", status: "done", workflowMode: "free", mode: "single", useWorktree: false, createdAt: stamp, updatedAt: stamp });
    const vite = await startPreview("vite-task", { id: "vite", kind: "preview", p: { cmd: viteCommand, mode: "frontend", ready: "port", life: "task" }, fail: null }, fixture, undefined, {
      proxy: true, primaryServiceId: "vite", services: [{ ...config.services[0], id: "vite", command: viteCommand }, config.services[1]],
    });
    assert(vite.ok, vite.ok ? "" : vite.reason);
    await db.insert(tasks).values({ id: "vite-base-task", projectId: "preview-project", title: "Vite base preview", status: "done", workflowMode: "free", mode: "single", useWorktree: false, createdAt: stamp, updatedAt: stamp });
    const baseCommand = viteCommand + ` --base ${previewShell().ref("ASH_PREVIEW_BASE")}`;
    const withBase = await startPreview("vite-base-task", { id: "vite", kind: "preview", p: { cmd: baseCommand, mode: "frontend", ready: "port", life: "task" }, fail: null }, fixture, undefined, {
      proxy: true, primaryServiceId: "vite", services: [{ ...config.services[0], id: "vite", command: baseCommand }, config.services[1]],
    });
    assert(withBase.ok, withBase.ok ? "" : withBase.reason);
    console.log(JSON.stringify({ base, preview: base + state.url, gateway: base + gateway, vitePreview: base + previewState("vite-task").url, viteBasePreview: base + previewState("vite-base-task").url, viteDir, fixture, taskPath, projPath }));
    await new Promise<void>((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  } else {
    await setInstanceMode("multi", join(root, "users"));
    for (const id of ["member", "outsider"]) await db.insert(users).values({ id, name: id, dirName: id, role: "member", status: "active", createdAt: stamp });
    await db.insert(projectMembers).values({ projectId: "preview-project", userId: "member", role: "member", addedAt: stamp });
    const memberHeaders = { cookie: `${SESSION_COOKIE}=${await createSession("member", "test")}` };
    const outsiderHeaders = { cookie: `${SESSION_COOKIE}=${await createSession("outsider", "test")}` };
    assert.equal((await request(projPath + "/preview/detect", "GET", undefined, memberHeaders)).status, 403);
    assert.equal((await request(projPath, "PATCH", { previewConfig: config }, memberHeaders)).status, 403);
    assert.equal((await request(state.url)).status, 401);
    assert.equal((await request(state.url, "GET", undefined, outsiderHeaders)).status, 404);
    const memberOpen = await request(state.url, "GET", undefined, memberHeaders);
    assert.equal(memberOpen.status, 302);
    const memberGateway = memberOpen.headers.get("location")!;
    assert.equal((await request(memberGateway)).status, 200);
    await deleteSession(memberHeaders.cookie.slice(SESSION_COOKIE.length + 1));
    assert.equal((await request(memberGateway)).status, 404, "退出登录后旧预览凭证失效");
    memberHeaders.cookie = `${SESSION_COOKIE}=${await createSession("member", "test")}`;
    const renewedGateway = (await request(state.url, "GET", undefined, memberHeaders)).headers.get("location")!;
    await db.delete(projectMembers).where(eq(projectMembers.userId, "member"));
    assert.equal((await request(renewedGateway)).status, 404, "移出项目后旧链接也失效");
  }
  const record = readPreview("preview-task")!;
  const pids = record.services!.map((s) => s.pid);
  await stopPreview("preview-task", "测试关闭");
  assert.equal(previewState("preview-task").running, false);
  assert(lastPreview("preview-task")!.services!.every((s) => s.status === "stopped"));
  assert.match(readPreviewLog("preview-task", 200_000, "web")!.text, /service.cjs/, "清理旧代不影响最新停止日志");
  assert.equal((await request(gateway)).status, 404);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), "关闭后服务进程已退出");
  if (!process.argv.includes("--serve")) {
    await db.insert(users).values({ id: "admin", name: "admin", dirName: "admin", role: "admin", status: "active", createdAt: stamp });
    const adminHeaders = { cookie: `${SESSION_COOKIE}=${await createSession("admin", "test")}` };
    for (const proxy of ["auto", "off"] as const) {
      const previous = lastPreview("preview-task")!;
      assert.equal((await request(projPath, "PATCH", { previewConfig: { ...config, proxy } }, adminHeaders)).status, 200);
      const response = await request(taskPath, "POST", undefined, adminHeaders);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).proxied, proxy === "auto", `多人模式 ${proxy} 配置已用于启动`);
      assert(previous.services!.every((s) => !existsSync(s.log)), "连续重启不累积旧代日志");
      await stopPreview("preview-task", null);
      assert(lastPreview("preview-task")!.services!.every((s) => existsSync(s.log)));
    }
  }
  writeFileSync(join(fixture, "fail.cjs"), 'setTimeout(()=>process.exit(17),1500);');
  const failurePending = startPreview("failure-task", { id: "failure", kind: "preview", p: { cmd: command, mode: "frontend", ready: "port", life: "task" }, fail: null }, fixture, undefined, {
    services: [config.services[0], { ...config.services[1], command: `${previewShell().quote(process.execPath)} fail.cjs` }],
  });
  let failurePids: number[] = [];
  for (let n = 0; n < 100; n++) {
    failurePids = readAnyPreview("failure-task")?.services?.map((s) => s.pid).filter((pid) => pid > 0) ?? [];
    if (failurePids.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(failurePids.length, 2);
  const failing = await failurePending;
  assert.equal(failing.ok, false);
  assert.equal(readPreview("failure-task"), null, "一个服务失败后不保留仍在运行的预览状态");
  assert(lastPreview("failure-task")!.services!.every((s) => s.status === "failed"));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const pid of failurePids) assert.throws(() => process.kill(pid, 0), "一个服务启动失败后同组进程全部退出");
  const multiline = await startPreview("script-task", { id: "script", kind: "preview", p: { cmd: `echo multiline\n${command}`, mode: "frontend", ready: "port", life: "task" }, fail: null }, fixture);
  assert(multiline.ok, multiline.ok ? "" : multiline.reason);
  assert.match(readFileSync(multiline.record.log, "utf8"), /multiline/);
  await stopPreview("script-task", null);
  const gen = beginPreviewStart("cancel-task");
  const pending = startPreview("cancel-task", { id: "cancel", kind: "preview", p: { cmd: command, mode: "frontend", ready: "port", life: "task" }, fail: null }, fixture, gen, { services: config.services });
  await stopPreview("cancel-task", null);
  const canceled = await pending;
  endPreviewStart("cancel-task", gen);
  assert.equal(canceled.ok, false);
  assert.equal(readPreview("cancel-task"), null);
  console.log("preview settings/proxy tests passed: persisted selection, processes, HTTP, resources, SSE, WebSocket, credentials, permissions, cleanup, multiline and cancellation");
} finally {
  for (const task of ["preview-task", "script-task", "cancel-task", "failure-task", "vite-task", "vite-base-task"]) await stopPreview(task, null);
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await dbClient.close();
  rmSync(root, { recursive: true, force: true });
}
