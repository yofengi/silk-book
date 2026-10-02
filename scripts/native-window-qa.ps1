param(
    [ValidateSet('List', 'Resize', 'Raise', 'Drag', 'Maximize', 'Restore', 'Minimize')][string]$Action = 'List',
    [Parameter(Mandatory=$true)][int]$QaProcessId,
    [long]$WindowHandle = 0,
    [int]$X = 0, [int]$Y = 0, [int]$Width = 0, [int]$Height = 0,
    [int]$ToX = 0, [int]$ToY = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FeedbackNativeQa {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr param);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flag);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    public static long[] Windows(int process) {
        var result = new List<long>();
        EnumWindows((hwnd, _) => { uint owner; GetWindowThreadProcessId(hwnd, out owner);
            if (owner == process && IsWindowVisible(hwnd)) result.Add(hwnd.ToInt64()); return true; }, IntPtr.Zero);
        return result.ToArray();
    }
    public static int Owner(long hwnd) { uint process; GetWindowThreadProcessId(new IntPtr(hwnd), out process); return (int)process; }
}
'@
[FeedbackNativeQa]::SetProcessDPIAware() | Out-Null
$qaProcess = Get-Process -Id $QaProcessId
if ($qaProcess.ProcessName -ne 'boshu') { throw 'Target must be the isolated Boshu test process.' }
if ($Action -eq 'List') {
    $qaWindows = @([FeedbackNativeQa]::Windows($QaProcessId) | ForEach-Object {
        $qaRect = New-Object FeedbackNativeQa+Rect
        [FeedbackNativeQa]::GetWindowRect([IntPtr]$_, [ref]$qaRect) | Out-Null
        [pscustomobject]@{ handle=$_; x=$qaRect.Left; y=$qaRect.Top; width=$qaRect.Right-$qaRect.Left; height=$qaRect.Bottom-$qaRect.Top }
    })
    ConvertTo-Json -InputObject $qaWindows -Compress
    exit
}
if ([FeedbackNativeQa]::Owner($WindowHandle) -ne $QaProcessId) { throw 'Window does not belong to the isolated test process.' }
$qaHandle = [IntPtr]$WindowHandle
switch ($Action) {
    'Raise' { [FeedbackNativeQa]::SetWindowPos($qaHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0053) | Out-Null }
    'Resize' {
        [FeedbackNativeQa]::ShowWindow($qaHandle, 9) | Out-Null
        if (-not [FeedbackNativeQa]::SetWindowPos($qaHandle, [IntPtr]::Zero, $X, $Y, $Width, $Height, 0x0040)) { throw 'SetWindowPos failed.' }
    }
    'Maximize' { [FeedbackNativeQa]::ShowWindow($qaHandle, 3) | Out-Null }
    'Restore' { [FeedbackNativeQa]::ShowWindow($qaHandle, 9) | Out-Null }
    'Minimize' { [FeedbackNativeQa]::ShowWindow($qaHandle, 6) | Out-Null }
    'Drag' {
        $qaCursor = New-Object FeedbackNativeQa+Point
        [FeedbackNativeQa]::GetCursorPos([ref]$qaCursor) | Out-Null
        try {
            $qaForeground = [FeedbackNativeQa]::SetForegroundWindow($qaHandle)
            Start-Sleep -Milliseconds 180
            $qaMoved = [FeedbackNativeQa]::SetCursorPos($X, $Y)
            $qaActual = New-Object FeedbackNativeQa+Point
            [FeedbackNativeQa]::GetCursorPos([ref]$qaActual) | Out-Null
            $qaHit = [FeedbackNativeQa]::GetAncestor([FeedbackNativeQa]::WindowFromPoint($qaActual), 2)
            [pscustomobject]@{ foreground=$qaForeground; cursorMoved=$qaMoved; x=$qaActual.X; y=$qaActual.Y; hit=$qaHit.ToInt64(); expected=$WindowHandle } | ConvertTo-Json -Compress | Write-Output
            if (-not $qaMoved -or $qaHit.ToInt64() -ne $WindowHandle) { throw 'Mouse start point is not on the isolated source window; no click sent.' }
            [FeedbackNativeQa]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 120
            for ($qaStep=1; $qaStep -le 24; $qaStep++) {
                [FeedbackNativeQa]::SetCursorPos([int]($X+($ToX-$X)*$qaStep/24), [int]($Y+($ToY-$Y)*$qaStep/24)) | Out-Null
                Start-Sleep -Milliseconds 30
            }
            Start-Sleep -Milliseconds 250
            [FeedbackNativeQa]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        } finally {
            [FeedbackNativeQa]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
            [FeedbackNativeQa]::SetCursorPos($qaCursor.X, $qaCursor.Y) | Out-Null
        }
    }
}
