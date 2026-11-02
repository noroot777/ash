const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
let build;

function requirePlatform() {
  if (process.platform !== "win32") {
    throw Object.assign(new Error(`EOWNERSHIP: 原生 Job 工具仅支持 Windows，当前平台 ${process.platform}`), { code: "EOWNERSHIP" });
  }
}

function invoke(executable, args) {
  requirePlatform();
  const result = childProcess.spawnSync(executable, args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error || result.signal || result.status !== 0) {
    throw Object.assign(new Error(`原生测试执行域失败: ${args[0]}\n${result.stderr ?? ""}`, { cause: result.error }), {
      code: result.error?.code ?? "EOWNERSHIP", result,
    });
  }
  return result.stdout.trim();
}

function executable() {
  requirePlatform();
  if (build) return build.executable;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ash-test-native-"));
  const target = path.join(directory, "test-process-native.exe");
  const source = path.join(__dirname, "test-process-native.cs");
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  try {
    invoke("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(
      `$ErrorActionPreference='Stop'; Add-Type -Path ${quote(source)} -OutputAssembly ${quote(target)} -OutputType ConsoleApplication`, "utf16le").toString("base64")]);
    build = { executable: target, directory };
    return target;
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 }); throw error; }
}

function dispose() {
  if (!build) return;
  fs.rmSync(build.directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 });
  build = undefined;
}

module.exports = { executable, invoke, dispose };
