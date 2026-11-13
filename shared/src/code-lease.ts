// 「这份 ash 代码正被这个进程用着」的登记 —— mac app 换包之前据此判断还有没有人在用旧包
// （desktop/macos/scripts/bundle-users.sh，第 3 轮审查 F2）。
//
// 安装器原来只靠「扫不到」来证明没人用：lsof 看可执行文件和工作目录，再扫命令行里的路径。可
// 用别处的 node 跑包里的脚本时，脚本读完就关了，命令行里写的又可以是相对路径、软链、不带 .app
// 的任何拼写 —— 扫不到不等于没人用。所以反过来，让**代码自己**在启动时登记：服务、ash MCP 不管
// 被谁、从哪个路径、用哪个 node 拉起，只要跑的是这份代码就会留下一条「pid + 启动时刻 + 代码根」，
// 进程退出时撤掉；被 kill -9 留下的那条，安装器按 pid 和启动时刻认出它已经不在了。
//
// 只登记跑在 .app 里的那份（仓库检出不需要换包）；登记失败不影响进程本身。
import { mkdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 登记放在固定位置（不跟 TMPDIR、HOME 走：装包的那个 shell 和起服务的那个环境未必一样）。 */
export const CODE_LEASE_ROOT = process.env.ASH_CODE_LEASES || "/tmp/ash-code-leases";

/** 这份代码的根（shared/src 往上两级），按真实路径。 */
function codeRoot(): string | null {
  try { return realpathSync(fileURLToPath(new URL("../..", import.meta.url))); } catch { return null; }
}

export function holdCodeLease(role: string): void {
  if (process.platform !== "darwin") return;
  const code = codeRoot();
  if (!code || !code.includes(".app/Contents/")) return;
  const file = join(CODE_LEASE_ROOT, `${process.pid}`);
  try {
    mkdirSync(CODE_LEASE_ROOT, { recursive: true });
    try { chmodSync(CODE_LEASE_ROOT, 0o1777); } catch {}
    const started = Math.round((Date.now() - process.uptime() * 1000) / 1000);
    writeFileSync(file, `pid=${process.pid}\nstart=${started}\nrole=${role}\ncode=${code}\n`);
  } catch {
    return;
  }
  process.on("exit", () => { try { rmSync(file, { force: true }); } catch {} });
}
