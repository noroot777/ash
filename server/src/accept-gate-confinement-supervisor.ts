import { execFileText } from "./exec.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let compiling: Promise<string> | null = null;

export function gateJobSupervisorExecutable(): Promise<string> {
  if (!compiling) compiling = compileGateJobSupervisor().finally(() => { compiling = null; });
  return compiling;
}

async function compileGateJobSupervisor(): Promise<string> {
  const directory = join(tmpdir(), "ash-accept-gate");
  mkdirSync(directory, { recursive: true });
  const digest = createHash("sha256").update(GATE_JOB_SUPERVISOR).digest("hex");
  const executable = join(directory, `supervisor-${digest}.exe`);
  if (existsSync(executable)) return executable;
  const temporary = join(directory, `compile-${randomUUID()}.exe`);
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${GATE_JOB_SUPERVISOR}\n'@`
    + ` -OutputAssembly '${temporary.replace(/'/g, "''")}' -OutputType WindowsApplication`;
  try {
    await execFileText("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { timeout: 20_000 });
    try { renameSync(temporary, executable); }
    catch (error) { if (!existsSync(executable)) throw error; }
    return executable;
  } finally { rmSync(temporary, { force: true }); }
}

export const GATE_JOB_SUPERVISOR = String.raw`
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AshGateJob {
  public static void Main(string[] args) {
    if (args.Length == 5) Run(args[0], int.Parse(args[1]), args[2], args[3], args[4]);
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr buffer, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static int Active(IntPtr job) {
    IntPtr buffer = Marshal.AllocHGlobal(48);
    try {
      if (!QueryInformationJobObject(job, 1, buffer, 48, IntPtr.Zero)) return -1;
      return Marshal.ReadInt32(buffer, 40);
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  static void Persist(string path, string id, int rootPid, string rootStartedAt, string state) {
    int supervisorPid = System.Diagnostics.Process.GetCurrentProcess().Id;
    string text = "{\"version\":2,\"id\":\"" + id.Replace("\\", "\\\\")
      + "\",\"rootPid\":" + rootPid + ",\"rootStartedAt\":\"" + rootStartedAt.Replace("\"", "\\\"")
      + "\",\"supervisorPid\":" + supervisorPid
      + ",\"state\":\"" + state + "\"}";
    string temporary = path + "." + supervisorPid + ".tmp";
    byte[] bytes = Encoding.UTF8.GetBytes(text);
    using (FileStream output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) {
      output.Write(bytes, 0, bytes.Length);
      output.Flush(true);
    }
    if (File.Exists(path)) File.Replace(temporary, path, null);
    else File.Move(temporary, path);
  }

  public static void Run(string id, int rootPid, string evidence, string abort, string rootStartedAt) {
    DateTimeOffset expected;
    if (!DateTimeOffset.TryParse(rootStartedAt, CultureInfo.InvariantCulture, DateTimeStyles.None, out expected)) return;
    long expectedFileTime;
    try { expectedFileTime = expected.UtcDateTime.ToFileTimeUtc(); }
    catch { return; }
    IntPtr root = OpenProcess(0x1000 | 0x0100 | 0x0001, false, (uint)rootPid);
    if (root == IntPtr.Zero) return;
    try {
      long creation, exit, kernel, user;
      if (!GetProcessTimes(root, out creation, out exit, out kernel, out user)
        || creation / 10 != expectedFileTime / 10) return;
      RunVerified(id, rootPid, evidence, abort, rootStartedAt, root);
    } finally { CloseHandle(root); }
  }

  static void RunVerified(string id, int rootPid, string evidence, string abort, string rootStartedAt, IntPtr root) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, id);
    int created = Marshal.GetLastWin32Error();
    if (job == IntPtr.Zero) return;
    if (created == 183) { CloseHandle(job); return; }
    try {
      ExtendedLimits limits = new ExtendedLimits();
      limits.BasicLimitInformation.LimitFlags = 0x2000;
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) return;
      bool enrolled = AssignProcessToJobObject(job, root);
      if (!enrolled) return;
      try { Persist(evidence, id, rootPid, rootStartedAt, "held"); }
      catch { TerminateJobObject(job, 125); return; }
      for (;;) {
        if (File.Exists(abort)) TerminateJobObject(job, 125);
        if (Active(job) == 0) {
          try { Persist(evidence, id, rootPid, rootStartedAt, "empty"); return; }
          catch { }
        }
        Thread.Sleep(25);
      }
    } finally { CloseHandle(job); }
  }
}
`;
