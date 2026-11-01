using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TestProcessNative {
  const uint AllJob = 0x3f, QueryProcess = 0x1000, Synchronize = 0x100000;
  const uint Suspended = 4, UnicodeEnvironment = 0x400, UseStdHandles = 0x100, ExtendedStartup = 0x80000;
  const uint KillOnClose = 0x2000;
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long PerProcess, PerJob;
    public uint Flags;
    public UIntPtr Minimum, Maximum;
    public uint Active;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public uint Size;
    public IntPtr Reserved, Desktop, Title;
    public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint Pid, Tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx {
    public Startup Startup;
    public IntPtr Attributes;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr buffer, uint size, out uint returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long born, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern void GetStartupInfo(ref Startup startup);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr Process(uint pid, uint access) {
    var handle = OpenProcess(access, false, pid);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }
  static long Born(IntPtr process) {
    long born, exit, kernel, user;
    Check(GetProcessTimes(process, out born, out exit, out kernel, out user));
    return born;
  }
  static IntPtr Job(string name) {
    var handle = OpenJobObject(AllJob, false, name);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }
  static uint Active(IntPtr job) {
    var size = Marshal.SizeOf(typeof(Accounting));
    var buffer = Marshal.AllocHGlobal(size);
    try {
      uint returned;
      Check(QueryInformationJobObject(job, 1, buffer, (uint)size, out returned));
      return ((Accounting)Marshal.PtrToStructure(buffer, typeof(Accounting))).Active;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  static void Enter(Mutex gate, bool allowAbandoned = false) {
    try { if (!gate.WaitOne(15000)) throw new Exception("Ownership gate timed out"); }
    catch (AbandonedMutexException) {
      if (!allowAbandoned) { gate.ReleaseMutex(); throw new Exception("Ownership gate abandoned; refusing enrollment"); }
    }
  }
  static void Stop(IntPtr job, EventWaitHandle stopped, Mutex gate) {
    Enter(gate, true);
    try { stopped.Set(); Check(TerminateJobObject(job, 86)); }
    finally { gate.ReleaseMutex(); }
    var deadline = DateTime.UtcNow.AddSeconds(15);
    while (Active(job) != 0) {
      if (DateTime.UtcNow >= deadline) throw new Exception("Job has not reached ACTIVE_PROCESS_ZERO");
      Thread.Sleep(10);
    }
  }
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') result.Append('\\', slashes * 2 + 1).Append('"');
      else result.Append('\\', slashes).Append(character);
      slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  static ProcessInfo CreateInJob(IntPtr job, StringBuilder command, Startup startup) {
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var attributes = Marshal.AllocHGlobal(size);
    var jobs = Marshal.AllocHGlobal(IntPtr.Size);
    bool initialized = false;
    try {
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
      initialized = true;
      Marshal.WriteIntPtr(jobs, job);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      startup.Size = (uint)Marshal.SizeOf(typeof(StartupEx));
      var extended = new StartupEx { Startup = startup, Attributes = attributes };
      ProcessInfo info;
      Check(CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, Suspended | UnicodeEnvironment | ExtendedStartup, IntPtr.Zero, null, ref extended, out info));
      return info;
    } finally {
      if (initialized) DeleteProcThreadAttributeList(attributes);
      Marshal.FreeHGlobal(jobs);
      Marshal.FreeHGlobal(attributes);
    }
  }
  static int Run(string[] args, ref IntPtr job, EventWaitHandle stopped, Mutex gate) {
    string launch = args[2];
    bool shell = args[3] == "--shell";
    string app = shell ? args[4] : args[3];
    var command = new StringBuilder(Quote(app));
    if (shell) command.Append(" /d /s /c \"").Append(args[5]).Append('"');
    else for (int index = 4; index < args.Length; index++) command.Append(' ').Append(Quote(args[index]));
    var startup = new Startup();
    GetStartupInfo(ref startup);
    startup.Size = (uint)Marshal.SizeOf(typeof(Startup));
    startup.Flags = UseStdHandles;
    startup.Input = GetStdHandle(-10);
    startup.Output = GetStdHandle(-11);
    startup.Error = GetStdHandle(-12);
    ProcessInfo info = new ProcessInfo();
    Enter(gate);
    try {
      if (stopped.WaitOne(0)) throw new Exception("Test domain stopped before launch");
      info = CreateInJob(job, command, startup);
      try {
        File.WriteAllText(launch + ".pending", "{\"pid\":" + info.Pid + ",\"born\":\"" + Born(info.Process) + "\"}");
        File.Move(launch + ".pending", launch);
        if (ResumeThread(info.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
      } catch {
        TerminateProcess(info.Process, 86);
        WaitForSingleObject(info.Process, 15000);
        CloseHandle(info.Process);
        throw;
      }
    } finally {
      gate.ReleaseMutex();
      if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
    }
    CloseHandle(job);
    job = IntPtr.Zero;
    try {
      if (WaitForSingleObject(info.Process, UInt32.MaxValue) != 0) throw new Exception("Root wait failed");
      uint code;
      Check(GetExitCodeProcess(info.Process, out code));
      return unchecked((int)code);
    } finally { if (info.Process != IntPtr.Zero) CloseHandle(info.Process); }
  }
  static string Rows(IntPtr job) {
    var deadline = DateTime.UtcNow.AddSeconds(5);
    bool retry = false;
    while (DateTime.UtcNow < deadline) {
      if (retry) Thread.Sleep(10);
      retry = true;
      uint count = Active(job);
      int size = checked(8 + ((int)count + 256) * IntPtr.Size);
      var buffer = Marshal.AllocHGlobal(size);
      var rows = new List<string>();
      try {
        uint returned;
        if (!QueryInformationJobObject(job, 3, buffer, (uint)size, out returned)) {
          if (Marshal.GetLastWin32Error() == 234) continue;
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        int assigned = Marshal.ReadInt32(buffer), listed = Marshal.ReadInt32(buffer, 4);
        if (assigned != listed) continue;
        for (int index = 0; index < listed; index++) {
          uint pid = checked((uint)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64());
          IntPtr process = OpenProcess(QueryProcess | Synchronize, false, pid);
          if (process == IntPtr.Zero) {
            if (Marshal.GetLastWin32Error() == 87) continue;
            throw new Win32Exception(Marshal.GetLastWin32Error());
          }
          try {
            bool member;
            Check(IsProcessInJob(process, job, out member));
            if (!member || WaitForSingleObject(process, 0) == 0) continue;
            rows.Add("{\"pid\":" + pid + ",\"born\":\"" + Born(process) + "\"}");
          } finally { CloseHandle(process); }
        }
        if (rows.Count != Active(job)) continue;
        return "[" + String.Join(",", rows.ToArray()) + "]";
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new Exception("Job membership did not stabilize; ownership cannot be confirmed");
  }
  static int Hold(string[] args) {
    var name = args[1];
    var directory = args[2];
    var owner = Process(UInt32.Parse(args[3]), QueryProcess | Synchronize);
    IntPtr job = IntPtr.Zero;
    try {
      if (Born(owner).ToString() != args[4]) throw new Exception("Owner instance changed");
      job = CreateJobObject(IntPtr.Zero, name);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (Marshal.GetLastWin32Error() == 183) throw new Exception("Job name already exists");
      var limits = new ExtendedLimits();
      limits.Basic.Flags = KillOnClose;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      using (var gate = new Mutex(false, name + "-gate"))
      using (var stopped = new EventWaitHandle(false, EventResetMode.ManualReset, name + "-stopped")) {
        File.WriteAllText(Path.Combine(directory, "ready"), "ready");
        while (WaitForSingleObject(owner, 20) == 258 && !File.Exists(Path.Combine(directory, "release"))) {}
        Stop(job, stopped, gate);
        File.WriteAllText(Path.Combine(directory, "closed"), "closed");
      }
      return 0;
    } finally { if (job != IntPtr.Zero) CloseHandle(job); CloseHandle(owner); }
  }
  public static int Main(string[] args) {
    try {
      if (args[0] == "hold") return Hold(args);
      if (args[0] == "identity") {
        var process = Process(UInt32.Parse(args[1]), QueryProcess);
        try { Console.WriteLine(Born(process)); return 0; } finally { CloseHandle(process); }
      }
      var job = Job(args[1]);
      try {
        using (var gate = Mutex.OpenExisting(args[1] + "-gate"))
        using (var stopped = EventWaitHandle.OpenExisting(args[1] + "-stopped")) {
          if (args[0] == "stop") { Stop(job, stopped, gate); return 0; }
          if (args[0] == "list") { Console.WriteLine(Rows(job)); return 0; }
          if (args[0] == "run") return Run(args, ref job, stopped, gate);
          if (args[0] == "inspect") {
            var process = Process(UInt32.Parse(args[2]), QueryProcess);
            try {
              Enter(gate);
              try {
                if (stopped.WaitOne(0)) throw new Exception("Test domain stopped before enrollment");
                bool member;
                Check(IsProcessInJob(process, job, out member));
                if (!member) throw new Exception("Node started outside its native domain");
                Console.WriteLine(Born(process));
              } finally { gate.ReleaseMutex(); }
            } finally { CloseHandle(process); }
            return 0;
          }
          throw new Exception("Unknown domain command");
        }
      } finally { if (job != IntPtr.Zero) CloseHandle(job); }
    } catch (Exception error) {
      if (args.Length > 2 && args[0] == "hold") {
        try { File.WriteAllText(Path.Combine(args[2], "failed"), error.ToString()); } catch {}
      }
      if (args.Length > 2 && args[0] == "run") {
        try { File.WriteAllText(args[2] + ".error", error.ToString()); } catch {}
      }
      Console.Error.WriteLine(error);
      return 125;
    }
  }
}
