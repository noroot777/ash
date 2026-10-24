export function windowsRestartTargets(rows, rootPid, protectedPids) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const born = (row) => {
    if (!row || !/^\d+$/.test(row.created ?? "")) throw new Error("进程代次不可用");
    return BigInt(row.created);
  };
  const walk = (roots) => {
    const found = new Set();
    const pending = roots.filter((pid) => byPid.has(pid));
    while (pending.length) {
      const parentPid = pending.pop();
      if (found.has(parentPid)) continue;
      found.add(parentPid);
      const parentBorn = born(byPid.get(parentPid));
      for (const row of rows) {
        if (row.ppid !== parentPid) continue;
        if (born(row) >= parentBorn) pending.push(row.pid);
      }
    }
    return found;
  };
  const descendants = walk(Array.isArray(rootPid) ? rootPid : [rootPid]);
  const spared = walk(protectedPids);
  return rows.filter((row) => {
    if (!descendants.has(row.pid) || spared.has(row.pid)) return false;
    if (!row.command || row.ppid === null) throw new Error(`${row.pid} 的进程身份不完整`);
    return true;
  });
}

export function windowsTerminateScript(targets) {
  const identities = targets.map((row) => `${row.pid}:${row.created}`).join(",");
  return `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AshRestartHandles {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long born, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  public static void Kill(string identities) {
    var handles = new List<IntPtr>();
    try {
      foreach (var identity in identities.Split(',')) {
        if (identity.Length == 0) continue;
        var parts = identity.Split(':');
        var handle = OpenProcess(0x101001, false, Int32.Parse(parts[0]));
        if (handle == IntPtr.Zero) {
          var error = Marshal.GetLastWin32Error();
          if (error == 87) continue;
          throw new Win32Exception(error);
        }
        handles.Add(handle);
        long born, exit, kernel, user;
        if (!GetProcessTimes(handle, out born, out exit, out kernel, out user)) throw new Win32Exception();
        if (born / 10 != Int64.Parse(parts[1]) / 10) throw new Exception("PID generation changed: " + parts[0]);
      }
      foreach (var handle in handles) {
        if (WaitForSingleObject(handle, 0) == 0) continue;
        if (!TerminateProcess(handle, 1) && WaitForSingleObject(handle, 0) != 0) throw new Win32Exception();
      }
    } finally {
      foreach (var handle in handles) CloseHandle(handle);
    }
  }
}
'@
[AshRestartHandles]::Kill('${identities}')
[Console]::Out.WriteLine('ASH_RESTART_KILLED')`;
}
