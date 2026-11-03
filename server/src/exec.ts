import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

export interface ExecFileTextResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a background command and collect text output without creating a Windows
 * console window. The server normally runs detached, so the Node default would
 * otherwise give every short-lived console program its own conhost/OpenConsole.
 */
export function execFileText(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding & { input?: string } = {},
): Promise<ExecFileTextResult> {
  const { input, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { ...rest, encoding: rest.encoding ?? "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error as ExecFileException, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    // 有 input 就整份写进 stdin 再关上（路径清单这类可能撑爆命令行长度的参数走这里）。
    if (input !== undefined) child.stdin?.end(input);
  });
}
