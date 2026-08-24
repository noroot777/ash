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
  options: ExecFileOptionsWithStringEncoding = {},
): Promise<ExecFileTextResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { ...options, encoding: options.encoding ?? "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error as ExecFileException, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
