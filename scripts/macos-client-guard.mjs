// test-macos-client.mjs 的一段：窗口在线之后服务换了人。
//
// 窗口只连这份服务专用的端口（AshConfig.windowPort，server/src/window-port.ts），4317 留给浏览器、CLI。
// 两个端口各摆一个假的应答者：
//   · 窗口端口照真服务的规矩办（server/src/instance-binding.ts）：请求带着别人的实例号就 409；
//   · 4317 换人时换上一份**旧版 ash**：不认实例号，什么请求来了都照办 —— 第 3 轮审查 F1 的那个口子。
// 换人 = 自己那份停了（窗口端口不再有人听）、旧版 ash 接手 4317。页面每 30ms 发一次写请求：从头到尾
// 一条都不许落到 4317 上（旧版 ash 收到就会执行）；刷新那一下拦住、什么都不点也会被定时认人撤下；
// 自家服务原地重起（实例号换了）时换上新的接着用；换回来回到原路由。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

export async function testInstanceGuard({ binary, env, port, windowPort, data, runtime, children, until }) {
  let occupant = "ours";
  let generation = 1;
  const idOf = () => occupant === "ours" ? `ours-${generation}` : "foreign-1";
  const requests = [];
  const health = () => JSON.stringify({ ok: true, pid: occupant === "ours" ? 1 : 4444, instance: occupant === "ours"
    ? { id: idOf(), dataDir: data, codeDir: runtime, localOnly: true, windowPort }
    : { id: idOf(), dataDir: "/elsewhere", codeDir: "/repo/", localOnly: false, windowPort: null } });

  const onBase = (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/health") { response.end(health()); return; }
    // 窗口不该往这里发任何东西：记下来，照旧版 ash 的样子照办。
    requests.push({ on: "base", occupant, url: request.url, cookie: request.headers.cookie ?? null, accepted: true });
    response.end("{}");
  };
  const onWindow = (request, response) => {
    if (request.url === "/api/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(health());
      return;
    }
    // 页面走 cookie，原生的补接请求（HostMcpSetup）走请求头，两样都按服务端的判据认。
    const cookie = /(?:^|;\s*)ash_instance=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? request.headers["x-ash-instance"] ?? null;
    const accepted = cookie === null || cookie === idOf();
    requests.push({ on: "window", occupant, id: idOf(), url: request.url, cookie, accepted });
    if (!accepted) { response.statusCode = 409; response.end("{}"); return; }
    if (request.url === "/api/write") { response.end("{}"); return; }
    response.setHeader("Content-Type", "text/html");
    response.end("<title>OURS</title><script>if(location.pathname==='/')history.replaceState(null,'','/route/abc');"
      + "setInterval(()=>fetch('/api/write',{method:'POST'}).catch(()=>{}),30)</script>");
  };
  const listen = async (at, handler) => {
    const server = createServer(handler);
    server.listen(at, "127.0.0.1");
    await once(server, "listening");
    return server;
  };
  const close = async (server) => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  };

  const base = await listen(port, onBase);
  let window = await listen(windowPort, onWindow);
  try {
    const writes = (id) => requests.filter((r) => r.url === "/api/write" && r.id === id);
    for (const mode of ["reload", "watch"]) {
      occupant = "ours";
      generation += 1;
      requests.length = 0;
      const guard = spawn(binary, ["guard", mode], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      children.add(guard);
      let out = "";
      guard.stdout.on("data", (chunk) => { out += chunk; });
      guard.stderr.on("data", (chunk) => { out += chunk; });
      const exited = once(guard, "exit");
      await until(() => out.includes("LOADED"), `guard probe (${mode}) never loaded our page: ${out}`);
      assert.match(out, new RegExp(`LOADED http://127\\.0\\.0\\.1:${windowPort}/`), `${mode}: the window loads the dedicated port: ${out}`);
      const bound = idOf();
      await until(() => writes(bound).length > 2, `${mode}: the page never wrote`);
      assert.deepEqual([...new Set(requests.map((r) => r.cookie))], [bound], `${mode}: every request carries the confirmed instance`);
      if (mode === "watch") {
        // 自家服务原地重起：实例号换了，旧的被拒，定时认人换上新的，之后的写请求照常执行。
        generation += 1;
        const restarted = idOf();
        await until(() => writes(restarted).some((r) => r.cookie === restarted && r.accepted),
          `${mode}: the page never rebound to our restarted service`, 20000);
      }
      // 自己那份停了：窗口端口没人听，旧版 ash 接手 4317。
      await close(window);
      window = null;
      occupant = "foreign";
      guard.stdin.write("FLIPPED\n");
      await until(() => out.includes("BLANKED"), `guard probe (${mode}) never covered the page: ${out}`, 20000);
      assert.match(out, /BLANKED url=about:blank content=\|\|\n/,
        `${mode}: the whole page is taken down, nothing of the other ash shown: ${out}`);
      assert.deepEqual(requests.filter((r) => r.on === "base"), [],
        `${mode}: nothing the window sent ever reached 4317, where an old ash would have executed it`);
      generation += 1;
      occupant = "ours";
      window = await listen(windowPort, onWindow);
      guard.stdin.write("BACK\n");
      await until(() => out.includes("RESTORED"), `guard probe (${mode}) never came back: ${out}`, 20000);
      const back = idOf();
      await until(() => writes(back).some((r) => r.cookie === back && r.accepted), `${mode}: back on our new instance id`);
      guard.stdin.write("DONE\n");
      const [status] = await exited;
      children.delete(guard);
      assert.equal(status, 0, out);
      assert.match(out, new RegExp(`RESTORED http://127\\.0\\.0\\.1:${windowPort}/route/abc`), `${mode}: back to the same route: ${out}`);
      assert.deepEqual(requests.filter((r) => r.on === "base"), [], `${mode}: the window never talks to 4317`);
    }
  } finally {
    await close(window);
    await close(base);
  }
}
