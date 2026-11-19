// 给「会去探本机 CLI」的测试用：让探测只碰得到桩，碰不到这台机器上真装着的 claude / codex / …
//
// 探测按 PATH 在前、补充目录（/opt/homebrew/bin、~/.local/bin …）在后的顺序找命令，先命中的
// 算数（src/executors/bin-resolve.ts 的 resolveBin）。所以给目录里登记的**每个**命令名铺一个桩、
// 再把桩目录排到 PATH 最前，真 CLI 就一个都轮不到。桩不管收到什么参数都只打一行版本号：
// `--version` 拿得到版本，清单命令解析不出任何模型（走「探到了但没列出模型」那条降级）。
//
// 要拿本机真 CLI 对答案的那几段（装了才断言的）改看 `NAVI_TEST_REAL_CLI=1`：默认不跑，
// 结论不跟着这台机器装了哪一版走。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// 这个文件自己不静态 import 任何 src 模块：用它的测试多半要先把库指到临时目录，再加载产品代码。
const IS_WINDOWS = process.platform === "win32";

/** 明说要问本机真 CLI。 */
export const REAL_HOST_CLI = process.env.NAVI_TEST_REAL_CLI === "1";

export const STUB_VERSION = "navi-test-stub 0.0.0";

/** 壳按平台换的理由见 test-cli-catalog.ts 的 writeEchoStub。 */
export function writeVersionStub(dir: string, name: string, version: string): string {
  const file = join(dir, IS_WINDOWS ? `${name}.cmd` : name);
  writeFileSync(file, IS_WINDOWS ? `@echo ${version}\r\n` : `#!/bin/sh\necho ${JSON.stringify(version)}\n`, { mode: 0o755 });
  return file;
}

/** 往 dir 里给每个登记的命令名铺一个桩。 */
export async function stubHostClis(dir: string): Promise<void> {
  const { CLI_SPECS } = await import("../src/executors/catalog/index.js");
  for (const spec of CLI_SPECS) for (const bin of spec.bins) writeVersionStub(dir, bin, STUB_VERSION);
}

/**
 * 整条测试都不碰本机 CLI：铺桩、排到 PATH 最前，并拿掉门禁给的「不探模型目录」开关
 * （用它的测试要测的正是探测）。`NAVI_TEST_REAL_CLI=1` 时什么都不铺。
 */
export async function shadowHostClis(): Promise<void> {
  delete process.env.NAVI_TEST_NO_MODEL_PROBE;
  if (REAL_HOST_CLI) return;
  const dir = mkdtempSync(join(tmpdir(), "navi-host-cli-stubs-"));
  await stubHostClis(dir);
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  process.on("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
}
