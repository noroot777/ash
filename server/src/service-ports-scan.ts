/**
 * 从命令输出里**认出本机端口**:整条文本一把过,以及 pty 那种一块一块送来的流。
 *
 * 从 service-ports.ts 拆出来的(全局约定:单文件不超过 700 行),判据一字未改。这一段跟
 * 「探端口 / 核归属 / 停进程」那几段没有任何依赖关系 —— 它只认字符串,不碰进程、不碰
 * 外部命令,所以切在这儿最干净。为什么边界要这么抠、为什么流式扫描必须与整条等价,
 * 都写在下面各自的注释里(历次审查的实锤)。
 */

/** 低于这个号的端口一律不认:那一档住的是 22/80/443 这类系统服务。 */
export const MIN_PORT = 1024;

// ── 认端口 ────────────────────────────────────────────────────────────────────

/**
 * 本机地址 + 端口。主机名左边界必须是「非主机名字符」,否则 `notlocalhost:8787` 这种
 * 字样会被当成 localhost(第 1 轮审查)。协议可省 —— 很多脚本只打 `localhost:5173`。
 */
const PORT_PATTERN = /(?:^|[^0-9a-z.-])(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{4,5})(?![0-9])/gi;
/**
 * 增量扫描时在手里留多长的尾巴:够装下「最长的本机地址前缀 + 5 位端口」就行
 * (`https://127.0.0.1:` 是 18 字,`[::1]` 那支更短)。
 */
const SCAN_TAIL_KEEP = 32;

/** 从一段**完整**文本里认出本机端口。只认 ≥1024 的,去重后返回。 */
export function portsFromOutput(text: string): number[] {
  const ports = new Set<number>();
  for (const match of text.matchAll(PORT_PATTERN)) {
    const port = Number(match[1]);
    if (port >= MIN_PORT && port <= 65535) ports.add(port);
  }
  return [...ports];
}

/**
 * pty 的输出是**流**,不是一行一行的消息:`http://127.0.0.1:8787` 完全可能被拆成
 * `http://127.0.0.` + `1:8787` 两块送来(启动器分次 write,或底层按缓冲区切)。拿无状态
 * 正则逐块匹配,这种地址会整条漏掉;更坏的是五位端口先到四位 —— 块尾被当成合法结尾,
 * 于是记下一个**错的**四位端口,那个端口上住的是别人(第 1 轮审查发现 5)。
 *
 * 所以认端口要在流上做,不变量是一句话:**无论怎么切,feed 串联 + flush 的结果必须与
 * 把整条文本一次喂进 `portsFromOutput` 完全一致**。为此有两件事:
 *
 *  ① **只认已经看到右边界的端口**(端口后面还得有一个非数字字符,或者流已经到头),
 *     没看到边界的那一截留给下一块;
 *  ② 接尾巴时**只在尾巴确实被截断过时**才在最前面垫一个主机名字符。垫片是为了压住
 *     「从词中间切出来的尾巴被 `^` 当成左边界」——`notlocalhost:8787` 切在 `notloc` /
 *     `alhost:8787` 之间,拼回去必须仍然不是本机地址。但**尾巴就是流的起点**时,那个
 *     `^` 是真的:无条件垫片反过来伪造了一个本来不存在的主机名前缀,于是启动脚本只打
 *     `localhost:8787` 就整条漏掉(第 2 轮审查发现 4 实测:`portsFromOutput` 给
 *     `[8787]`,同一段文本 feed+flush 给 `[]`;`127.0.0.1` / `0.0.0.0` / `[::1]` 同样)。
 *     所以记一笔「尾巴前面有没有丢掉过字符」,丢过才垫。
 */
export function createPortScanner(): { feed(chunk: string): number[]; flush(): number[] } {
  /** 上一块留下的尾巴(**不含垫片**)。 */
  let tail = "";
  /** 这截尾巴前面已经丢掉过字符吗 —— 丢过,它的开头就不是流的起点,`^` 不算左边界。 */
  let truncated = false;
  const reported = new Set<number>();
  /** 垫片:一个主机名字符,把假的左边界压掉(只在 truncated 时用)。 */
  const GLUE = "x";
  const scan = (text: string, final: boolean): number[] => {
    const fresh: number[] = [];
    for (const match of text.matchAll(PORT_PATTERN)) {
      const port = Number(match[1]);
      if (port < MIN_PORT || port > 65535) continue;
      // 端口紧挨着文本末尾 = 右边界还没到:它可能是 8787 也可能是 87870,留给下一块。
      // flush 时没有下一块了,末尾就是终态。
      if (!final && (match.index ?? 0) + match[0].length >= text.length) continue;
      if (reported.has(port)) continue; // 重叠的尾巴会再次匹配到同一个端口
      reported.add(port);
      fresh.push(port);
    }
    return fresh;
  };
  /** 把尾巴接上这一块,顺手把「有没有丢过字符」更新到接完之后的状态。 */
  const join = (chunk: string): string => {
    const glue = truncated && tail ? GLUE : "";
    const text = glue + tail + chunk;
    const kept = Math.min(SCAN_TAIL_KEEP, text.length - glue.length);
    truncated = truncated || text.length - glue.length > SCAN_TAIL_KEEP;
    tail = text.slice(text.length - kept); // kept ≤ 真实长度,所以绝不会把垫片留进尾巴
    return text;
  };
  return {
    feed(chunk: string): number[] {
      return scan(join(chunk), false);
    },
    /** 流到头了(会话退出):手里那截尾巴按终态再认一遍 —— 地址恰好是最后一个字时才用到。 */
    flush(): number[] {
      if (!tail) return [];
      const text = (truncated ? GLUE : "") + tail;
      tail = "";
      return scan(text, true);
    },
  };
}
