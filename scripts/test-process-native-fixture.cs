using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

public static class NativeFixture {
  static void Spawn(string mode, string marker, string pid, int generation) {
    var info = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
      mode + " \"" + marker + "\" \"" + pid + "\" " + generation);
    info.UseShellExecute = false;
    using (var child = Process.Start(info)) {}
  }
  public static void Main(string[] args) {
    var mode = args[0];
    var marker = args[1];
    var pid = args[2];
    if (mode == "normal" || mode == "timeout" || mode == "chain") {
      Spawn(mode == "chain" ? "generation" : "leaf", marker, pid, 0);
      Console.WriteLine("NATIVE_ROOT");
      if (mode == "timeout") Thread.Sleep(20000);
    } else if (mode == "generation" && Int32.Parse(args[3]) < 40) {
      Spawn("generation", marker, pid, Int32.Parse(args[3]) + 1);
    } else {
      File.WriteAllText(pid, Process.GetCurrentProcess().Id.ToString());
      Thread.Sleep(1500);
      Console.WriteLine("NATIVE_TAIL");
      Console.Error.WriteLine("NATIVE_ERROR_TAIL");
      File.WriteAllText(marker, "complete");
    }
  }
}
