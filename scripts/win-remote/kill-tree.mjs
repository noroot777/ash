// 超时之后,怎么才算「那条命令真的没人在动对端工作区了」。
//
// 事后按父链拍快照(Get-CimInstance Win32_Process 沿 ParentProcessId 往下走)这条路,单靠
// 它是**不成立**的:Windows 的父子关系只是一个 PID 字段,中间那层进程一退出,链就断了 ——
// npm 起 node、node 起 tsx 之后自己先退,tsx 就成了「谁的孩子都不是」。等到超时才去拍快照,
// 拍到的只有还连着的那部分;`Process.Kill($true)` 同样是沿现存父链走,一样够不着。
// 实测:root→middle→grandchild,middle 先退,快照里只有 root 一个,杀完还报「已确认全部退出」,
// 而 grandchild 12 秒后照样把产物写进了那个 worktree —— 漏杀之外还给了个相反的健康结论,
// 外面的锁就是凭这句话还回去的。
//
// 所以约束必须在**启动时**就下到内核:Job Object 是 Windows 上唯一「进程一旦加进来,它此后
// 所有后代自动继承、脱链也跑不掉」的容器。用到三件事:
//   ① KILL_ON_JOB_CLOSE —— 句柄一关,容器里的进程全部被杀。这条顺带保住了另一个场景:
//      开发机提前 abort 把终端会话 DELETE 掉时,wrapper 所在的 pwsh 一死,句柄由内核回收,
//      整棵树跟着走,不需要 wrapper 自己还有机会执行清理代码。
//   ② TerminateJobObject —— 超时时一刀切掉整个容器,不关心父链长什么样。
//   ③ BasicAccountingInformation.ActiveProcesses —— 「确认真退干净了」的硬依据:
//      内核直接告诉你容器里还剩几个活的,不用再靠快照自证。
//
// 但 Job 不是万能的,两处退化必须在报告里说实话(见 killTreeLines 的三分支措辞):
//   · Start-Process 返回到 AssignProcessToJobObject 之间有一个几毫秒的窗口,子进程若在这段
//     时间里就 fork 出孙子,那个孙子不在容器里 —— 这种漏网还连在活父链上,由旧的快照路径兜。
//     两条路互补,所以快照那套一条都没删。
//   · Add-Type / CreateJobObject 任何一步失败(老运行时、受限环境),就只剩快照那套。这时候
//     **不许**再说「已确认全部退出」,得写明「脱链后代可能漏网」。
//
// 所有片段都必须是**单行** PowerShell:wrapper 是一整行喂进 PTY 的,任何裸换行都会被当成回车。
import { psq } from "./ps.mjs";

const JOB_CS = `
using System;
using System.Runtime.InteropServices;

namespace WinRemote {
  public static class Job {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimit {
      public BasicLimit Basic;
      public IoCounters Io;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
      public long TotalUserTime;
      public long TotalKernelTime;
      public long ThisPeriodTotalUserTime;
      public long ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount;
      public uint TotalProcesses;
      public uint ActiveProcesses;
      public uint TotalTerminatedProcesses;
    }

    private const int ExtendedLimitInformation = 9;
    private const int BasicAccountingInformation = 1;
    private const uint KillOnJobClose = 0x2000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, IntPtr returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    // 匿名 job(不给名字),避免撞上机器上别人建的同名容器。
    public static IntPtr Create() {
      IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) return IntPtr.Zero;
      ExtendedLimit limit = new ExtendedLimit();
      limit.Basic.LimitFlags = KillOnJobClose;
      int len = Marshal.SizeOf(typeof(ExtendedLimit));
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        Marshal.StructureToPtr(limit, buf, false);
        if (!SetInformationJobObject(job, ExtendedLimitInformation, buf, (uint)len)) {
          CloseHandle(job);
          return IntPtr.Zero;
        }
      } finally {
        Marshal.FreeHGlobal(buf);
      }
      return job;
    }

    public static bool Assign(IntPtr job, IntPtr process) {
      if (job == IntPtr.Zero || process == IntPtr.Zero) return false;
      return AssignProcessToJobObject(job, process);
    }

    // 容器里还活着几个。-1 = 问不出来(没有容器 / 查询失败),跟 0 是两回事,别混。
    public static int Active(IntPtr job) {
      if (job == IntPtr.Zero) return -1;
      int len = Marshal.SizeOf(typeof(Accounting));
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        if (!QueryInformationJobObject(job, BasicAccountingInformation, buf, (uint)len, IntPtr.Zero)) return -1;
        Accounting info = (Accounting)Marshal.PtrToStructure(buf, typeof(Accounting));
        return (int)info.ActiveProcesses;
      } finally {
        Marshal.FreeHGlobal(buf);
      }
    }

    public static bool Terminate(IntPtr job) {
      if (job == IntPtr.Zero) return false;
      return TerminateJobObject(job, 1);
    }

    public static void Close(IntPtr job) {
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
`;

const JOB_B64 = Buffer.from(JOB_CS, "utf8").toString("base64");

/**
 * 建容器。放在 Start-Process **之前**。
 * Add-Type 与 Create 分开 try:同一个 pwsh 会话里重复 Add-Type 会报「类型已存在」,那时候
 * 类型其实是可用的 —— 两句写在一个 try 里就会把可用的容器也一起丢掉。
 */
export const jobPreludeLines = () => [
  `$__job=[IntPtr]::Zero; $__jobok=$false`,
  `try{ Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(JOB_B64)}))) -ErrorAction Stop }catch{}`,
  `try{ $__job=[WinRemote.Job]::Create() }catch{ $__job=[IntPtr]::Zero }`,
];

/** 把刚起的进程收进容器。紧跟 Start-Process,中间不许插任何东西 —— 那是漏网窗口。 */
export const jobAssignLine = () =>
  `if($__job -ne [IntPtr]::Zero){ try{ $__jobok=[WinRemote.Job]::Assign($__job,$__p.Handle) }catch{ $__jobok=$false } }`;

/**
 * 关容器 = 连带杀掉命令跑完后还赖着不走的后代(KILL_ON_JOB_CLOSE)。
 * 正常结束路径也要关:这个工具的语义是「命令回来了 = 对端工作区没人碰了」,留个后台进程
 * 在里面写文件,下一次同步的 git clean 就跟它撞上。
 */
export const jobCloseLine = () =>
  `if($__job -ne [IntPtr]::Zero){ try{ [WinRemote.Job]::Close($__job) }catch{} }`;

/**
 * 超时判定 + 杀树 + 确认 + 结论措辞。`$__p` 是被等的进程,产出 `$__e`(124 或真实退出码)
 * 和 `$__km`(结论文案,只在 124 时有内容)。
 */
export const killTreeLines = (secs) => [
  // 快照要在动手**之前**拍(杀完就再也问不出父子关系了),并且连进程创建时间一起记 ——
  // PID 会被复用,只凭 PID 补刀有可能砍到一个刚好顶上这个号的无关进程。
  // 两个 scriptblock 都**直接往管道里吐**,不要写成 `,@(...)`。那个惯用法只在赋值给变量时
  // 才对;这里外面已经套了 `@(& $__snap ...)`,再加逗号就多包一层 —— 拿到的是「长度 1、
  // 唯一元素是数组」,于是 `$__tree.Count` 恒为 1、`$__alive` 里的 `$_.Id` 拿到的是整段数组、
  // 拼进 CIM -Filter 变成语法错。实测表现:树其实杀干净了,报告却说「仍有 1 个没退出: 」
  // 且 ID 是空的 —— 结论和 ID 自相矛盾,而两种错(误报残留、漏报残留)都不吵。
  `$__snap={param($__r0) $__a=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction SilentlyContinue); $__ids=@([int]$__r0); for($__i=0;$__i -lt 8;$__i++){ $__add=@($__a|Where-Object{ $__ids -contains [int]$_.ParentProcessId -and $__ids -notcontains [int]$_.ProcessId }|ForEach-Object{[int]$_.ProcessId}); if($__add.Count -eq 0){break}; $__ids+=$__add }; $__a|Where-Object{ $__ids -contains [int]$_.ProcessId }|ForEach-Object{ [pscustomobject]@{Id=[int]$_.ProcessId;Born=$_.CreationDate} }}`,
  // 还活着的成员 = PID 还在,**且**创建时间跟快照里的一致。
  `$__alive={param($__tr) $__tr|Where-Object{ $__c=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.Id) -Property ProcessId,CreationDate -ErrorAction SilentlyContinue; $__c -and $__c.CreationDate -eq $_.Born }}`,
  `$__tree=@(); $__left=@(); $__km=''; $__act=-1`,
  // 三刀依次落下,一刀不如一刀精确,但覆盖面反过来:
  //   ① TerminateJobObject —— 容器内全部,含已经脱链的后代
  //   ② Kill($true) —— 沿现存父链整棵树(.NET 5+ / pwsh 7);老运行时抛 MethodException,
  //      退回 taskkill /T /F
  //   ③ 对快照里仍活着的逐个补刀
  // 确认分两路:容器有效就问内核要 ActiveProcesses(硬依据),否则只能回读快照(有盲区)。
  `if(-not $__p.HasExited){ $__tree=@(& $__snap $__p.Id); if($__jobok){ try{ $null=[WinRemote.Job]::Terminate($__job) }catch{} }; try{ $__p.Kill($true) }catch{ try{ $null=& taskkill.exe /PID $__p.Id /T /F 2>&1 }catch{} }; $null=$__p.WaitForExit(10000); $__left=@(& $__alive $__tree); if($__left.Count -gt 0){ foreach($__k in $__left){ try{ $null=& taskkill.exe /PID $__k.Id /T /F 2>&1 }catch{} }; Start-Sleep -Milliseconds 1500; $__left=@(& $__alive $__tree) }; if($__jobok){ for($__w=0;$__w -lt 20;$__w++){ $__act=[WinRemote.Job]::Active($__job); if($__act -le 0){ break }; Start-Sleep -Milliseconds 250 } }; $__e=124 } else { $__e=$__p.ExitCode }`,
  // 结论分五种,分开说 —— 「没杀干净」「确认干净」「压根不知道干不干净」是三件事,
  // 而后者又分「CIM 都不可用」和「只有快照没有容器(脱链后代看不见)」。上一版把最后这种
  // 也写成「已确认全部退出」,于是漏杀的那次给出的是相反的健康结论。
  `if($__e -eq 124){ if($__left.Count -gt 0){ $__km = ';⚠ 仍有 ' + $__left.Count + ' 个没退出: ' + ((@($__left)|ForEach-Object{$_.Id}) -join ',') + ' —— 它们可能还在动对端工作区,本次之后的结果都不可信' } elseif($__jobok -and $__act -gt 0){ $__km = ';⚠ Job 容器里仍有 ' + $__act + ' 个进程没退出 —— 它们可能还在动对端工作区,本次之后的结果都不可信' } elseif($__jobok -and $__act -eq 0){ $__km = '(Job 容器,快照 ' + $__tree.Count + ' 个进程),已确认容器内全部退出(含脱链后代)' } elseif($__tree.Count -eq 0){ $__km = ',但既没有 Job 容器也拿不到进程树快照(CIM 不可用),只确认了直接进程已退出' } else { $__km = '(' + $__tree.Count + ' 个进程,Job 容器不可用),只按活父链快照确认 —— 中间进程已退出的脱链后代看不见,可能仍在动对端工作区' } }`,
];
