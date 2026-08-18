// 在开发机上执行「那台 Windows 上的命令」,并拿回干净的输出和退出码。
//
// 为什么不是 SSH:那台机器只开了两个入站端口 —— 445(SMB,要凭证)和 4317(harness 自己)。
// 装 OpenSSH Server 要管理员提权,无人值守时点不动 UAC。所以通道只能是 harness 自己的
// 终端 API(POST /projects/:id/terminal/sessions),它在 Windows 上起的是 ConPTY + pwsh。
//
// 为什么输出不直接从 PTY 读:PTY 回给你的是**终端画面**,不是程序输出 —— 命令本身会被
// 回显、PSReadLine 会插入灰色历史建议、超过 cols 的行被硬折、满屏 ANSI 控制码。实测
// 拿它当结果解析,连 `node -v` 都能切出半行命令文本。所以这里只把 PTY 当**触发器**:
// 命令的真实输出重定向到 Windows 本地临时文件,再由 Windows 主动 PUT 回开发机起的一次性
// HTTP 服务。反向连通已实测可行(Windows → Mac:8899 拿到 200),于是输出全程没经过终端。
//
// 命令用 base64 传:内联进 PowerShell 脚本要考虑引号/花括号/换行的转义,base64 之后是
// 一行纯 ASCII,PTY 输入(64KB 上限)也不会被特殊字符打断。
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";

const DEFAULT_HOST = process.env.WIN_REMOTE_HOST ?? "http://192.168.1.187:4317";

/** 挑一个 Windows 那台连得回来的本机 IPv4。回传服务要绑它,127.0.0.1 对面够不着。 */
export function detectLocalAddress() {
  if (process.env.WIN_REMOTE_SELF) return process.env.WIN_REMOTE_SELF;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/^(lo|utun|awdl|llw|bridge)/.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  throw new Error("找不到可被对端访问的本机 IPv4,请用 WIN_REMOTE_SELF=<ip> 指定");
}

async function api(path, init = {}, host = DEFAULT_HOST) {
  const res = await fetch(`${host}/api${path}`, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return res.status === 204 ? null : res.json();
}

/** 找到对端 harness 里指向 harness 仓库自己的那个项目(终端会话必须挂在某个项目上)。 */
export async function resolveProject(host = DEFAULT_HOST) {
  if (process.env.WIN_REMOTE_PROJECT) return { id: process.env.WIN_REMOTE_PROJECT, repoPath: null };
  const projects = await api("/projects", {}, host);
  if (!projects.length) throw new Error("对端 harness 里一个项目都没有,先在它的界面上添加 harness 仓库");
  const hit = projects.find((p) => /harness|ash/i.test(p.repoPath ?? "")) ?? projects[0];
  return { id: hit.id, repoPath: hit.repoPath };
}

/** 收 Windows 回传的一次性 HTTP 服务:一个请求,收完即关。 */
function collector(token) {
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.endsWith(`/${token}`)) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(204).end();
      resolve({ code: Number(url.searchParams.get("code") ?? 0), out: Buffer.concat(chunks).toString("utf8") });
    });
  });
  return {
    done,
    listen: () => new Promise((r) => server.listen(0, "0.0.0.0", () => r(server.address().port))),
    close: () => server.close(),
  };
}

const stripAnsi = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");

// PTY 画面里除了程序输出,还有 pwsh 的横幅、提示符、以及被整行回显的 wrapper 脚本
// (那条 base64 有好几 KB)。预览只想看进度,这些一律不显示。
const NOISE = /FromBase64String|Set-PSReadLineOption|Invoke-WebRequest|PS [A-Z]:\\|^PowerShell \d|^Copyright|^\s*$/;
const isNoise = (line) => NOISE.test(line);

/**
 * 在对端 Windows 上跑一条命令。
 *
 * @param cmd      PowerShell 命令(可多行)
 * @param cwd      在哪个目录跑;默认项目目录
 * @param timeout  毫秒,超时按失败返回而不是抛
 * @param onLine   实时预览回调 —— 传的是 PTY 画面(脏),只用来看进度,别拿它当结果
 */
export async function rexec(cmd, { cwd = null, timeout = 15 * 60_000, onLine = null, host = DEFAULT_HOST, projectId = null } = {}) {
  const pid = projectId ?? (await resolveProject(host)).id;
  const token = randomBytes(9).toString("hex");
  const sink = collector(token);
  const port = await sink.listen();
  const self = detectLocalAddress();

  const session = await api(`/projects/${pid}/terminal/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols: 200, rows: 50 }),
  }, host);

  const b64 = Buffer.from(cmd, "utf8").toString("base64");
  const secs = Math.max(5, Math.floor(timeout / 1000) - 20);
  // 为什么起独立进程而不是 `<cmd> *>&1 | Out-File`:管道要等**所有**持有 stdout 的句柄关闭
  // 才算结束,而 Windows 上留一个孙进程是常事 —— node-pty 的 conpty_console_list_agent
  // 崩了却不退,整条命令就永远等不到 EOF。实测 `npm run test:terminal` 明明 exit 0,
  // 管道模式却挂满 10 分钟报假超时。改成 Start-Process 之后,结束判据是**进程退出**,
  // 跟残留句柄无关;超时还能 Kill 掉并把已经写下的输出捞回来。
  // 代价是 stdout/stderr 只能分开重定向(Start-Process 不许两路指向同一个文件),
  // 所以下面把 stderr 单独拼在后面,而不是交错。
  const wrapper = [
    `$ErrorActionPreference='Continue'`,
    // 外部程序(npm/node/tsx)吐的是 UTF-8 字节,PowerShell 默认按活动代码页(中文机器是 936)解,
    // 中文输出会变成「鉁?璺緞」这种乱码 —— 测试断言里的中文全糊掉。这两行把两端都钉成 UTF-8。
    `$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8`,
    `$__d='${(cwd ?? "").replace(/'/g, "''")}'`,
    `$__o=Join-Path $env:TEMP '${token}.out'; $__r=Join-Path $env:TEMP '${token}.err'; $__s=Join-Path $env:TEMP '${token}.ps1'`,
    `[IO.File]::WriteAllText($__s,[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')),(New-Object Text.UTF8Encoding $false))`,
    `$__x=[Diagnostics.Process]::GetCurrentProcess().Path`,
    `$__nl=[Environment]::NewLine`,
    `$__p=Start-Process -FilePath $__x -ArgumentList '-NoProfile','-NonInteractive','-File',$__s -RedirectStandardOutput $__o -RedirectStandardError $__r -PassThru -NoNewWindow` + (cwd ? ` -WorkingDirectory $__d` : ``),
    `$null=$__p|Wait-Process -Timeout ${secs} -ErrorAction SilentlyContinue`,
    `if(-not $__p.HasExited){ try{$__p.Kill()}catch{}; $__e=124 } else { $__e=$__p.ExitCode }`,
    `Start-Sleep -Milliseconds 300`,
    `$__t=[string](Get-Content $__o -Raw -ErrorAction SilentlyContinue)`,
    `$__g=[string](Get-Content $__r -Raw -ErrorAction SilentlyContinue)`,
    `if($__g){ $__t = $__t + $__nl + '--- stderr ---' + $__nl + $__g }`,
    `if($__e -eq 124){ $__t = $__t + $__nl + '[win-remote] 超时 ${secs}s,已杀掉进程' }`,
    `[IO.File]::WriteAllText($__o,[string]$__t,(New-Object Text.UTF8Encoding $false))`,
    `try { Invoke-WebRequest -Uri "http://${self}:${port}/${token}?code=$__e" -Method PUT -InFile $__o -ContentType 'text/plain' -TimeoutSec 60 -UseBasicParsing | Out-Null } catch { }`,
    `Remove-Item -LiteralPath $__o,$__r,$__s -Force -ErrorAction SilentlyContinue`,
  ].filter(Boolean).join("; ");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  let preview = "";
  const pump = (async () => {
    const res = await fetch(`${host}/api/projects/${pid}/terminal/sessions/${session.id}/events?after=0`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (!ev.data) continue;
          preview += stripAnsi(ev.data);
          if (onLine) {
            const parts = preview.split("\n");
            preview = parts.pop() ?? "";
            for (const p of parts) if (p.trim() && !isNoise(p)) onLine(p);
          }
        } catch { /* 非 JSON 帧忽略 */ }
      }
    }
  })().catch((e) => { if (e.name !== "AbortError") throw e; });

  // PSReadLine 的预测建议会把历史命令混进画面,先关掉(只影响预览可读性)。
  await new Promise((r) => setTimeout(r, 400));
  const send = (data) => api(`/projects/${pid}/terminal/sessions/${session.id}/input`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }),
  }, host);
  await send("Set-PSReadLineOption -PredictionSource None\r");
  await new Promise((r) => setTimeout(r, 300));
  await send(`${wrapper}\r`);

  const result = await Promise.race([
    sink.done,
    new Promise((r) => setTimeout(() => r({ code: 124, out: `[win-remote] 超时 ${timeout}ms,未收到回传`, timedOut: true }), timeout)),
  ]);

  clearTimeout(timer);
  ac.abort();
  sink.close();
  await pump;
  await api(`/projects/${pid}/terminal/sessions/${session.id}`, { method: "DELETE" }, host).catch(() => {});
  return result;
}
