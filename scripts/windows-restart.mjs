export function windowsRestartPlan(rows, rootPid, protectedPids) {
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
  const rootPids = Array.isArray(rootPid) ? rootPid : [rootPid];
  const descendants = walk(rootPids);
  for (const pid of rootPids) {
    const root = byPid.get(pid);
    if (root && (!root.command || root.ppid === null)) throw new Error(`${pid} 的进程身份不完整`);
  }
  const protectedTree = walk(protectedPids);
  const preservedPids = rows
    .filter((row) => descendants.has(row.pid) && !protectedTree.has(row.pid) && !row.command)
    .map((row) => row.pid);
  const spared = walk([...protectedPids, ...preservedPids]);
  for (const pid of rootPids) {
    if (spared.has(pid) && !protectedTree.has(pid)) throw new Error(`${pid} 位于命令行不可读的受保护子树中`);
  }
  const targets = rows.filter((row) => {
    if (!descendants.has(row.pid) || spared.has(row.pid)) return false;
    if (!row.command || row.ppid === null) throw new Error(`${row.pid} 的进程身份不完整`);
    return true;
  });
  return { targets, preservedPids };
}

export function windowsRestartTargets(rows, rootPid, protectedPids) {
  return windowsRestartPlan(rows, rootPid, protectedPids).targets;
}

/**
 * 终止这一批**实例**:按号码开句柄,就着**同一个句柄**核代次再 TerminateProcess ——
 * 「查到的那一个」和「下刀的那一个」是同一个内核对象,中间没有按号码重找的缝。
 *
 * 身份令牌两种写法,核的都是句柄自己报的出生时刻:
 *  · `created` 是一串数字 ⇒ **精确**代次。生产重启用这一种:那一行刚从进程表里读到。
 *  · `created` 写成 `起-止` ⇒ **区间**。测试执行域用这一种:号码来自它自己的登记文件,
 *    手上没有进程表那一行,但「必须出生在本域创建之后、登记之前」这件事它自己知道 ——
 *    于是不必先起一个 powershell 去查一遍代次再起第二个去杀,一次就够(清场是有人等着的,
 *    见 test-process-scope.mjs 的「先砍一刀」)。
 *
 * `tolerant` 决定代次对不上时怎么办:默认**整批抛**(生产重启要么全对要么一个都不动);
 * 开了则跳过那一个、把号码打在 `ASH_RESTART_SKIPPED <pid>` 上继续 —— 清场时一个号码换了
 * 主人不该把其余真该停的一起拦下。
 */
export function windowsTerminateScript(targets, options = {}) {
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
  static bool Matches(long born, string token) {
    var dash = token.IndexOf('-');
    if (dash < 0) return born / 10 == Int64.Parse(token) / 10;
    return born >= Int64.Parse(token.Substring(0, dash)) && born <= Int64.Parse(token.Substring(dash + 1));
  }
  public static void Kill(string identities, bool tolerant) {
    var handles = new List<IntPtr>();
    var doomed = new List<IntPtr>();
    var skipped = new List<int>();
    try {
      foreach (var identity in identities.Split(',')) {
        if (identity.Length == 0) continue;
        var parts = identity.Split(':');
        var pid = Int32.Parse(parts[0]);
        var handle = OpenProcess(0x101001, false, pid);
        if (handle == IntPtr.Zero) {
          var error = Marshal.GetLastWin32Error();
          if (error == 87) continue;
          if (tolerant) { skipped.Add(pid); continue; }
          throw new Win32Exception(error);
        }
        handles.Add(handle);
        long born, exit, kernel, user;
        if (!GetProcessTimes(handle, out born, out exit, out kernel, out user)) {
          if (!tolerant) throw new Win32Exception();
          skipped.Add(pid); continue;
        }
        if (!Matches(born, parts[1])) {
          if (!tolerant) throw new Exception("PID generation changed: " + parts[0]);
          skipped.Add(pid); continue;
        }
        doomed.Add(handle);
      }
      foreach (var handle in doomed) {
        if (WaitForSingleObject(handle, 0) == 0) continue;
        if (!TerminateProcess(handle, 1) && WaitForSingleObject(handle, 0) != 0) throw new Win32Exception();
      }
    } finally {
      foreach (var handle in handles) CloseHandle(handle);
    }
    foreach (var pid in skipped) Console.Out.WriteLine("ASH_RESTART_SKIPPED " + pid);
  }
}
'@
[AshRestartHandles]::Kill('${identities}', $${options.tolerant ? "true" : "false"})
[Console]::Out.WriteLine('ASH_RESTART_KILLED')`;
}
