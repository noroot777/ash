import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { regressionSnapshot } from "./regression-snapshot.js";

const inputPath = process.argv[2];
const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
  recordPath: string;
  launch: { file: string; args: string[]; windowsVerbatimArguments?: boolean };
};
const record = JSON.parse(readFileSync(input.recordPath, "utf8"));
function save(): void {
  const temporary = `${input.recordPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, input.recordPath);
}

record.before = regressionSnapshot(record.cwd);
record.startedAt = new Date().toISOString();
save();
const descriptor = openSync(record.logPath, "a");
try {
  const child = spawn(input.launch.file, input.launch.args, {
    cwd: record.cwd, stdio: ["ignore", descriptor, descriptor],
    windowsHide: true, windowsVerbatimArguments: input.launch.windowsVerbatimArguments,
  });
  let finished = false;
  function finish(code: number | null, error?: string): void {
    if (finished) return;
    finished = true;
    record.after = regressionSnapshot(record.cwd);
    record.exitCode = code;
    record.error = error ?? null;
    record.endedAt = new Date().toISOString();
    save();
    console.log(`REGRESSION_FINISHED exitCode=${code} record=${input.recordPath} log=${record.logPath}`);
    process.exitCode = code ?? 1;
  }
  child.once("error", (error) => finish(null, error.message));
  child.once("exit", (code) => finish(code));
} finally {
  closeSync(descriptor);
}
