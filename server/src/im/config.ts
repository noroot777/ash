// 飞书应用凭证：落在库文件旁的 `<db>.feishu.json`（0600），照接力身份文件的做法（handoff-identity.ts）。
//
// 为什么不进 app_settings：`GET /settings` 会把整份设置回给任何已登录的人，preview-seed 还会把
// 它复制进预览库。为什么不进环境变量：agentBaseEnv() 只在隔离宿主 CLI 那一档才清理环境变量
// （executors/spawn.ts），自用模式下所有 agent 都会继承。挂在库文件旁还顺带保证「不同 ASH_DB
// = 不同实例」：预览实例和 `ASH_DB=… PORT=…` 起的测试实例拿不到这份文件，天然不会去连飞书 ——
// 飞书长连接是集群模式，同一应用连上两个客户端，事件会被随机分走一半。
//
// 要如实写给用户的边界：agent 与 server 是同一个 OS 用户，读得到这个文件；Windows 上 chmod 不生效。
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveAshDbFile } from "../db/path.js";

export type FeishuDomain = "feishu" | "lark";

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  updatedAt: string;
}

const APP_ID_RE = /^cli_[A-Za-z0-9]{8,40}$/;

export function credentialsPath(): string {
  return `${resolveAshDbFile()}.feishu.json`;
}

export function domainUrl(domain: FeishuDomain): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

export function isValidAppId(value: string): boolean {
  return APP_ID_RE.test(value);
}

export type CredentialsRead =
  | { kind: "missing" }
  | { kind: "ok"; credentials: FeishuCredentials }
  /** transient = 文件在、这一下读不了（权限、句柄耗尽、IO 错）：通道过一会儿自己再试，不是格式坏了。 */
  | { kind: "broken"; error: string; transient?: boolean };

export function readCredentials(path = credentialsPath()): CredentialsRead {
  // 只有「没有这个文件」才是没配：existsSync 对读不了的（没权限、目录坏了）也回 false，会把「读不了」报成「没配」。
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "broken", error: `飞书凭证文件这一下读不了（${(error as Error).message}）：${path}`, transient: true };
  }
  try {
    const raw = JSON.parse(text) as Partial<FeishuCredentials> & { version?: number };
    if (raw.version !== 1 || typeof raw.appId !== "string" || typeof raw.appSecret !== "string") {
      return { kind: "broken", error: `飞书凭证文件格式不认识：${path}` };
    }
    if (!isValidAppId(raw.appId) || !raw.appSecret) {
      return { kind: "broken", error: `飞书凭证文件里的 App ID / App Secret 不完整：${path}` };
    }
    return {
      kind: "ok",
      credentials: {
        appId: raw.appId,
        appSecret: raw.appSecret,
        domain: raw.domain === "lark" ? "lark" : "feishu",
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      },
    };
  } catch {
    return { kind: "broken", error: `飞书凭证文件损坏：${path}` };
  }
}

export function writeCredentials(input: Omit<FeishuCredentials, "updatedAt">, path = credentialsPath()): FeishuCredentials {
  const credentials: FeishuCredentials = { ...input, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, ...credentials }, null, 2), { mode: 0o600 });
  // 已存在的文件 writeFileSync 不会改权限，补一次 chmod（Windows 上是空操作）。
  try { chmodSync(path, 0o600); } catch { /* 文件系统不支持权限位 */ }
  return credentials;
}

export function clearCredentials(path = credentialsPath()): void {
  rmSync(path, { force: true });
}
