# Sends Ctrl+C ($env:POCKETIDE_EVENT = 0) or Ctrl+Break (1) to every process on the console of
# process $env:POCKETIDE_PID: the graceful way to stop a console program, like pressing the keys.
# Exit code 0 sent, 1 couldn't attach (the process is gone or has no console).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PocketIdeCtrl {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);

  public static bool Send(uint pid, uint ctrlEvent) {
    FreeConsole();
    if (!AttachConsole(pid)) return false;
    SetConsoleCtrlHandler(IntPtr.Zero, true); // this script itself ignores it
    return GenerateConsoleCtrlEvent(ctrlEvent, 0);
  }
}
'@
if (-not [PocketIdeCtrl]::Send([uint32]$env:POCKETIDE_PID, [uint32]$env:POCKETIDE_EVENT)) { exit 1 }
