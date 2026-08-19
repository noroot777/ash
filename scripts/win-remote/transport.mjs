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
import { jobPreludeLines, jobAssignLine, jobCloseLine, killTreeLines } from "./kill-tree.mjs";

const DEFAULT_HOST = process.env.WIN_REMOTE_HOST ?? "http://192.168.1.187:4317";

// 命令期限之外,额外留给「杀树 + 确认退干净 + 把已经写下的输出捞回来 + 回传」的时间。
// 对端那段收尾最长要:等 Kill 后确认 10s + 补刀 1.5s + 容器轮询 5s + 落盘等待 0.3s + 上传。
// 30 秒是这条链路的上界再加一点余量 —— 它只在命令真的超时时才会用掉。
const CLEANUP_GRACE = 30_000;

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

// 控制面单跳的兜底期限。**不存在「没有期限」的调用路径**:上一版把「带 signal」写成调用方的
// 义务,于是漏一个调用点就等于漏一条永不返回的路 —— CLI 的 `target()` 正是那个漏网的:
// 它在进 rexec 之前先查一次项目,对端只接连接不回包时,`doctor/sync/exec/test` 四个子命令
// 全都停在「对端 harness」那一行不动,只能外面 kill。义务型的约定挡不住这种事,默认值可以。
const CONTROL_TIMEOUT = Number(process.env.WIN_REMOTE_CONTROL_TIMEOUT ?? 15_000);
/** 一次控制面调用的期限。给不出更长命的 signal 时(CLI 的单发请求)就用它。 */
export const controlSignal = () => AbortSignal.timeout(CONTROL_TIMEOUT);

// 控制面的每一跳都走这里。裸 fetch 没有任何超时,对端只接连接不回包时它能永远不返回 ——
// 所以这里给每一跳都补上 signal:调用方给了就用调用方的(整次调用共用一个 deadline),
// 没给就兜一个 CONTROL_TIMEOUT,绝不让 fetch 裸奔。
async function api(path, init = {}, host = DEFAULT_HOST) {
  const fallback = !init.signal;
  const signal = init.signal ?? controlSignal();
  let res;
  try {
    res = await fetch(`${host}/api${path}`, { ...init, signal });
  } catch (e) {
    // 期限型 signal 到点时,DOMException 的原文是 "The operation was aborted due to timeout" ——
    // 看不出是哪一跳、对着谁、等了多久。换成人话。
    // AbortController.abort() 那种(rexec 整次调用的 deadline)要原样抛回去:
    // rexec 靠 `ac.signal.aborted` 把它翻译成「按失败返回 code 124」,不能在这儿改写语义。
    if (signal.aborted && signal.reason?.name === "TimeoutError") {
      const limit = fallback ? `${CONTROL_TIMEOUT}ms` : "期限";
      throw new Error(`${init.method ?? "GET"} ${path} → ${limit}内没等到 ${host} 的响应(对端 harness 没在跑,或者卡住了)`);
    }
    throw e;
  }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return res.status === 204 ? null : res.json();
}

/** 找到对端 harness 里指向 harness 仓库自己的那个项目(终端会话必须挂在某个项目上)。 */
export async function resolveProject(host = DEFAULT_HOST, signal = controlSignal()) {
  const projects = await api("/projects", { signal }, host);
  if (!projects.length) throw new Error("对端 harness 里一个项目都没有,先在它的界面上添加 harness 仓库");
  const pick = process.env.WIN_REMOTE_PROJECT;
  if (pick) {
    // 指定了 id 也照样得把项目取回来:`repoPath` 是后面每条命令的 cwd,给不出来的话
    // 所有子命令都会撞上「拿不到对端仓库路径,请用 WIN_REMOTE_PROJECT 指定」——
    // 而那正是你刚照做过的事。这个覆盖项本来就是给「自动猜歪了」救场的,
    // 恰好在最需要它的时候不可用。
    const hit = projects.find((p) => p.id === pick);
    if (!hit) {
      throw new Error(
        `WIN_REMOTE_PROJECT=${pick} 在对端 harness 里不存在。现有项目:\n` +
          projects.map((p) => `  ${p.id}  ${p.repoPath ?? "(无路径)"}`).join("\n"),
      );
    }
    return { id: hit.id, repoPath: hit.repoPath };
  }
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
    // `server.close()` 只是停止接受新连接,已建立的 keep-alive 连接会把回调吊住 ——
    // Windows 那边 `Invoke-WebRequest` 收完 204 并不会立刻断开。先掐连接再关,
    // 否则「关掉服务器」这一步本身会挂住整个进程。
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

const stripAnsi = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");

// PTY 画面里除了程序输出,还有 pwsh 的横幅和提示符。预览只想看进度,这些一律不显示。
// 被回显的 wrapper 不在这条正则的职责里 —— 见下面 echoFilter。
const NOISE = /Set-PSReadLineOption|Invoke-WebRequest|PS [A-Z]:\\|^PowerShell \d|^Copyright|^\s*$/;
const isNoise = (line) => NOISE.test(line);

const B64ISH = /^[A-Za-z0-9+/=]{24,}$/;
/**
 * 把「我们自己发进去、又被 PTY 回显出来的那几十行」挡在预览之外。
 *
 * 不能用关键字正则:wrapper 是**一条**几 KB 的长命令,PTY 按 cols 硬折成几十行,
 * 只有第一折带得上 `FromBase64String` 之类的词,后面全是裸 base64 —— 上一版就这么漏的,
 * 一次 sync 有 60 多行、13KB 可逆编码进了预览。除了淹没真进度,`exec` 的用户命令(可能含
 * 路径、token)也在那串 base64 里,等于把它们以能还原的形式写进终端日志和审查记录。
 *
 * 改成按**内容**认:每一折都是我们发出去那串字符的连续子串,拿原文一查便知,折在哪儿都无所谓。
 * 再加一条「纯 base64 长串」兜底,防某一折被插进光标控制码后对不上原文。
 */
const echoFilter = (sent) => (line) => {
  const s = line.trim();
  if (s.length < 24) return false; // 太短的片段容易误伤真输出,而它也淹没不了什么
  if (B64ISH.test(s) || sent.includes(s)) return true;
  // 还有一类漏网的:PTY 把**两次输入**的回显挤进同一屏行(上一条命令 base64 的尾巴,
  // 紧接着下一条命令的明文开头)。这种行既不是 sent 的连续子串,也不是纯 base64,
  // 于是整整 13KB 又原样进了预览 —— 上一轮只按「连续子串」判,就是这么漏的。
  // 改成看**这一行有多大比例是我们自己发出去的**:切成 64 字符的片段逐段回查,过半命中
  // 就算回显。真实输出凑不出这种命中率(它得有一半内容逐字出现在我们发的命令里)。
  if (s.length < 128) return false;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 64 <= s.length; i += 64) {
    total++;
    if (sent.includes(s.slice(i, i + 64))) hit++;
  }
  return total > 0 && hit * 2 >= total;
};

/**
 * 在对端 Windows 上跑一条命令。
 *
 * @param cmd      PowerShell 命令(可多行)
 * @param cwd      在哪个目录跑;默认项目目录
 * @param timeout  毫秒,**那条命令**能跑多久;超时按失败(code 124)返回而不是抛。
 *                 开发机这头的硬期限是 timeout + CLEANUP_GRACE —— 多出来的那段是留给对端
 *                 杀树、确认、回传的,不是第二个 deadline。
 * @param onLine   实时预览回调 —— 传的是 PTY 画面(脏),只用来看进度,别拿它当结果
 */
export async function rexec(cmd, { cwd = null, timeout = 15 * 60_000, onLine = null, host = DEFAULT_HOST, projectId = null } = {}) {
  const token = randomBytes(9).toString("hex");
  const sink = collector(token);

  // deadline 从**第一次远端请求之前**开始,而且只有这一个。
  // 原来它是在 session 建成之后才起算的,于是「对端 harness 卡死、代理只接连接不回包、
  // 半开连接」这类**永不返回**的失败全都漏在保护之外:查项目、建会话、两次 /input 用的都是
  // 裸 fetch,调用者传的 timeout 一点约束力都没有,进程能挂到底层 TCP 自己想通为止。
  // 上一轮只修了「fetch 立刻抛错之后要清理」,没修「fetch 根本不返回」。
  // 现在同一个 signal 串起控制面的每一跳,连收回传的兜底也挂在它的 abort 上。
  //
  // 硬期限**必须晚于对端那条命令的期限**,而且要晚出足够收尾的时间。上一版是反着来的:
  // 外层 = timeout、对端 = max(5, timeout/1000 - 20) —— timeout 小于 25 秒时对端期限反而更长,
  // 于是开发机先 abort、终端会话被 DELETE,对端那段杀树/删临时文件的代码一行都没跑到。
  // 实测 timeout=3000:3.02 秒返回 124,10 秒后孙 pwsh 还活着、延迟 marker 照写,
  // `%TEMP%` 里留着一整组 `<token>.ps1/.out/.err`(.ps1 是明文的远程命令)。
  const hardMs = timeout + CLEANUP_GRACE;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), hardMs);

  // 下面这一整段都得在 try 里:回传服务一 listen 就是个活着的 handle,只要还开着,
  // Node 事件循环就不会空 —— 而**建会话之前**的每一步都可能抛(对端重启、地址写错、
  // 网络闪断都够)。错误确实交还给了调用者,进程却再也不退,用户看到的是
  // 「报了个错然后永远不结束」。清理必须覆盖每条失败路径,不能只挂在正常路径末尾。
  let session = null;
  let pid = projectId;
  let pump = null;
  try {
    pid = projectId ?? (await resolveProject(host, ac.signal)).id;
    const port = await sink.listen();
    const self = detectLocalAddress();

    session = await api(`/projects/${pid}/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols: 200, rows: 50 }),
      signal: ac.signal,
    }, host);

    // `pwsh -File x.ps1` **不会**把脚本里最后一条外部命令的退出码当成自己的退出码 ——
    // 脚本正常跑完就是 0。不显式收尾的话,`npm test` 明明断言失败(exit 1),这里照样报 0,
    // 于是整批回归全绿而实际全红 —— 比假超时更坏,因为它不吵。
    // 开头先把 $LASTEXITCODE 清零(没跑过外部命令时它是 $null),末尾原样交出去;
    // 中途 throw 走不到这行,pwsh 自己会退 1。
    const script = `$LASTEXITCODE=0\n${cmd}\nexit $LASTEXITCODE`;
    const b64 = Buffer.from(script, "utf8").toString("base64");
    // 对端那条命令的期限 = 调用者要的那个。收尾时间由开发机那头的 hardMs 额外让出来,
    // 不从这里扣 —— 扣出来的下限(旧版是 5 秒)正是短 timeout 那条漏网路径的根。
    const secs = Math.max(1, Math.round(timeout / 1000));
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
      // 顺手扫掉一小时前的同格式残留:wrapper 中途崩了、机器断电、会话被掐,下面那套「上传前
      // 就删干净」都执行不到,总得有个不依赖任何一次会话的兜底。名字是 18 位 hex + 三种固定
      // 后缀,不会碰到别人的东西;一小时的门槛保证不会误删**正在跑**的另一条命令(单条上限 10 分钟)。
      `Get-ChildItem -LiteralPath $env:TEMP -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^[0-9a-f]{18}\\.(ps1|out|err)$' -and $_.LastWriteTime -lt (Get-Date).AddHours(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue`,
      `$__d='${(cwd ?? "").replace(/'/g, "''")}'`,
      `$__o=Join-Path $env:TEMP '${token}.out'; $__r=Join-Path $env:TEMP '${token}.err'; $__s=Join-Path $env:TEMP '${token}.ps1'`,
      `[IO.File]::WriteAllText($__s,[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')),(New-Object Text.UTF8Encoding $false))`,
      `$__x=[Diagnostics.Process]::GetCurrentProcess().Path`,
      `$__nl=[Environment]::NewLine`,
      // 容器要在起进程**之前**建好(见 kill-tree.mjs 顶部:事后按父链补拍快照够不着脱链后代)。
      ...jobPreludeLines(),
      `$__p=Start-Process -FilePath $__x -ArgumentList '-NoProfile','-NonInteractive','-File',$__s -RedirectStandardOutput $__o -RedirectStandardError $__r -PassThru -NoNewWindow` + (cwd ? ` -WorkingDirectory $__d` : ``),
      jobAssignLine(),
      `$null=$__p|Wait-Process -Timeout ${secs} -ErrorAction SilentlyContinue`,
      // 超时收尾要**连整棵进程树一起杀,而且确认它真的退干净了**再往下走。
      // 只 Kill 直接子进程是不够的:那条命令下面挂着 npm→node→tsx 一长串后代,它们活过这一刀,
      // 而 rexec 一返回,外面那把工作区锁当场就还回去了 —— 下一个人开始在同一个 worktree 上
      // checkout/clean,上一条命令的孙子还在里面写文件。两边都各自「正常」,谁也看不出结果为什么
      // 是错的。三刀(容器 / 父链 / 逐个补刀)和三种结论措辞都在 kill-tree.mjs 里。
      ...killTreeLines(secs),
      `Start-Sleep -Milliseconds 300`,
      `$__t=[string](Get-Content $__o -Raw -ErrorAction SilentlyContinue)`,
      `$__g=[string](Get-Content $__r -Raw -ErrorAction SilentlyContinue)`,
      `if($__g){ $__t = $__t + $__nl + '--- stderr ---' + $__nl + $__g }`,
      // 没杀干净就照实说 —— 这时候「工作区已经没人碰了」这个前提不成立,后面那次同步/测试
      // 的结果都得存疑,咽下去比报错更坏。
      `if($__e -eq 124){ $__t = $__t + $__nl + '[win-remote] 超时 ${secs}s,已杀掉进程树' + $__km }`,
      // 三个临时文件在**上传之前**就删光,上传改从内存发字节(而不是 `-InFile` 指着磁盘)。
      // 原来的顺序是「先上传、再 Remove-Item」,而开发机一收到 body 就往下走、随手把终端
      // 会话 DELETE 掉 —— 删文件那句和杀会话是在赛跑,输的时候 `%TEMP%` 里就留下一份
      // **明文的远程命令**(`.ps1` 里是完整脚本,不只是磁盘垃圾)。现在删在前、发在后,
      // 本地收到回传时对端磁盘上已经一个 token 文件都没有,竞争这件事从根上不存在。
      `Remove-Item -LiteralPath $__o,$__r,$__s -Force -ErrorAction SilentlyContinue`,
      // 关容器 —— 正常跑完那条路径也要关:命令回来了就意味着「对端工作区没人碰了」,
      // 留个后台后代在里面写文件,下一次同步的 git clean 会跟它撞上(见 kill-tree.mjs)。
      jobCloseLine(),
      `$__b=[Text.Encoding]::UTF8.GetBytes([string]$__t)`,
      `try { Invoke-WebRequest -Uri "http://${self}:${port}/${token}?code=$__e" -Method PUT -Body $__b -ContentType 'text/plain; charset=utf-8' -TimeoutSec 60 -UseBasicParsing | Out-Null } catch { }`,
    ].filter(Boolean).join("; ");

    // 我们往 PTY 里塞的全部字符 —— 回显判定拿它当原文比对(见 echoFilter)。
    const psreadline = "Set-PSReadLineOption -PredictionSource None";
    const isEcho = echoFilter(`${psreadline}\n${wrapper}`);

    let preview = "";
    pump = (async () => {
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
              for (const p of parts) if (p.trim() && !isNoise(p) && !isEcho(p)) onLine(p);
            }
          } catch { /* 非 JSON 帧忽略 */ }
        }
      }
    })().catch((e) => { if (e.name !== "AbortError") throw e; });

    // PSReadLine 的预测建议会把历史命令混进画面,先关掉(只影响预览可读性)。
    await new Promise((r) => setTimeout(r, 400));
    const send = (data) => api(`/projects/${pid}/terminal/sessions/${session.id}/input`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }),
      signal: ac.signal,
    }, host);
    await send(`${psreadline}\r`);
    await new Promise((r) => setTimeout(r, 300));
    await send(`${wrapper}\r`);

    // 兜底不再自己起一个 timeout 那么长的定时器 —— 那是**第二个** deadline,从命令发出去
    // 才起算,总时长能到两倍。改挂在同一个 signal 的 abort 上:整次调用只有一个期限。
    return await Promise.race([
      sink.done,
      new Promise((r) => {
        const fire = () => r({ code: 124, out: `[win-remote] 超时 ${hardMs}ms(命令期限 ${timeout}ms + 收尾 ${CLEANUP_GRACE}ms),未收到回传`, timedOut: true });
        if (ac.signal.aborted) fire();
        else ac.signal.addEventListener("abort", fire, { once: true });
      }),
    ]);
  } catch (e) {
    // deadline 到点时,卡住的那一跳会以 AbortError 抛出来。但 rexec 对调用者的承诺是
    // 「超时按失败返回而不是抛」(收回传那条路径一直是这么做的),控制面卡住没道理换一种。
    if (ac.signal.aborted) {
      return { code: 124, out: `[win-remote] 超时 ${hardMs}ms,对端 harness 的控制面请求没在期限内返回`, timedOut: true };
    }
    throw e;
  } finally {
    clearTimeout(timer);
    ac.abort();
    await sink.close();
    // pump 的失败只影响预览(实时画面),不该顶掉真正的结果或真正的错误 —— 但也不能
    // 静静吞掉,否则 SSE 那头坏了永远没人知道。
    await pump?.catch((e) => console.warn(`⚠︎ 预览流中断(不影响结果):${e.message}`));
    if (session) {
      // 清理不能用主 signal:走到这儿它多半已经 abort 了(正常结束也会),那样这条 DELETE
      // 必然失败,会话就留在对端。给它自己的期限 —— 同样不能没有期限,否则「对端卡死」只是
      // 从上面挪到了这里;取 min(5s, timeout) 是因为它加在调用者的等待时间**之后**,
      // 不该让一次 timeout=500ms 的调用变成等 5 秒半。
      await api(`/projects/${pid}/terminal/sessions/${session.id}`, {
        method: "DELETE", signal: AbortSignal.timeout(Math.min(5_000, timeout)),
      }, host).catch(() => {});
    }
  }
}
