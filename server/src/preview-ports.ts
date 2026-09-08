import { createServer } from "node:net";
import { PORT_ENV_ALIASES, PORT_SLOT } from "./preview-command.js";

function freePort(): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(null));
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 一次借几个端口。1 个给「要看的那个」，其余给它的配角（后端、网关、mock 服务…）。
 *
 * 5 = 一个前端 + 四个后端，够覆盖「一个前端挂着一排微服务」的常见规模；借多了不花钱
 * （探完就关），少了就得让用户回去写死端口，而写死端口正是这一整套要解决的问题。
 */
export const PORT_POOL = 5;

export async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const port = await freePort();
    // 借不到就停：拿到几个是几个，第一个拿不到时 portEnv 会退化成「什么都不注入」，
    // 跟这套机制上线前的行为一致。
    if (port === null || ports.includes(port)) break;
    ports.push(port);
  }
  return ports;
}

/** 撞车时给的下一步在 preview-log.ts。 */

/**
 * 借来的端口怎么递给命令。两组名字，各有各的收件人：
 *
 *   · `PORT` / `SERVER_PORT` / `ASPNETCORE_URLS` / …：**要看的那个**服务的端口，同一个值
 *     换好几个名字。名单和理由在 preview-command.ts 的 PORT_ENV_ALIASES —— 从那儿导入而
 *     不是在这儿再抄一份：识别出来的命令按哪个名字拿端口，跟这里注入哪些名字，是同一件事
 *     的两头，抄成两份迟早对不上（那时症状是「某种语言的预览永远起在写死的端口上」）。
 *   · `PORT2…PORT5` / `URL2…URL5`：**配角**的端口和地址。一条命令里起前后端时，前端要在
 *     启动那一刻就知道后端在哪 —— 两边都是随机端口，谁也猜不到谁，只能由 ash 同时借下来
 *     一起告诉它们。`URLn` 是 `http://localhost:<PORTn>`，因为绝大多数前端的代理目标要的
 *     是整条地址而不是一个数字（vite 的 `server.proxy.target`、`VITE_*_URL` 之类）。
 *     配角要哪个名字由它自己在命令里写（`SERVER_PORT=$PORT2 …`），所以这里只给号码。
 *
 * 认不了环境变量的（vite / Django / Laravel / Rails……）由命令自己带 `$PORT` —— 那也是同一个
 * 值，因为这里注进去的就是 shell 展开时看到的 PORT。
 */
export function portEnv(ports: number[]): Record<string, string> {
  const [primary, ...rest] = ports;
  if (!primary) return {};
  const env: Record<string, string> = {};
  for (const alias of PORT_ENV_ALIASES) env[alias.name] = alias.template.replaceAll(PORT_SLOT, String(primary));
  rest.forEach((port, index) => {
    env[`PORT${index + 2}`] = String(port);
    env[`URL${index + 2}`] = `http://localhost:${port}`;
  });
  return env;
}

/** 日志头那一行：把注入的环境变量照实写出来，顺序稳定，好让人一眼对上。 */
export function bannerEnv(ports: number[]): string {
  return Object.entries(portEnv(ports)).map(([key, value]) => `${key}=${value}`).join(" ");
}
