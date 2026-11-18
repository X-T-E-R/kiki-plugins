$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$csharpSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class UuWin32Bridge
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    private const uint INPUT_MOUSE = 0u;
    private const uint INPUT_KEYBOARD = 1u;

    private const uint MOUSEEVENTF_MOVE = 0x0001u;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002u;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004u;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008u;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010u;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020u;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040u;
    private const uint MOUSEEVENTF_WHEEL = 0x0800u;
    private const uint MOUSEEVENTF_HWHEEL = 0x01000u;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000u;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000u;

    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001u;
    private const uint KEYEVENTF_KEYUP = 0x0002u;
    private const uint KEYEVENTF_UNICODE = 0x0004u;

    private const uint SWP_NOZORDER = 0x0004u;
    private const uint SWP_NOACTIVATE = 0x0010u;
    private const uint SWP_SHOWWINDOW = 0x0040u;

    public static void InitDpiAwareness()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4)))
            {
                return;
            }
        }
        catch
        {
        }
        try
        {
            SetProcessDPIAware();
        }
        catch
        {
        }
    }

    private static int ClampInt(int value, int minValue, int maxValue)
    {
        if (value < minValue) return minValue;
        if (value > maxValue) return maxValue;
        return value;
    }

    private static string ReadClassName(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(256);
        int len = GetClassName(hWnd, sb, sb.Capacity);
        return len > 0 ? sb.ToString() : string.Empty;
    }

    private static string ReadWindowTitle(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(512);
        int len = GetWindowText(hWnd, sb, sb.Capacity);
        return len > 0 ? sb.ToString() : string.Empty;
    }

    private static int SafeGetDpi(IntPtr hWnd)
    {
        try
        {
            uint dpi = GetDpiForWindow(hWnd);
            if (dpi > 0u) return (int)dpi;
        }
        catch
        {
        }
        return 96;
    }

    public static Dictionary<string, int> GetOuterRectMap(IntPtr hWnd)
    {
        RECT rc;
        GetWindowRect(hWnd, out rc);
        Dictionary<string, int> map = new Dictionary<string, int>();
        map["x"] = rc.Left;
        map["y"] = rc.Top;
        map["width"] = Math.Max(0, rc.Right - rc.Left);
        map["height"] = Math.Max(0, rc.Bottom - rc.Top);
        return map;
    }

    public static Dictionary<string, int> GetClientScreenRectMap(IntPtr hWnd)
    {
        RECT rc;
        GetClientRect(hWnd, out rc);
        POINT pt = new POINT();
        pt.X = 0;
        pt.Y = 0;
        ClientToScreen(hWnd, ref pt);
        Dictionary<string, int> map = new Dictionary<string, int>();
        map["x"] = pt.X;
        map["y"] = pt.Y;
        map["width"] = Math.Max(0, rc.Right - rc.Left);
        map["height"] = Math.Max(0, rc.Bottom - rc.Top);
        return map;
    }

    public static List<Dictionary<string, object>> GetMonitors()
    {
        List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
        MonitorEnumProc callback = delegate(IntPtr hMon, IntPtr hdc, ref RECT rcMon, IntPtr data)
        {
            MONITORINFOEX info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(hMon, ref info))
            {
                Dictionary<string, int> bounds = new Dictionary<string, int>();
                bounds["x"] = info.rcMonitor.Left;
                bounds["y"] = info.rcMonitor.Top;
                bounds["width"] = info.rcMonitor.Right - info.rcMonitor.Left;
                bounds["height"] = info.rcMonitor.Bottom - info.rcMonitor.Top;

                Dictionary<string, int> work = new Dictionary<string, int>();
                work["x"] = info.rcWork.Left;
                work["y"] = info.rcWork.Top;
                work["width"] = info.rcWork.Right - info.rcWork.Left;
                work["height"] = info.rcWork.Bottom - info.rcWork.Top;

                Dictionary<string, object> entry = new Dictionary<string, object>();
                entry["deviceName"] = info.szDevice != null ? info.szDevice : string.Empty;
                entry["primary"] = (info.dwFlags & 1u) != 0u;
                entry["bounds"] = bounds;
                entry["workArea"] = work;
                list.Add(entry);
            }
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
        return list;
    }

    public static Dictionary<string, int> GetCursorMap()
    {
        POINT pt;
        GetCursorPos(out pt);
        Dictionary<string, int> map = new Dictionary<string, int>();
        map["x"] = pt.X;
        map["y"] = pt.Y;
        return map;
    }

    public static long GetForegroundHwndValue()
    {
        return GetForegroundWindow().ToInt64();
    }

    public static Dictionary<string, int> GetVirtualScreenMap()
    {
        Dictionary<string, int> map = new Dictionary<string, int>();
        map["x"] = GetSystemMetrics(76);
        map["y"] = GetSystemMetrics(77);
        map["width"] = Math.Max(1, GetSystemMetrics(78));
        map["height"] = Math.Max(1, GetSystemMetrics(79));
        return map;
    }

    public static List<Dictionary<string, object>> EnumTargetWindows(int[] targetPids)
    {
        HashSet<int> pidSet = new HashSet<int>();
        if (targetPids != null)
        {
            for (int i = 0; i < targetPids.Length; i++)
            {
                pidSet.Add(targetPids[i]);
            }
        }

        List<Dictionary<string, object>> results = new List<Dictionary<string, object>>();
        if (pidSet.Count == 0)
        {
            return results;
        }

        EnumWindowsProc topProc = delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint winPid = 0u;
            GetWindowThreadProcessId(hWnd, out winPid);
            if (!pidSet.Contains((int)winPid))
            {
                return true;
            }

            bool vis = IsWindowVisible(hWnd);
            bool iconic = IsIconic(hWnd);
            if (!vis && !iconic)
            {
                return true;
            }

            List<Dictionary<string, object>> children = new List<Dictionary<string, object>>();
            EnumWindowsProc childProc = delegate(IntPtr childHwnd, IntPtr childParam)
            {
                Dictionary<string, object> cItem = new Dictionary<string, object>();
                cItem["hwnd"] = childHwnd.ToInt64();
                cItem["className"] = ReadClassName(childHwnd);
                cItem["title"] = ReadWindowTitle(childHwnd);
                cItem["visible"] = IsWindowVisible(childHwnd);
                cItem["bounds"] = GetOuterRectMap(childHwnd);
                cItem["clientBounds"] = GetClientScreenRectMap(childHwnd);
                children.Add(cItem);
                return true;
            };
            EnumChildWindows(hWnd, childProc, IntPtr.Zero);

            Dictionary<string, object> item = new Dictionary<string, object>();
            item["hwnd"] = hWnd.ToInt64();
            item["pid"] = (int)winPid;
            item["className"] = ReadClassName(hWnd);
            item["title"] = ReadWindowTitle(hWnd);
            item["visible"] = vis;
            item["isIconic"] = iconic;
            item["dpi"] = SafeGetDpi(hWnd);
            item["outerBounds"] = GetOuterRectMap(hWnd);
            item["clientBounds"] = GetClientScreenRectMap(hWnd);
            item["children"] = children;
            results.Add(item);
            return true;
        };

        EnumWindows(topProc, IntPtr.Zero);
        return results;
    }

    public static Dictionary<string, object> CaptureWindowStagePng(long hwndTopVal, long stageHwndVal)
    {
        IntPtr hwndTop = new IntPtr(hwndTopVal);
        if (!IsWindow(hwndTop))
        {
            throw new InvalidOperationException("Target session window no longer exists.");
        }
        if (IsIconic(hwndTop))
        {
            throw new InvalidOperationException("Target session window is minimized; restore it before capturing.");
        }

        RECT rcWin;
        if (!GetWindowRect(hwndTop, out rcWin))
        {
            throw new InvalidOperationException("GetWindowRect failed on target window.");
        }
        int winW = rcWin.Right - rcWin.Left;
        int winH = rcWin.Bottom - rcWin.Top;
        if (winW <= 4 || winH <= 4)
        {
            throw new InvalidOperationException("Target window has degenerate dimensions.");
        }

        Dictionary<string, int> stageMap = null;
        if (stageHwndVal != 0L && stageHwndVal != hwndTopVal)
        {
            IntPtr stageHwnd = new IntPtr(stageHwndVal);
            if (IsWindow(stageHwnd))
            {
                stageMap = GetClientScreenRectMap(stageHwnd);
            }
        }
        if (stageMap == null || stageMap["width"] <= 4 || stageMap["height"] <= 4)
        {
            stageMap = GetClientScreenRectMap(hwndTop);
        }

        int cropX = ClampInt(stageMap["x"] - rcWin.Left, 0, winW - 1);
        int cropY = ClampInt(stageMap["y"] - rcWin.Top, 0, winH - 1);
        int cropW = ClampInt(stageMap["width"], 1, winW - cropX);
        int cropH = ClampInt(stageMap["height"], 1, winH - cropY);

        Bitmap fullBmp = null;
        Bitmap stageBmp = null;
        MemoryStream ms = null;
        try
        {
            fullBmp = new Bitmap(winW, winH, PixelFormat.Format32bppRgb);
            Graphics g = Graphics.FromImage(fullBmp);
            IntPtr hdc = IntPtr.Zero;
            try
            {
                hdc = g.GetHdc();
                bool rendered = PrintWindow(hwndTop, hdc, 2u);
                if (!rendered)
                {
                    PrintWindow(hwndTop, hdc, 0u);
                }
            }
            finally
            {
                if (hdc != IntPtr.Zero)
                {
                    g.ReleaseHdc(hdc);
                }
                g.Dispose();
            }

            if (cropX == 0 && cropY == 0 && cropW == winW && cropH == winH)
            {
                ms = new MemoryStream();
                fullBmp.Save(ms, ImageFormat.Png);
            }
            else
            {
                stageBmp = fullBmp.Clone(new Rectangle(cropX, cropY, cropW, cropH), PixelFormat.Format24bppRgb);
                ms = new MemoryStream();
                stageBmp.Save(ms, ImageFormat.Png);
            }

            Dictionary<string, int> finalStage = new Dictionary<string, int>();
            finalStage["x"] = rcWin.Left + cropX;
            finalStage["y"] = rcWin.Top + cropY;
            finalStage["width"] = cropW;
            finalStage["height"] = cropH;

            Dictionary<string, int> outerMap = new Dictionary<string, int>();
            outerMap["x"] = rcWin.Left;
            outerMap["y"] = rcWin.Top;
            outerMap["width"] = winW;
            outerMap["height"] = winH;

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["pngBase64"] = Convert.ToBase64String(ms.ToArray());
            res["stageBounds"] = finalStage;
            res["outerBounds"] = outerMap;
            res["cursor"] = GetCursorMap();
            return res;
        }
        finally
        {
            if (ms != null) ms.Dispose();
            if (stageBmp != null) stageBmp.Dispose();
            if (fullBmp != null) fullBmp.Dispose();
        }
    }

    public static Dictionary<string, int> MoveWindowSafe(long hwndVal, int x, int y, int width, int height)
    {
        IntPtr hWnd = new IntPtr(hwndVal);
        if (!IsWindow(hWnd))
        {
            throw new InvalidOperationException("Window no longer exists.");
        }
        if (IsIconic(hWnd))
        {
            ShowWindow(hWnd, 9);
            Thread.Sleep(50);
        }
        SetWindowPos(hWnd, IntPtr.Zero, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        return GetOuterRectMap(hWnd);
    }

    public static bool FocusWindowReliable(long hwndVal, bool restoreIfIconic)
    {
        IntPtr hWnd = new IntPtr(hwndVal);
        if (!IsWindow(hWnd))
        {
            throw new InvalidOperationException("Target window no longer exists.");
        }
        if (IsIconic(hWnd))
        {
            if (!restoreIfIconic)
            {
                throw new InvalidOperationException("Target window is minimized; pass action=restore first.");
            }
            ShowWindow(hWnd, 9);
            Thread.Sleep(80);
        }

        IntPtr fg = GetForegroundWindow();
        if (fg == hWnd)
        {
            return true;
        }

        uint curThread = GetCurrentThreadId();
        uint fgPid = 0u;
        uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0u;
        bool attached = false;
        try
        {
            if (fgThread != 0u && fgThread != curThread)
            {
                attached = AttachThreadInput(curThread, fgThread, true);
            }
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
        }
        finally
        {
            if (attached)
            {
                AttachThreadInput(curThread, fgThread, false);
            }
        }
        Thread.Sleep(25);
        return GetForegroundWindow() == hWnd;
    }

    private static void ToVirtualDeskCoords(int screenX, int screenY, out int normDx, out int normDy)
    {
        int vx = GetSystemMetrics(76);
        int vy = GetSystemMetrics(77);
        int vw = Math.Max(2, GetSystemMetrics(78));
        int vh = Math.Max(2, GetSystemMetrics(79));
        long denomX = (long)(vw - 1);
        long denomY = (long)(vh - 1);
        long rawDx = ((long)(screenX - vx) * 65535L + (denomX / 2L)) / denomX;
        long rawDy = ((long)(screenY - vy) * 65535L + (denomY / 2L)) / denomY;
        if (rawDx < 0L) rawDx = 0L;
        if (rawDx > 65535L) rawDx = 65535L;
        if (rawDy < 0L) rawDy = 0L;
        if (rawDy > 65535L) rawDy = 65535L;
        normDx = (int)rawDx;
        normDy = (int)rawDy;
    }

    public static void SendMouseMoveAbs(int screenX, int screenY)
    {
        int dx;
        int dy;
        ToVirtualDeskCoords(screenX, screenY, out dx, out dy);
        INPUT[] arr = new INPUT[1];
        arr[0].type = INPUT_MOUSE;
        arr[0].U.mi.dx = dx;
        arr[0].U.mi.dy = dy;
        arr[0].U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_ABSOLUTE;
        SendInput(1u, arr, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void SendMouseButton(string button, bool isUp)
    {
        uint flag = isUp ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_LEFTDOWN;
        if (string.Equals(button, "right", StringComparison.OrdinalIgnoreCase))
        {
            flag = isUp ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_RIGHTDOWN;
        }
        else if (string.Equals(button, "middle", StringComparison.OrdinalIgnoreCase))
        {
            flag = isUp ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_MIDDLEDOWN;
        }
        INPUT[] arr = new INPUT[1];
        arr[0].type = INPUT_MOUSE;
        arr[0].U.mi.dwFlags = flag;
        SendInput(1u, arr, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void SendMouseWheel(int deltaX, int deltaY)
    {
        if (deltaY != 0)
        {
            INPUT[] vArr = new INPUT[1];
            vArr[0].type = INPUT_MOUSE;
            vArr[0].U.mi.dwFlags = MOUSEEVENTF_WHEEL;
            vArr[0].U.mi.mouseData = unchecked((uint)deltaY);
            SendInput(1u, vArr, Marshal.SizeOf(typeof(INPUT)));
        }
        if (deltaX != 0)
        {
            INPUT[] hArr = new INPUT[1];
            hArr[0].type = INPUT_MOUSE;
            hArr[0].U.mi.dwFlags = MOUSEEVENTF_HWHEEL;
            hArr[0].U.mi.mouseData = unchecked((uint)deltaX);
            SendInput(1u, hArr, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    private static bool IsExtendedVirtualKey(int vk)
    {
        return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 ||
               vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 ||
               vk == 0x2d || vk == 0x2e || vk == 0x5b || vk == 0x5c ||
               vk == 0x5d || vk == 0xa3 || vk == 0xa5;
    }

    public static void SendVirtualKey(int vk, bool isUp)
    {
        uint flags = isUp ? KEYEVENTF_KEYUP : 0u;
        if (IsExtendedVirtualKey(vk))
        {
            flags = flags | KEYEVENTF_EXTENDEDKEY;
        }
        ushort scan = (ushort)MapVirtualKey((uint)vk, 0u);
        INPUT[] arr = new INPUT[1];
        arr[0].type = INPUT_KEYBOARD;
        arr[0].U.ki.wVk = (ushort)vk;
        arr[0].U.ki.wScan = scan;
        arr[0].U.ki.dwFlags = flags;
        SendInput(1u, arr, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void SendUnicodeString(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        int cb = Marshal.SizeOf(typeof(INPUT));
        for (int i = 0; i < text.Length; i++)
        {
            ushort ch = (ushort)text[i];
            if (ch == 13) continue;
            if (ch == 10)
            {
                SendVirtualKey(0x0D, false);
                Thread.Sleep(12);
                SendVirtualKey(0x0D, true);
                Thread.Sleep(12);
                continue;
            }
            INPUT[] pair = new INPUT[2];
            pair[0].type = INPUT_KEYBOARD;
            pair[0].U.ki.wVk = 0;
            pair[0].U.ki.wScan = ch;
            pair[0].U.ki.dwFlags = KEYEVENTF_UNICODE;

            pair[1].type = INPUT_KEYBOARD;
            pair[1].U.ki.wVk = 0;
            pair[1].U.ki.wScan = ch;
            pair[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendInput(2u, pair, cb);
            if (text.Length > 8)
            {
                Thread.Sleep(4);
            }
        }
    }
}
'@

Add-Type -TypeDefinition $csharpSource -ReferencedAssemblies @('System.Drawing', 'System.Windows.Forms')
[UuWin32Bridge]::InitDpiAwareness()

function Invoke-BridgeCommand($cmd) {
  $op = [string]$cmd.op
  switch ($op) {
    'ping' {
      return @{ ok = $true; pid = $PID }
    }
    'cursor_pos' {
      return @{
        ok = $true
        cursor = [UuWin32Bridge]::GetCursorMap()
        foregroundHwnd = [UuWin32Bridge]::GetForegroundHwndValue()
      }
    }
    'enum_state' {
      $names = @('GameViewer', 'GameViewerServer', 'GameViewerService', 'GameViewerLauncher')
      if ($null -ne $cmd.processNames -and $cmd.processNames.Count -gt 0) {
        foreach ($extra in $cmd.processNames) {
          if ($extra -and ($names -notcontains [string]$extra)) {
            $names += [string]$extra
          }
        }
      }
      $procs = @(Get-Process -Name $names -ErrorAction SilentlyContinue)
      $procItems = @()
      $uiPids = New-Object System.Collections.Generic.List[int]
      foreach ($p in $procs) {
        $pPath = $null
        try { $pPath = $p.MainModule.FileName } catch {}
        $procItems += @{
          pid = [int]$p.Id
          name = [string]$p.ProcessName
          path = $pPath
        }
        if ($p.ProcessName -notmatch 'Service|Server') {
          [void]$uiPids.Add([int]$p.Id)
        }
      }
      $wins = [UuWin32Bridge]::EnumTargetWindows($uiPids.ToArray())
      return @{
        ok = $true
        monitors = [UuWin32Bridge]::GetMonitors()
        processes = $procItems
        windows = $wins
        cursor = [UuWin32Bridge]::GetCursorMap()
        foregroundHwnd = [UuWin32Bridge]::GetForegroundHwndValue()
        virtualScreen = [UuWin32Bridge]::GetVirtualScreenMap()
      }
    }
    'capture_window' {
      $hwndTop = [int64]$cmd.hwndTop
      $stageHwnd = if ($null -ne $cmd.stageHwnd) { [int64]$cmd.stageHwnd } else { 0L }
      $shot = [UuWin32Bridge]::CaptureWindowStagePng($hwndTop, $stageHwnd)
      $shot['ok'] = $true
      return $shot
    }
    'recover_offscreen' {
      $moved = @()
      foreach ($item in $cmd.targets) {
        $rect = [UuWin32Bridge]::MoveWindowSafe(
          [int64]$item.hwnd,
          [int]$item.x,
          [int]$item.y,
          [int]$item.width,
          [int]$item.height
        )
        $moved += @{
          hwnd = [int64]$item.hwnd
          outerBounds = $rect
        }
      }
      return @{ ok = $true; moved = $moved }
    }
    'window_action' {
      $hwnd = [int64]$cmd.hwnd
      $mode = [string]$cmd.mode
      $restore = ($mode -eq 'restore')
      $focused = [UuWin32Bridge]::FocusWindowReliable($hwnd, $restore)
      return @{
        ok = $true
        focused = $focused
        outerBounds = [UuWin32Bridge]::GetOuterRectMap([IntPtr]::new($hwnd))
        clientBounds = [UuWin32Bridge]::GetClientScreenRectMap([IntPtr]::new($hwnd))
      }
    }
    'clipboard_get' {
      $txt = ''
      if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        $txt = [System.Windows.Forms.Clipboard]::GetText()
      }
      return @{ ok = $true; text = [string]$txt }
    }
    'clipboard_set' {
      $val = [string]$cmd.text
      if ([string]::IsNullOrEmpty($val)) {
        [System.Windows.Forms.Clipboard]::Clear()
      } else {
        [System.Windows.Forms.Clipboard]::SetText($val)
      }
      return @{ ok = $true; length = $val.Length }
    }
    'send_batch' {
      $hwndTop = [int64]$cmd.hwndTop
      $restorePrev = [bool]$cmd.restorePreviousFocus
      $prevFg = [UuWin32Bridge]::GetForegroundHwndValue()
      [void][UuWin32Bridge]::FocusWindowReliable($hwndTop, $false)

      $hadMouseUp = $false
      foreach ($step in $cmd.steps) {
        $sk = [string]$step.op
        switch ($sk) {
          'mouse_move' {
            [UuWin32Bridge]::SendMouseMoveAbs([int]$step.x, [int]$step.y)
          }
          'mouse_down' {
            [UuWin32Bridge]::SendMouseButton([string]$step.button, $false)
          }
          'mouse_up' {
            [UuWin32Bridge]::SendMouseButton([string]$step.button, $true)
            $hadMouseUp = $true
          }
          'wheel' {
            [UuWin32Bridge]::SendMouseWheel([int]$step.deltaX, [int]$step.deltaY)
          }
          'vk_down' {
            [UuWin32Bridge]::SendVirtualKey([int]$step.vk, $false)
          }
          'vk_up' {
            [UuWin32Bridge]::SendVirtualKey([int]$step.vk, $true)
          }
          'unicode_text' {
            [UuWin32Bridge]::SendUnicodeString([string]$step.text)
          }
          'clipboard_paste' {
            [System.Windows.Forms.Clipboard]::SetText([string]$step.text)
            [System.Threading.Thread]::Sleep(18)
            [UuWin32Bridge]::SendVirtualKey(0x11, $false)
            [UuWin32Bridge]::SendVirtualKey(0x56, $false)
            [System.Threading.Thread]::Sleep(20)
            [UuWin32Bridge]::SendVirtualKey(0x56, $true)
            [UuWin32Bridge]::SendVirtualKey(0x11, $true)
          }
          'sleep' {
            $ms = [Math]::Max(1, [Math]::Min(10000, [int]$step.ms))
            [System.Threading.Thread]::Sleep($ms)
          }
        }
      }

      if ($hadMouseUp) {
        [System.Threading.Thread]::Sleep(65)
      }

      if ($restorePrev -and $prevFg -ne 0L -and $prevFg -ne $hwndTop) {
        try {
          [void][UuWin32Bridge]::FocusWindowReliable($prevFg, $false)
        } catch {}
      }

      return @{
        ok = $true
        cursor = [UuWin32Bridge]::GetCursorMap()
        foregroundHwnd = [UuWin32Bridge]::GetForegroundHwndValue()
      }
    }
    default {
      throw ("Unsupported bridge op: " + $op)
    }
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $trimmed = $line.Trim()
  if ([string]::IsNullOrEmpty($trimmed)) { continue }
  $reqId = $null
  try {
    $payload = $trimmed | ConvertFrom-Json
    $reqId = $payload.id
    $res = Invoke-BridgeCommand $payload
    $envelope = @{ id = $reqId; ok = $true; result = $res }
    [Console]::Out.WriteLine(($envelope | ConvertTo-Json -Compress -Depth 12))
    [Console]::Out.Flush()
  } catch {
    $errEnvelope = @{
      id = $reqId
      ok = $false
      error = $_.Exception.Message
    }
    [Console]::Out.WriteLine(($errEnvelope | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
  }
}
