// 从预览进程的日志里读出「它到底怎么了」。
//
// 单独一个模块是为了能被纯函数测试钉住（preview.ts 一进来就拖着 db 和进程管理）。
// 这里只有正则和字符串，不碰任何副作用。
//
// 判据本身的由来见 PORT_TAKEN_RE 的注释：**端口撞车必须当场认出来**，因为它既不能干等
// 超时，更不能被误判成「起好了」。

// 「端口被别人占着」必须**当场**认出来，不能等超时。两个理由，都不是省那两分钟：
//   ① 撞车时日志第一行就把话说完了，再干等 120 秒只会让用户收到一句「等了 120 秒还
//      没起来」——真正的原因被埋在末尾 800 字里，得他自己去翻。
//   ② 更糟的是**误报成功**：占着那个端口的进程是活的，`canConnect` 当然连得上，日志里
//      又印着 `http://localhost:5173`，于是我们会兴高采烈地写一句「预览已起」，把用户
//      引到**别人的服务**上去验收自己的改动。所以这道检查排在就绪判定**前面**。
const PORT_TAKEN_RE = /EADDRINUSE|address already in use|port .{0,12}already in use/i;

/** 「占用了但我自己换一个」不算失败 —— vite 非 strictPort 就是这么干的，别把它判死。 */
const PORT_RETRY_RE = /trying another|retry|retrying|instead|falling back|fallback/i;

/** 撞车那一行里的端口号（"Port 5173 is already in use" → 5173）。取不到就只说撞了。 */
export function portConflict(log: string): string | null {
  for (const line of log.split("\n")) {
    if (!PORT_TAKEN_RE.test(line) || PORT_RETRY_RE.test(line)) continue;
    const port = /\b(\d{2,5})\b/.exec(line)?.[1];
    return port ? `端口 ${port} 已经被别的进程占着` : "启动命令要用的端口已经被别的进程占着";
  }
  return null;
}

/** 撞车时给的下一步。带上这次分到的端口，用户能直接照抄。 */
export function portHint(port: number | null): string {
  const name = port ? `PORT=${port}` : "PORT";
  return "启动命令里的端口多半是写死的，而同一个项目此刻往往已经有一份在跑"
    + "（你自己那份、或者别的任务的预览）。\n"
    + `harness 已经给这次预览借了一个空闲端口，以环境变量 ${name} 传了进去 —— `
    + "把这一站的启动命令改成认它的写法就能错开，例如 `npm run dev -- --port $PORT`。";
}

/** 日志里印出来的本机地址。`lent` 为真表示它就落在我们借出去的那个端口上。 */
export interface PreviewUrl {
  url: string;
  port: number;
  lent: boolean;
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?[^\s'"]*/gi;

/**
 * 从日志里挑出「预览本尊」的地址。
 *
 * 不能见到第一个 URL 就当它是：**一条 `npm run dev` 并排起好几个服务是常态**（concurrently
 * 起前端 + 后端、框架顺带印一个 API 地址），谁先把自己的地址打出来纯看运气，挑错了就是把
 * 用户领到隔壁那个服务上去验收。所以借出去的那个端口优先 —— 那是我们刚探出来的空闲端口，
 * 命令认了它，落在上面的地址必然是这一站要看的东西。
 *
 * `lent` 这个标记还兼着第二个用处，见 preview.ts 里撞车判定的那个例外。
 */
export function pickPreviewUrl(log: string, lent: number | null): PreviewUrl | null {
  let first: PreviewUrl | null = null;
  for (const hit of log.matchAll(URL_RE)) {
    const url = hit[0];
    const port = Number(hit[1] ?? (url.startsWith("https") ? 443 : 80));
    if (lent !== null && port === lent) return { url, port, lent: true };
    first ??= { url, port, lent: false };
  }
  return first;
}

