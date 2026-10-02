param(
    [ValidateSet('Observe', 'Close', 'Check')][string]$Action = 'Observe',
    [string]$OutputDirectory,
    [int]$QaProcessId = 0
)
$ErrorActionPreference = 'Stop'
# Observe only windows owned by the PID written by the companion launcher.
# No TerminateProcess/Stop-Process, global input, or user-profile writes.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class StartupNativeQa {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long time);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
    static double Now() { long time; GetSystemTimePreciseAsFileTime(out time); return (time - 116444736000000000L) / 10000.0; }
    static string Number(double value) { return value.ToString("F3", CultureInfo.InvariantCulture); }
    static List<IntPtr> Windows(int pid) {
        var windows = new List<IntPtr>();
        EnumWindows((hwnd, _) => { uint owner; GetWindowThreadProcessId(hwnd, out owner);
            if (owner == pid) windows.Add(hwnd); return true; }, IntPtr.Zero);
        return windows;
    }
    public static void Observe(string directory) {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        File.WriteAllText(Path.Combine(directory, "observer-ready.txt"), Number(Now()));
        var pidFile = Path.Combine(directory, "pid.txt");
        var stopFile = Path.Combine(directory, "stop-observer.txt");
        var deadline = Stopwatch.StartNew();
        while (!File.Exists(pidFile)) {
            if (File.Exists(stopFile) || deadline.ElapsedMilliseconds > 30000) return;
            Thread.Sleep(2);
        }
        int pid = Int32.Parse(File.ReadAllText(pidFile).Trim()); // Launcher publishes this file with an atomic rename.
        var process = Process.GetProcessById(pid);
        if (!process.ProcessName.Equals("boshu", StringComparison.OrdinalIgnoreCase)) throw new Exception("Refusing another process");
        timeBeginPeriod(1);
        try {
            using (var output = new StreamWriter(Path.Combine(directory, "native.jsonl"), false)) {
                deadline.Restart();
                while (!File.Exists(stopFile) && !process.HasExited && deadline.ElapsedMilliseconds < 30000) {
                    var items = new List<string>();
                    var at = Now();
                    foreach (var hwnd in Windows(pid)) {
                        Rect rect, client; GetWindowRect(hwnd, out rect); GetClientRect(hwnd, out client);
                        if (rect.Right - rect.Left < 500 || rect.Bottom - rect.Top < 300) continue;
                        items.Add("{\"handle\":\"" + hwnd.ToInt64() + "\",\"visible\":" + (IsWindowVisible(hwnd) ? "true" : "false") +
                            ",\"maximized\":" + (IsZoomed(hwnd) ? "true" : "false") + ",\"dpi\":" + GetDpiForWindow(hwnd) +
                            ",\"x\":" + rect.Left + ",\"y\":" + rect.Top + ",\"width\":" + (rect.Right - rect.Left) +
                            ",\"height\":" + (rect.Bottom - rect.Top) + ",\"clientWidth\":" + client.Right + ",\"clientHeight\":" + client.Bottom + "}");
                    }
                    output.WriteLine("{\"at\":" + Number(at) + ",\"windows\":[" + String.Join(",", items) + "]}");
                    output.Flush();
                    Thread.Sleep(5);
                }
            }
        } finally { timeEndPeriod(1); }
    }
    public static void Close(int pid) {
        var process = Process.GetProcessById(pid);
        if (!process.ProcessName.Equals("boshu", StringComparison.OrdinalIgnoreCase)) throw new Exception("Refusing another process");
        foreach (var hwnd in Windows(pid)) PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
}
'@
if ($Action -eq 'Check') { Write-Output 'Native observer compiled'; exit }
if (-not $OutputDirectory) { throw 'OutputDirectory is required.' }
$qaDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$qaWorkspace = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if (-not $qaDirectory.StartsWith((Join-Path $qaWorkspace 'artifacts') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Observer output must be under the workspace artifacts directory.'
}
if ($Action -eq 'Observe') { [StartupNativeQa]::Observe($qaDirectory); exit }
$qaRecordedPid = [int](Get-Content -LiteralPath (Join-Path $qaDirectory 'pid.txt'))
if ($QaProcessId -ne $qaRecordedPid) { throw 'Refusing to close a PID not created by this QA run.' }
[StartupNativeQa]::Close($QaProcessId)
