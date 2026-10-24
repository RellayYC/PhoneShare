# Win32 and UI Automation probes for dev/desktop-e2e.mjs. Prints one JSON line.
#   probe            title, window rect, visible frame, monitor, DPI, WS_EX_TOPMOST, colour of a title-bar pixel
#   place X Y W H    move and size the window (physical pixels)
#   topmost On       pin (1) or unpin (0) the window, test-side only
#   close            ask the window to close (WM_CLOSE), like the X button
#   names            every UI Automation name inside the window
#   shot Path        PNG of the visible window, title bar included (for design review)
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$Action, [int]$X, [int]$Y, [int]$W, [int]$H, [int]$On, [string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor, Work; public int Flags; }
    [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, int flags);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out RECT r, int size);
    public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    public static void Shot(RECT f, string path) {
        using (var b = new Bitmap(f.R - f.L, f.B - f.T)) using (var g = Graphics.FromImage(b)) {
            g.CopyFromScreen(f.L, f.T, 0, 0, b.Size);
            b.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
    }
    public static string Pixel(int x, int y) {
        using (var b = new Bitmap(1, 1)) using (var g = Graphics.FromImage(b)) {
            g.CopyFromScreen(x, y, 0, 0, new Size(1, 1));
            Color c = b.GetPixel(0, 0);
            return string.Format("#{0:x2}{1:x2}{2:x2}", c.R, c.G, c.B);
        }
    }
}
'@
[void][Win]::SetProcessDpiAwarenessContext([IntPtr]-4)   # per-monitor v2: coordinates in physical pixels

# $hwnd, not $h: PowerShell names are case-insensitive and $H is the height parameter
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $hwnd -eq [IntPtr]::Zero; $i++) {
    $hwnd = (Get-Process -Id $ProcessId).MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
if ($hwnd -eq [IntPtr]::Zero) { throw "process $ProcessId has no window" }
function Rect($r) { @{ l = $r.L; t = $r.T; r = $r.R; b = $r.B } }

switch ($Action) {
    'probe' {
        $r = New-Object Win+RECT; [void][Win]::GetWindowRect($hwnd, [ref]$r)
        $f = New-Object Win+RECT; [void][Win]::DwmGetWindowAttribute($hwnd, 9, [ref]$f, 16)   # DWMWA_EXTENDED_FRAME_BOUNDS
        $mi = New-Object Win+MONITORINFO; $mi.Size = 40
        [void][Win]::GetMonitorInfo([Win]::MonitorFromWindow($hwnd, 2), [ref]$mi)
        $dpi = [Win]::GetDpiForWindow($hwnd)
        $px = [int](($f.L + $f.R) / 2); $py = $f.T + [int](12 * $dpi / 96)   # middle of the title bar, clear of title text and buttons
        @{
            title = [Win]::Title($hwnd); rect = Rect $r; frame = Rect $f; monitor = Rect $mi.Monitor; dpi = $dpi
            topmost = ([Win]::GetWindowLong($hwnd, -20) -band 8) -ne 0
            minimized = [Win]::IsIconic($hwnd)
            caption = [Win]::Pixel($px, $py)
        } | ConvertTo-Json -Compress
    }
    'place' { [void][Win]::SetWindowPos($hwnd, [IntPtr]::Zero, $X, $Y, $W, $H, 0x14); '{"ok":true}' }
    'topmost' { [void][Win]::SetWindowPos($hwnd, [IntPtr]$(if ($On) { -1 } else { -2 }), 0, 0, 0, 0, 0x13); '{"ok":true}' }
    'close' { [void][Win]::PostMessage($hwnd, 0x10, [IntPtr]::Zero, [IntPtr]::Zero); '{"ok":true}' }
    'names' {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $all = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        $names = @($all | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
        ConvertTo-Json -Compress -InputObject @{ names = $names }
    }
    'shot' {
        $f = New-Object Win+RECT; [void][Win]::DwmGetWindowAttribute($hwnd, 9, [ref]$f, 16)
        [Win]::Shot($f, $Path); '{"ok":true}'
    }
    default { throw "unknown action $Action" }
}
