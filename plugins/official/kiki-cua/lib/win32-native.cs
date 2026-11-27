using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Web.Script.Serialization;

namespace KikiCua
{
    public static class NativeBridge
    {
        private static bool _initialized = false;
        private static bool _selfElevated = false;
        private static Font _overlayFont = null;
        private static Bitmap _reuseSrcBmp = null;
        private static Bitmap _reuseOutBmp = null;
        private static readonly MemoryStream _reusePngStream = new MemoryStream(512 * 1024);
        private static ImageCodecInfo _jpegCodec = null;
        private static bool _jpegCodecResolved = false;
        private static readonly IntPtr EXTRA_MAGIC = new IntPtr(0x4B494B49);
        private static readonly HashSet<ushort> _heldKeys = new HashSet<ushort>();
        private static uint _heldMouseButtons = 0;

        private const int SM_XVIRTUALSCREEN = 76;
        private const int SM_YVIRTUALSCREEN = 77;
        private const int SM_CXVIRTUALSCREEN = 78;
        private const int SM_CYVIRTUALSCREEN = 79;

        private const uint INPUT_MOUSE = 0;
        private const uint INPUT_KEYBOARD = 1;

        private const uint MOUSEEVENTF_MOVE = 0x0001;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        private const uint MOUSEEVENTF_WHEEL = 0x0800;
        private const uint MOUSEEVENTF_HWHEEL = 0x1000;
        private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;

        private const uint CF_UNICODETEXT = 13;
        private const uint GMEM_MOVEABLE = 0x0002;
        private const uint GMEM_ZEROINIT = 0x0040;

        private const int SW_RESTORE = 9;
        private const int SW_SHOW = 5;
        private const uint GA_ROOT = 2;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint TOKEN_QUERY = 0x0008;
        private const int TokenElevationClass = 20;
        private const int DWMWA_CLOAKED = 14;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct MONITORINFOEX
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szDevice;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;
            [FieldOffset(0)]
            public KEYBDINPUT ki;
            [FieldOffset(0)]
            public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public InputUnion u;
        }

        private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int awareness);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll")]
        private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

        [DllImport("shcore.dll")]
        private static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(POINT Point);

        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        private static extern int SetStretchBltMode(IntPtr hdc, int iStretchMode);

        [DllImport("gdi32.dll")]
        private static extern bool SetBrushOrgEx(IntPtr hdc, int nXOrg, int nYOrg, IntPtr lppt);

        [DllImport("gdi32.dll")]
        private static extern bool StretchBlt(IntPtr hdcDest, int nXOriginDest, int nYOriginDest, int nWidthDest, int nHeightDest, IntPtr hdcSrc, int nXOriginSrc, int nYOriginSrc, int nWidthSrc, int nHeightSrc, uint dwRop);

        [DllImport("user32.dll")]
        private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref int lpdwSize);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, out int TokenInformation, int TokenInformationLength, out int ReturnLength);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool OpenClipboard(IntPtr hWndNewOwner);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool CloseClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool EmptyClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetClipboardData(uint uFormat);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint RegisterClipboardFormat(string lpszFormat);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GlobalLock(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GlobalUnlock(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GlobalFree(IntPtr hMem);

        public static void EnsureInitialized()
        {
            if (_initialized) return;
            _initialized = true;
            try
            {
                if (!SetProcessDpiAwarenessContext(new IntPtr(-4)))
                {
                    try { SetProcessDpiAwareness(2); }
                    catch { SetProcessDPIAware(); }
                }
            }
            catch
            {
                try { SetProcessDpiAwareness(2); }
                catch { try { SetProcessDPIAware(); } catch { } }
            }
            _selfElevated = QueryProcessElevated(GetCurrentProcess(), false);
            try
            {
                _overlayFont = new Font(FontFamily.GenericMonospace, 8.5f, FontStyle.Bold);
            }
            catch { }
        }

        private static bool QueryProcessElevated(IntPtr hProcess, bool closeProcess)
        {
            IntPtr hToken = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(hProcess, TOKEN_QUERY, out hToken) || hToken == IntPtr.Zero)
                {
                    int err = Marshal.GetLastWin32Error();
                    return err == 5;
                }
                int elevation = 0;
                int retLen = 0;
                if (GetTokenInformation(hToken, TokenElevationClass, out elevation, sizeof(int), out retLen))
                {
                    return elevation != 0;
                }
                return false;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (hToken != IntPtr.Zero) CloseHandle(hToken);
                if (closeProcess && hProcess != IntPtr.Zero) CloseHandle(hProcess);
            }
        }

        public static bool IsHwndElevated(IntPtr hwnd, out uint pid, out string procName)
        {
            pid = 0;
            procName = "";
            if (hwnd == IntPtr.Zero) return false;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0) return false;

            IntPtr hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (hProc == IntPtr.Zero)
            {
                int err = Marshal.GetLastWin32Error();
                return err == 5;
            }
            StringBuilder exeSb = new StringBuilder(512);
            int cap = exeSb.Capacity;
            if (QueryFullProcessImageName(hProc, 0u, exeSb, ref cap) && cap > 0)
            {
                procName = Path.GetFileNameWithoutExtension(exeSb.ToString(0, cap));
            }
            return QueryProcessElevated(hProc, true);
        }

        public static Dictionary<string, object> CheckUipiForWindow(IntPtr hwnd)
        {
            EnsureInitialized();
            if (hwnd == IntPtr.Zero || _selfElevated) return null;
            IntPtr root = GetAncestor(hwnd, GA_ROOT);
            if (root != IntPtr.Zero) hwnd = root;
            uint pid;
            string procName;
            if (!IsHwndElevated(hwnd, out pid, out procName)) return null;

            Dictionary<string, object> info = new Dictionary<string, object>();
            info["blocked"] = true;
            info["code"] = "uipi_elevated_window";
            info["hwnd"] = FormatHwnd(hwnd);
            info["pid"] = (int)pid;
            info["processName"] = procName;
            info["title"] = ReadWindowTitle(hwnd);
            info["message"] = string.Format(
                "Target window '{0}' ({1}, PID {2}) is running elevated while Kiki is running at standard integrity (Windows UIPI).",
                ReadWindowTitle(hwnd), procName, pid);
            return info;
        }

        public static Dictionary<string, object> CheckUipiAtPoint(int screenX, int screenY)
        {
            EnsureInitialized();
            if (_selfElevated) return null;
            POINT pt;
            pt.X = screenX;
            pt.Y = screenY;
            IntPtr hwnd = WindowFromPoint(pt);
            return CheckUipiForWindow(hwnd);
        }

        private static string FormatHwnd(IntPtr hwnd)
        {
            return string.Format("0x{0:X}", hwnd.ToInt64());
        }

        public static IntPtr ParseHwnd(string text)
        {
            if (string.IsNullOrEmpty(text)) return IntPtr.Zero;
            string clean = text.Trim();
            if (clean.StartsWith("local:window:", StringComparison.OrdinalIgnoreCase))
            {
                clean = clean.Substring("local:window:".Length).Trim();
            }
            long val = 0;
            if (clean.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                if (long.TryParse(clean.Substring(2), System.Globalization.NumberStyles.HexNumber, null, out val))
                {
                    return new IntPtr(val);
                }
            }
            if (long.TryParse(clean, out val))
            {
                return new IntPtr(val);
            }
            return IntPtr.Zero;
        }

        private static string ReadWindowTitle(IntPtr hwnd)
        {
            int len = GetWindowTextLength(hwnd);
            if (len <= 0) return "";
            StringBuilder sb = new StringBuilder(len + 2);
            GetWindowText(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        private static string ReadWindowClass(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        public static Dictionary<string, object> GetVirtualScreenInfo()
        {
            EnsureInitialized();
            Dictionary<string, object> vs = new Dictionary<string, object>();
            vs["x"] = GetSystemMetrics(SM_XVIRTUALSCREEN);
            vs["y"] = GetSystemMetrics(SM_YVIRTUALSCREEN);
            vs["width"] = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
            vs["height"] = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
            return vs;
        }

        public static Dictionary<string, object> GetCursorPosition()
        {
            EnsureInitialized();
            POINT pt;
            if (!GetCursorPos(out pt))
            {
                pt.X = 0;
                pt.Y = 0;
            }
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["x"] = pt.X;
            res["y"] = pt.Y;
            return res;
        }

        public static Dictionary<string, object> ListMonitors()
        {
            EnsureInitialized();
            List<Dictionary<string, object>> rawList = new List<Dictionary<string, object>>();

            MonitorEnumProc callback = delegate(IntPtr hMon, IntPtr hdc, ref RECT lprc, IntPtr data)
            {
                MONITORINFOEX mi = new MONITORINFOEX();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                if (!GetMonitorInfo(hMon, ref mi)) return true;

                uint dpiX = 96;
                uint dpiY = 96;
                try { GetDpiForMonitor(hMon, 0, out dpiX, out dpiY); } catch { }
                if (dpiX == 0) dpiX = 96;
                if (dpiY == 0) dpiY = 96;

                int x = mi.rcMonitor.Left;
                int y = mi.rcMonitor.Top;
                int w = Math.Max(1, mi.rcMonitor.Right - mi.rcMonitor.Left);
                int h = Math.Max(1, mi.rcMonitor.Bottom - mi.rcMonitor.Top);
                bool isPrimary = (mi.dwFlags & 1u) != 0;

                Dictionary<string, object> bounds = new Dictionary<string, object>();
                bounds["x"] = x;
                bounds["y"] = y;
                bounds["width"] = w;
                bounds["height"] = h;

                Dictionary<string, object> work = new Dictionary<string, object>();
                work["x"] = mi.rcWork.Left;
                work["y"] = mi.rcWork.Top;
                work["width"] = Math.Max(1, mi.rcWork.Right - mi.rcWork.Left);
                work["height"] = Math.Max(1, mi.rcWork.Bottom - mi.rcWork.Top);

                Dictionary<string, object> item = new Dictionary<string, object>();
                item["deviceName"] = mi.szDevice != null ? mi.szDevice.TrimEnd('\0') : "";
                item["primary"] = isPrimary;
                item["bounds"] = bounds;
                item["workArea"] = work;
                item["dpiX"] = (int)dpiX;
                item["dpiY"] = (int)dpiY;
                item["scaleFactor"] = Math.Round((double)dpiX / 96.0, 2);
                rawList.Add(item);
                return true;
            };

            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);

            rawList.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b)
            {
                bool pa = (bool)a["primary"];
                bool pb = (bool)b["primary"];
                if (pa != pb) return pa ? -1 : 1;
                Dictionary<string, object> ba = (Dictionary<string, object>)a["bounds"];
                Dictionary<string, object> bb = (Dictionary<string, object>)b["bounds"];
                int cx = ((int)ba["x"]).CompareTo((int)bb["x"]);
                if (cx != 0) return cx;
                return ((int)ba["y"]).CompareTo((int)bb["y"]);
            });

            for (int i = 0; i < rawList.Count; i++)
            {
                rawList[i]["index"] = i;
                rawList[i]["id"] = string.Format("local:monitor-{0}", i);
            }

            Dictionary<string, object> output = new Dictionary<string, object>();
            output["monitors"] = rawList;
            output["virtualScreen"] = GetVirtualScreenInfo();
            output["cursor"] = GetCursorPosition();
            output["selfElevated"] = _selfElevated;
            return output;
        }

        public static Dictionary<string, object> GetWindowSummary(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return null;
            RECT rc;
            if (!GetWindowRect(hwnd, out rc)) return null;

            uint pid = 0;
            string procName = "";
            bool elevated = IsHwndElevated(hwnd, out pid, out procName);

            uint dpi = 96;
            try { dpi = GetDpiForWindow(hwnd); } catch { }
            if (dpi == 0) dpi = 96;

            Dictionary<string, object> bounds = new Dictionary<string, object>();
            bounds["x"] = rc.Left;
            bounds["y"] = rc.Top;
            bounds["width"] = Math.Max(0, rc.Right - rc.Left);
            bounds["height"] = Math.Max(0, rc.Bottom - rc.Top);

            Dictionary<string, object> win = new Dictionary<string, object>();
            win["hwnd"] = FormatHwnd(hwnd);
            win["windowId"] = FormatHwnd(hwnd);
            win["title"] = ReadWindowTitle(hwnd);
            win["className"] = ReadWindowClass(hwnd);
            win["processId"] = (int)pid;
            win["processName"] = procName;
            win["bounds"] = bounds;
            win["dpi"] = (int)dpi;
            win["scaleFactor"] = Math.Round((double)dpi / 96.0, 2);
            win["isMinimized"] = IsIconic(hwnd);
            win["isMaximized"] = IsZoomed(hwnd);
            win["isForeground"] = (hwnd == GetForegroundWindow());
            win["isElevated"] = elevated;
            return win;
        }

        public static List<Dictionary<string, object>> ListWindows(string query)
        {
            EnsureInitialized();
            IntPtr fg = GetForegroundWindow();
            string q = query != null ? query.Trim().ToLowerInvariant() : "";
            List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();

            EnumWindowsProc cb = delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                int cloaked = 0;
                try
                {
                    if (DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0)
                    {
                        return true;
                    }
                }
                catch { }

                string title = ReadWindowTitle(hWnd);
                if (string.IsNullOrWhiteSpace(title)) return true;
                string cls = ReadWindowClass(hWnd);
                if (cls == "Progman" || cls == "WorkerW") return true;

                RECT rc;
                if (!GetWindowRect(hWnd, out rc)) return true;
                int w = rc.Right - rc.Left;
                int h = rc.Bottom - rc.Top;
                if (!IsIconic(hWnd) && (w < 16 || h < 16)) return true;

                Dictionary<string, object> info = GetWindowSummary(hWnd);
                if (info == null) return true;
                info["isForeground"] = (hWnd == fg);

                if (q.Length > 0)
                {
                    string tLow = ((string)info["title"]).ToLowerInvariant();
                    string pLow = ((string)info["processName"]).ToLowerInvariant();
                    if (!tLow.Contains(q) && !pLow.Contains(q)) return true;
                }

                list.Add(info);
                return list.Count < 160;
            };

            EnumWindows(cb, IntPtr.Zero);
            return list;
        }

        public static Dictionary<string, object> FocusOrRestoreWindow(string hwndStr, bool focus)
        {
            EnsureInitialized();
            IntPtr hwnd = ParseHwnd(hwndStr);
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            {
                throw new ArgumentException("Window handle not found: " + hwndStr);
            }
            if (IsIconic(hwnd) || !focus)
            {
                ShowWindow(hwnd, SW_RESTORE);
            }
            else
            {
                ShowWindow(hwnd, SW_SHOW);
            }
            if (focus)
            {
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
            }
            Thread.Sleep(40);
            Dictionary<string, object> summary = GetWindowSummary(hwnd);
            Dictionary<string, object> uipi = CheckUipiForWindow(hwnd);
            if (uipi != null && summary != null)
            {
                summary["uipiWarning"] = uipi["message"];
            }
            return summary;
        }

        private static void CollectInteractiveNodesFromHwnd(IntPtr hwnd, Condition cond, int originX, int originY, int targetW, int targetH, int maxItems, List<Dictionary<string, object>> items)
        {
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || items.Count >= maxItems) return;
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            if (root == null) return;
            AutomationElementCollection found = root.FindAll(TreeScope.Descendants, cond);
            if (found == null) return;

            int count = found.Count;
            for (int i = 0; i < count && items.Count < maxItems; i++)
            {
                try
                {
                    AutomationElement el = found[i];
                    AutomationElement.AutomationElementInformation cur = el.Current;
                    if (cur.IsOffscreen || !cur.IsEnabled) continue;
                    System.Windows.Rect r = cur.BoundingRectangle;
                    if (r.IsEmpty || double.IsInfinity(r.Width) || double.IsInfinity(r.Height) || r.Width < 3 || r.Height < 3) continue;

                    int relX = (int)Math.Round(r.Left) - originX;
                    int relY = (int)Math.Round(r.Top) - originY;
                    int rw = (int)Math.Round(r.Width);
                    int rh = (int)Math.Round(r.Height);

                    if (relX + rw <= 0 || relY + rh <= 0 || relX >= targetW || relY >= targetH) continue;

                    int seq = items.Count + 1;
                    string role = cur.ControlType != null ? cur.ControlType.ProgrammaticName : "ControlType.Custom";
                    if (role.StartsWith("ControlType.", StringComparison.Ordinal))
                    {
                        role = role.Substring("ControlType.".Length);
                    }

                    int cx = Math.Max(0, Math.Min(targetW - 1, relX + rw / 2));
                    int cy = Math.Max(0, Math.Min(targetH - 1, relY + rh / 2));
                    int normX = targetW <= 1 ? 0 : (int)Math.Round((cx * 1000.0) / (targetW - 1));
                    int normY = targetH <= 1 ? 0 : (int)Math.Round((cy * 1000.0) / (targetH - 1));

                    Dictionary<string, object> b = new Dictionary<string, object>();
                    b["x"] = relX;
                    b["y"] = relY;
                    b["width"] = rw;
                    b["height"] = rh;

                    Dictionary<string, object> centerNorm = new Dictionary<string, object>();
                    centerNorm["x"] = normX;
                    centerNorm["y"] = normY;

                    Dictionary<string, object> node = new Dictionary<string, object>();
                    node["somId"] = seq;
                    node["role"] = role;
                    node["name"] = cur.Name != null ? cur.Name : "";
                    node["automationId"] = cur.AutomationId != null ? cur.AutomationId : "";
                    node["bounds"] = b;
                    node["centerNorm1000"] = centerNorm;
                    items.Add(node);
                }
                catch { }
            }
        }

        private static List<Dictionary<string, object>> QueryAccessibilityCore(IntPtr targetHwnd, int originX, int originY, int targetW, int targetH)
        {
            List<Dictionary<string, object>> items = new List<Dictionary<string, object>>();
            Condition interactiveCond = new OrCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.CheckBox),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ComboBox),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Hyperlink),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.RadioButton),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Slider),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TreeItem),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.DataItem)
            );

            int maxItems = 120;
            IntPtr primaryHwnd = targetHwnd != IntPtr.Zero ? targetHwnd : GetForegroundWindow();
            CollectInteractiveNodesFromHwnd(primaryHwnd, interactiveCond, originX, originY, targetW, targetH, maxItems, items);

            if (targetHwnd == IntPtr.Zero && items.Count < maxItems)
            {
                IntPtr trayHwnd = FindWindow("Shell_TrayWnd", null);
                if (trayHwnd != IntPtr.Zero && trayHwnd != primaryHwnd)
                {
                    CollectInteractiveNodesFromHwnd(trayHwnd, interactiveCond, originX, originY, targetW, targetH, maxItems, items);
                }
            }
            return items;
        }

        public static List<Dictionary<string, object>> QueryAccessibilityBounded(IntPtr targetHwnd, int originX, int originY, int targetW, int targetH, int timeoutMs)
        {
            int limitMs = timeoutMs > 0 ? timeoutMs : 750;
            try
            {
                Task<List<Dictionary<string, object>>> task = Task<List<Dictionary<string, object>>>.Factory.StartNew(
                    delegate() { return QueryAccessibilityCore(targetHwnd, originX, originY, targetW, targetH); }
                );
                if (task.Wait(limitMs))
                {
                    return task.Result;
                }
                return new List<Dictionary<string, object>>();
            }
            catch
            {
                return new List<Dictionary<string, object>>();
            }
        }

        private static void DrawGridOverlay(Graphics g, int width, int height)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Font font = _overlayFont != null ? _overlayFont : SystemFonts.DefaultFont;
            using (Pen minorPen = new Pen(Color.FromArgb(95, 44, 94, 79), 1f))
            using (Pen majorPen = new Pen(Color.FromArgb(155, 44, 94, 79), 1.3f))
            using (SolidBrush pillBg = new SolidBrush(Color.FromArgb(205, 24, 24, 22)))
            using (SolidBrush pillFg = new SolidBrush(Color.FromArgb(255, 246, 244, 239)))
            {
                for (int step = 100; step <= 900; step += 100)
                {
                    float gx = (float)((step / 1000.0) * Math.Max(1, width - 1));
                    float gy = (float)((step / 1000.0) * Math.Max(1, height - 1));
                    Pen p = (step == 500) ? majorPen : minorPen;
                    g.DrawLine(p, gx, 0, gx, height);
                    g.DrawLine(p, 0, gy, width, gy);

                    string label = step.ToString();
                    SizeF sz = g.MeasureString(label, font);
                    float tx = Math.Min(width - sz.Width - 4f, gx + 2f);
                    g.FillRectangle(pillBg, tx, 2f, sz.Width + 2f, sz.Height);
                    g.DrawString(label, font, pillFg, tx + 1f, 2f);

                    float ty = Math.Min(height - sz.Height - 2f, gy + 2f);
                    g.FillRectangle(pillBg, 2f, ty, sz.Width + 2f, sz.Height);
                    g.DrawString(label, font, pillFg, 3f, ty);
                }
            }
        }

        private static void DrawSomOverlay(Graphics g, int outW, int outH, int viewX, int viewY, int viewW, int viewH, List<Dictionary<string, object>> nodes)
        {
            if (nodes == null || nodes.Count == 0) return;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Font font = _overlayFont != null ? _overlayFont : SystemFonts.DefaultFont;
            using (Pen boxPen = new Pen(Color.FromArgb(210, 44, 94, 79), 1.5f))
            using (SolidBrush badgeBg = new SolidBrush(Color.FromArgb(230, 184, 93, 25)))
            using (SolidBrush badgeFg = new SolidBrush(Color.FromArgb(255, 252, 251, 248)))
            {
                double scaleX = (double)outW / Math.Max(1, viewW);
                double scaleY = (double)outH / Math.Max(1, viewH);

                for (int i = 0; i < nodes.Count; i++)
                {
                    Dictionary<string, object> n = nodes[i];
                    Dictionary<string, object> b = (Dictionary<string, object>)n["bounds"];
                    int bx = (int)b["x"] - viewX;
                    int by = (int)b["y"] - viewY;
                    int bw = (int)b["width"];
                    int bh = (int)b["height"];
                    if (bx + bw <= 0 || by + bh <= 0 || bx >= viewW || by >= viewH) continue;

                    float rx = (float)(bx * scaleX);
                    float ry = (float)(by * scaleY);
                    float rw = Math.Max(4f, (float)(bw * scaleX));
                    float rh = Math.Max(4f, (float)(bh * scaleY));
                    g.DrawRectangle(boxPen, rx, ry, rw, rh);

                    string tag = string.Format("[{0}]", n["somId"]);
                    SizeF sz = g.MeasureString(tag, font);
                    float lx = Math.Max(0f, Math.Min(outW - sz.Width - 2f, rx));
                    float ly = Math.Max(0f, ry - sz.Height >= 0 ? ry - sz.Height : ry);
                    g.FillRectangle(badgeBg, lx, ly, sz.Width + 2f, sz.Height);
                    g.DrawString(tag, font, badgeFg, lx + 1f, ly);
                }
            }
        }

        private static Bitmap EnsureReusableBitmap(ref Bitmap slot, int w, int h, PixelFormat fmt)
        {
            if (slot != null && slot.Width == w && slot.Height == h && slot.PixelFormat == fmt)
            {
                return slot;
            }
            if (slot != null)
            {
                slot.Dispose();
                slot = null;
            }
            slot = new Bitmap(w, h, fmt);
            return slot;
        }

        private static ImageCodecInfo GetJpegCodec()
        {
            if (!_jpegCodecResolved)
            {
                _jpegCodecResolved = true;
                try
                {
                    ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
                    for (int i = 0; i < codecs.Length; i++)
                    {
                        if (string.Equals(codecs[i].MimeType, "image/jpeg", StringComparison.OrdinalIgnoreCase))
                        {
                            _jpegCodec = codecs[i];
                            break;
                        }
                    }
                }
                catch { }
            }
            return _jpegCodec;
        }

        private static string ComputeSampledPixelHash(Bitmap bmp)
        {
            if (bmp == null) return "";
            int w = bmp.Width;
            int h = bmp.Height;
            if (w <= 0 || h <= 0) return "";
            BitmapData data = null;
            try
            {
                data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                int stride = Math.Abs(data.Stride);
                int totalBytes = stride * h;
                if (totalBytes <= 0) return "";
                byte[] rowBuf = new byte[stride];
                int stepY = Math.Max(1, h / 48);
                int stepX = Math.Max(1, w / 64);
                ulong hash = 14695981039346656037UL;
                hash ^= (ulong)w; hash *= 1099511628211UL;
                hash ^= (ulong)h; hash *= 1099511628211UL;
                IntPtr scan0 = data.Scan0;
                int rowStride = data.Stride;
                for (int y = 0; y < h; y += stepY)
                {
                    IntPtr rowPtr = new IntPtr(scan0.ToInt64() + (long)y * rowStride);
                    Marshal.Copy(rowPtr, rowBuf, 0, stride);
                    for (int x = 0; x < w; x += stepX)
                    {
                        int off = x * 3;
                        if (off + 2 < stride)
                        {
                            hash ^= rowBuf[off]; hash *= 1099511628211UL;
                            hash ^= rowBuf[off + 1]; hash *= 1099511628211UL;
                            hash ^= rowBuf[off + 2]; hash *= 1099511628211UL;
                        }
                    }
                }
                return string.Format("{0:x16}", hash);
            }
            catch
            {
                return "";
            }
            finally
            {
                if (data != null)
                {
                    try { bmp.UnlockBits(data); } catch { }
                }
            }
        }

        public static Dictionary<string, object> CaptureRegion(
            string hwndStr,
            int originX,
            int originY,
            int targetW,
            int targetH,
            bool hasCrop,
            int cropX,
            int cropY,
            int cropW,
            int cropH,
            int maxWidth,
            int maxHeight,
            string overlay,
            bool includeAccessibility,
            string format = "png",
            int quality = 80)
        {
            EnsureInitialized();
            IntPtr targetHwnd = ParseHwnd(hwndStr);
            if (targetHwnd != IntPtr.Zero)
            {
                if (!IsWindow(targetHwnd)) throw new ArgumentException("Window no longer exists: " + hwndStr);
                RECT wr;
                if (GetWindowRect(targetHwnd, out wr))
                {
                    originX = wr.Left;
                    originY = wr.Top;
                    targetW = Math.Max(1, wr.Right - wr.Left);
                    targetH = Math.Max(1, wr.Bottom - wr.Top);
                }
            }

            int viewX = hasCrop ? Math.Max(0, Math.Min(targetW - 1, cropX)) : 0;
            int viewY = hasCrop ? Math.Max(0, Math.Min(targetH - 1, cropY)) : 0;
            int viewW = hasCrop ? Math.Max(1, Math.Min(targetW - viewX, cropW)) : targetW;
            int viewH = hasCrop ? Math.Max(1, Math.Min(targetH - viewY, cropH)) : targetH;

            Bitmap ownedWindowCrop = null;
            Bitmap croppedNative = null;
            Bitmap finalBmp = null;

            try
            {
                int mw = maxWidth > 0 ? maxWidth : viewW;
                int mh = maxHeight > 0 ? maxHeight : viewH;
                double scale = Math.Min(1.0, Math.Min((double)mw / viewW, (double)mh / viewH));
                int outW = scale < 1.0 ? Math.Max(1, (int)Math.Round(viewW * scale)) : viewW;
                int outH = scale < 1.0 ? Math.Max(1, (int)Math.Round(viewH * scale)) : viewH;

                int preW = viewW;
                int preH = viewH;

                if (targetHwnd != IntPtr.Zero)
                {
                    Bitmap fullWin = EnsureReusableBitmap(ref _reuseSrcBmp, targetW, targetH, PixelFormat.Format32bppPArgb);
                    bool printed = false;
                    using (Graphics gw = Graphics.FromImage(fullWin))
                    {
                        IntPtr hdc = gw.GetHdc();
                        try
                        {
                            printed = PrintWindow(targetHwnd, hdc, 2u);
                        }
                        finally
                        {
                            gw.ReleaseHdc(hdc);
                        }
                        if (!printed)
                        {
                            gw.CopyFromScreen(originX, originY, 0, 0, new Size(targetW, targetH), CopyPixelOperation.SourceCopy);
                        }
                    }
                    if (hasCrop)
                    {
                        ownedWindowCrop = fullWin.Clone(new Rectangle(viewX, viewY, viewW, viewH), PixelFormat.Format32bppPArgb);
                        croppedNative = ownedWindowCrop;
                    }
                    else
                    {
                        croppedNative = fullWin;
                    }
                }
                else if (viewW >= (int)(outW * 1.5) && viewH >= (int)(outH * 1.5))
                {
                    preW = Math.Min(viewW, Math.Max(outW, (int)Math.Round(outW * 1.35)));
                    preH = Math.Min(viewH, Math.Max(outH, (int)Math.Round(outH * 1.35)));
                    croppedNative = EnsureReusableBitmap(ref _reuseSrcBmp, preW, preH, PixelFormat.Format32bppPArgb);
                    using (Graphics gs = Graphics.FromImage(croppedNative))
                    {
                        IntPtr dstHdc = gs.GetHdc();
                        IntPtr scrHdc = GetDC(IntPtr.Zero);
                        try
                        {
                            SetStretchBltMode(dstHdc, 4);
                            SetBrushOrgEx(dstHdc, 0, 0, IntPtr.Zero);
                            StretchBlt(dstHdc, 0, 0, preW, preH, scrHdc, originX + viewX, originY + viewY, viewW, viewH, 0x00CC0020u);
                        }
                        finally
                        {
                            if (scrHdc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, scrHdc);
                            gs.ReleaseHdc(dstHdc);
                        }
                    }
                }
                else
                {
                    croppedNative = EnsureReusableBitmap(ref _reuseSrcBmp, viewW, viewH, PixelFormat.Format32bppPArgb);
                    using (Graphics gs = Graphics.FromImage(croppedNative))
                    {
                        gs.CopyFromScreen(originX + viewX, originY + viewY, 0, 0, new Size(viewW, viewH), CopyPixelOperation.SourceCopy);
                    }
                }

                bool wantJpeg = (string.Equals(format, "jpeg", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(format, "jpg", StringComparison.OrdinalIgnoreCase))
                    && GetJpegCodec() != null;

                if (outW != preW || outH != preH)
                {
                    finalBmp = EnsureReusableBitmap(ref _reuseOutBmp, outW, outH, PixelFormat.Format24bppRgb);
                    using (Graphics gd = Graphics.FromImage(finalBmp))
                    {
                        gd.CompositingMode = CompositingMode.SourceCopy;
                        if (wantJpeg)
                        {
                            gd.InterpolationMode = InterpolationMode.Bilinear;
                            gd.PixelOffsetMode = PixelOffsetMode.Half;
                            gd.SmoothingMode = SmoothingMode.HighSpeed;
                            gd.CompositingQuality = CompositingQuality.HighSpeed;
                        }
                        else
                        {
                            gd.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            gd.PixelOffsetMode = PixelOffsetMode.HighQuality;
                            gd.SmoothingMode = SmoothingMode.HighQuality;
                            gd.CompositingQuality = CompositingQuality.HighQuality;
                        }
                        gd.DrawImage(croppedNative, new Rectangle(0, 0, outW, outH), new Rectangle(0, 0, preW, preH), GraphicsUnit.Pixel);
                    }
                }
                else
                {
                    finalBmp = EnsureReusableBitmap(ref _reuseOutBmp, outW, outH, PixelFormat.Format24bppRgb);
                    using (Graphics gd = Graphics.FromImage(finalBmp))
                    {
                        gd.CompositingMode = CompositingMode.SourceCopy;
                        gd.DrawImage(croppedNative, 0, 0, outW, outH);
                    }
                }

                bool needAx = includeAccessibility || string.Equals(overlay, "som", StringComparison.OrdinalIgnoreCase);
                List<Dictionary<string, object>> axNodes = needAx
                    ? QueryAccessibilityBounded(targetHwnd, originX, originY, targetW, targetH, 750)
                    : new List<Dictionary<string, object>>();

                if (string.Equals(overlay, "grid", StringComparison.OrdinalIgnoreCase))
                {
                    using (Graphics go = Graphics.FromImage(finalBmp))
                    {
                        DrawGridOverlay(go, outW, outH);
                    }
                }
                else if (string.Equals(overlay, "som", StringComparison.OrdinalIgnoreCase))
                {
                    using (Graphics go = Graphics.FromImage(finalBmp))
                    {
                        DrawSomOverlay(go, outW, outH, viewX, viewY, viewW, viewH, axNodes);
                    }
                }

                string pixelHash = ComputeSampledPixelHash(finalBmp);
                string mimeType = "image/png";
                _reusePngStream.Position = 0;
                _reusePngStream.SetLength(0);
                if (wantJpeg)
                {
                    int clampedQ = Math.Max(30, Math.Min(95, quality > 0 ? quality : 80));
                    using (EncoderParameters encParams = new EncoderParameters(1))
                    {
                        encParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)clampedQ);
                        finalBmp.Save(_reusePngStream, GetJpegCodec(), encParams);
                    }
                    mimeType = "image/jpeg";
                }
                else
                {
                    finalBmp.Save(_reusePngStream, ImageFormat.Png);
                }
                int byteLen = (int)_reusePngStream.Length;
                string b64 = Convert.ToBase64String(_reusePngStream.GetBuffer(), 0, byteLen);

                Dictionary<string, object> imgSize = new Dictionary<string, object>();
                imgSize["width"] = outW;
                imgSize["height"] = outH;

                Dictionary<string, object> logSize = new Dictionary<string, object>();
                logSize["width"] = targetW;
                logSize["height"] = targetH;

                Dictionary<string, object> originObj = new Dictionary<string, object>();
                originObj["x"] = originX;
                originObj["y"] = originY;

                Dictionary<string, object> cropObj = null;
                if (hasCrop)
                {
                    cropObj = new Dictionary<string, object>();
                    cropObj["x"] = viewX;
                    cropObj["y"] = viewY;
                    cropObj["width"] = viewW;
                    cropObj["height"] = viewH;
                }

                IntPtr fg = GetForegroundWindow();
                Dictionary<string, object> res = new Dictionary<string, object>();
                res["mimeType"] = mimeType;
                res["pixelHash"] = pixelHash;
                res["imageBase64"] = b64;
                res["byteLength"] = byteLen;
                res["imageSize"] = imgSize;
                res["logicalSize"] = logSize;
                res["targetOrigin"] = originObj;
                res["cropBounds"] = cropObj;
                res["cursor"] = GetCursorPosition();
                res["foregroundWindow"] = GetWindowSummary(fg);
                res["accessibility"] = axNodes;
                return res;
            }
            finally
            {
                if (ownedWindowCrop != null) ownedWindowCrop.Dispose();
            }
        }

        private static void ComputeVirtualDeskAbsolute(int screenX, int screenY, out int dx, out int dy)
        {
            int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
            int vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));

            long denomX = Math.Max(1L, (long)vw - 1L);
            long denomY = Math.Max(1L, (long)vh - 1L);

            long lx = Math.Max(0L, Math.Min(65535L, (((long)screenX - (long)vx) * 65535L + denomX / 2L) / denomX));
            long ly = Math.Max(0L, Math.Min(65535L, (((long)screenY - (long)vy) * 65535L + denomY / 2L) / denomY));

            dx = (int)lx;
            dy = (int)ly;
        }

        private static void DispatchInputs(INPUT[] inputs)
        {
            if (inputs == null || inputs.Length == 0) return;
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent == 0)
            {
                int err = Marshal.GetLastWin32Error();
                throw new InvalidOperationException("SendInput failed with Win32 error " + err);
            }
        }

        private static INPUT MakeMouseMoveInput(int screenX, int screenY)
        {
            int dx;
            int dy;
            ComputeVirtualDeskAbsolute(screenX, screenY, out dx, out dy);
            INPUT inp = new INPUT();
            inp.type = INPUT_MOUSE;
            inp.u.mi.dx = dx;
            inp.u.mi.dy = dy;
            inp.u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
            inp.u.mi.dwExtraInfo = EXTRA_MAGIC;
            return inp;
        }

        private static INPUT MakeMouseButtonInput(uint flag, uint mouseData)
        {
            INPUT inp = new INPUT();
            inp.type = INPUT_MOUSE;
            inp.u.mi.dwFlags = flag;
            inp.u.mi.mouseData = mouseData;
            inp.u.mi.dwExtraInfo = EXTRA_MAGIC;
            return inp;
        }

        private static bool IsExtendedVk(ushort vk)
        {
            return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 ||
                   vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 ||
                   vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C ||
                   vk == 0xA3 || vk == 0xA5 || vk == 0x6F;
        }

        private static INPUT MakeKeyVkInput(ushort vk, bool keyUp)
        {
            INPUT inp = new INPUT();
            inp.type = INPUT_KEYBOARD;
            inp.u.ki.wVk = vk;
            inp.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
            uint flags = keyUp ? KEYEVENTF_KEYUP : 0u;
            if (IsExtendedVk(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
            inp.u.ki.dwFlags = flags;
            inp.u.ki.dwExtraInfo = EXTRA_MAGIC;
            return inp;
        }

        private static INPUT MakeUnicodeCharInput(ushort utf16Unit, bool keyUp)
        {
            INPUT inp = new INPUT();
            inp.type = INPUT_KEYBOARD;
            inp.u.ki.wVk = 0;
            inp.u.ki.wScan = utf16Unit;
            inp.u.ki.dwFlags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0u);
            inp.u.ki.dwExtraInfo = EXTRA_MAGIC;
            return inp;
        }

        public static ushort ResolveVirtualKey(string keyName)
        {
            if (string.IsNullOrWhiteSpace(keyName)) throw new ArgumentException("Empty key name");
            string k = keyName.Trim().ToUpperInvariant();
            switch (k)
            {
                case "CTRL":
                case "CONTROL":
                case "LCTRL":
                    return 0x11;
                case "RCTRL":
                    return 0xA3;
                case "SHIFT":
                case "LSHIFT":
                    return 0x10;
                case "RSHIFT":
                    return 0xA1;
                case "ALT":
                case "MENU":
                case "OPTION":
                case "LALT":
                    return 0x12;
                case "RALT":
                    return 0xA5;
                case "WIN":
                case "META":
                case "SUPER":
                case "CMD":
                case "COMMAND":
                case "LWIN":
                    return 0x5B;
                case "RWIN":
                    return 0x5C;
                case "ENTER":
                case "RETURN":
                    return 0x0D;
                case "ESC":
                case "ESCAPE":
                    return 0x1B;
                case "TAB":
                    return 0x09;
                case "SPACE":
                case "SPACEBAR":
                    return 0x20;
                case "BACKSPACE":
                case "BKSP":
                    return 0x08;
                case "DELETE":
                case "DEL":
                    return 0x2E;
                case "INSERT":
                case "INS":
                    return 0x2D;
                case "HOME":
                    return 0x24;
                case "END":
                    return 0x23;
                case "PAGEUP":
                case "PGUP":
                    return 0x21;
                case "PAGEDOWN":
                case "PGDN":
                    return 0x22;
                case "LEFT":
                case "ARROWLEFT":
                    return 0x25;
                case "UP":
                case "ARROWUP":
                    return 0x26;
                case "RIGHT":
                case "ARROWRIGHT":
                    return 0x27;
                case "DOWN":
                case "ARROWDOWN":
                    return 0x28;
                case "CAPSLOCK":
                    return 0x14;
                case "PRINTSCREEN":
                case "PRTSC":
                    return 0x2C;
                case "APPS":
                case "CONTEXTMENU":
                    return 0x5D;
                case ";":
                case "SEMICOLON":
                    return 0xBA;
                case "=":
                case "PLUS":
                case "EQUALS":
                    return 0xBB;
                case ",":
                case "COMMA":
                    return 0xBC;
                case "-":
                case "MINUS":
                    return 0xBD;
                case ".":
                case "PERIOD":
                    return 0xBE;
                case "/":
                case "SLASH":
                    return 0xBF;
                case "`":
                case "BACKQUOTE":
                    return 0xC0;
                case "[":
                case "BRACKETLEFT":
                    return 0xDB;
                case "\\":
                case "BACKSLASH":
                    return 0xDC;
                case "]":
                case "BRACKETRIGHT":
                    return 0xDD;
                case "'":
                case "QUOTE":
                    return 0xDE;
            }
            if (k.Length == 1)
            {
                char ch = k[0];
                if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'))
                {
                    return (ushort)ch;
                }
            }
            if (k.StartsWith("F", StringComparison.Ordinal) && k.Length <= 3)
            {
                int fn;
                if (int.TryParse(k.Substring(1), out fn) && fn >= 1 && fn <= 24)
                {
                    return (ushort)(0x70 + fn - 1);
                }
            }
            throw new ArgumentException("Unsupported key identifier: " + keyName);
        }

        public static void ReleaseAllInputs()
        {
            List<INPUT> releases = new List<INPUT>();
            foreach (ushort vk in _heldKeys)
            {
                releases.Add(MakeKeyVkInput(vk, true));
            }
            _heldKeys.Clear();

            if ((_heldMouseButtons & MOUSEEVENTF_LEFTUP) != 0) releases.Add(MakeMouseButtonInput(MOUSEEVENTF_LEFTUP, 0));
            if ((_heldMouseButtons & MOUSEEVENTF_RIGHTUP) != 0) releases.Add(MakeMouseButtonInput(MOUSEEVENTF_RIGHTUP, 0));
            if ((_heldMouseButtons & MOUSEEVENTF_MIDDLEUP) != 0) releases.Add(MakeMouseButtonInput(MOUSEEVENTF_MIDDLEUP, 0));
            _heldMouseButtons = 0;

            if (releases.Count > 0)
            {
                try { SendInput((uint)releases.Count, releases.ToArray(), Marshal.SizeOf(typeof(INPUT))); }
                catch { }
            }
        }

        private static void ButtonFlags(string button, out uint downFlag, out uint upFlag)
        {
            string b = button != null ? button.Trim().ToLowerInvariant() : "left";
            if (b == "right") { downFlag = MOUSEEVENTF_RIGHTDOWN; upFlag = MOUSEEVENTF_RIGHTUP; return; }
            if (b == "middle") { downFlag = MOUSEEVENTF_MIDDLEDOWN; upFlag = MOUSEEVENTF_MIDDLEUP; return; }
            downFlag = MOUSEEVENTF_LEFTDOWN;
            upFlag = MOUSEEVENTF_LEFTUP;
        }

        public static Dictionary<string, object> MouseMove(int screenX, int screenY)
        {
            EnsureInitialized();
            DispatchInputs(new INPUT[] { MakeMouseMoveInput(screenX, screenY) });
            return GetCursorPosition();
        }

        public static Dictionary<string, object> MouseClick(int screenX, int screenY, string button, int count, string[] modifiers)
        {
            EnsureInitialized();
            Dictionary<string, object> uipi = CheckUipiAtPoint(screenX, screenY);
            if (uipi != null) return uipi;

            uint downFlag;
            uint upFlag;
            ButtonFlags(button, out downFlag, out upFlag);
            int clicks = Math.Max(1, Math.Min(3, count));

            List<ushort> modVks = new List<ushort>();
            if (modifiers != null)
            {
                for (int i = 0; i < modifiers.Length; i++)
                {
                    if (!string.IsNullOrWhiteSpace(modifiers[i]))
                    {
                        modVks.Add(ResolveVirtualKey(modifiers[i]));
                    }
                }
            }

            try
            {
                DispatchInputs(new INPUT[] { MakeMouseMoveInput(screenX, screenY) });
                for (int i = 0; i < modVks.Count; i++)
                {
                    _heldKeys.Add(modVks[i]);
                    DispatchInputs(new INPUT[] { MakeKeyVkInput(modVks[i], false) });
                }
                for (int c = 0; c < clicks; c++)
                {
                    DispatchInputs(new INPUT[] { MakeMouseButtonInput(downFlag, 0), MakeMouseButtonInput(upFlag, 0) });
                    if (c + 1 < clicks) Thread.Sleep(35);
                }
            }
            finally
            {
                for (int i = modVks.Count - 1; i >= 0; i--)
                {
                    _heldKeys.Remove(modVks[i]);
                    try { DispatchInputs(new INPUT[] { MakeKeyVkInput(modVks[i], true) }); } catch { }
                }
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["blocked"] = false;
            res["cursor"] = GetCursorPosition();
            return res;
        }

        public static Dictionary<string, object> MouseDownUp(bool isDown, bool hasCoords, int screenX, int screenY, string button)
        {
            EnsureInitialized();
            if (hasCoords)
            {
                Dictionary<string, object> uipi = CheckUipiAtPoint(screenX, screenY);
                if (uipi != null) return uipi;
                DispatchInputs(new INPUT[] { MakeMouseMoveInput(screenX, screenY) });
            }
            else
            {
                Dictionary<string, object> uipiFg = CheckUipiForWindow(GetForegroundWindow());
                if (uipiFg != null) return uipiFg;
            }

            uint downFlag;
            uint upFlag;
            ButtonFlags(button, out downFlag, out upFlag);
            if (isDown)
            {
                _heldMouseButtons |= upFlag;
                DispatchInputs(new INPUT[] { MakeMouseButtonInput(downFlag, 0) });
            }
            else
            {
                _heldMouseButtons &= ~upFlag;
                DispatchInputs(new INPUT[] { MakeMouseButtonInput(upFlag, 0) });
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["blocked"] = false;
            res["cursor"] = GetCursorPosition();
            return res;
        }

        public static Dictionary<string, object> MouseDrag(int startX, int startY, int endX, int endY, string button, int durationMs)
        {
            EnsureInitialized();
            Dictionary<string, object> uipi = CheckUipiAtPoint(startX, startY);
            if (uipi != null) return uipi;

            uint downFlag;
            uint upFlag;
            ButtonFlags(button, out downFlag, out upFlag);
            int dur = Math.Max(60, Math.Min(5000, durationMs > 0 ? durationMs : 220));
            int steps = Math.Max(6, Math.Min(30, dur / 14));
            int stepSleep = Math.Max(5, dur / steps);

            try
            {
                DispatchInputs(new INPUT[] { MakeMouseMoveInput(startX, startY) });
                Thread.Sleep(15);
                _heldMouseButtons |= upFlag;
                DispatchInputs(new INPUT[] { MakeMouseButtonInput(downFlag, 0) });
                for (int i = 1; i <= steps; i++)
                {
                    double t = (double)i / steps;
                    int ix = (int)Math.Round(startX + (endX - startX) * t);
                    int iy = (int)Math.Round(startY + (endY - startY) * t);
                    DispatchInputs(new INPUT[] { MakeMouseMoveInput(ix, iy) });
                    Thread.Sleep(stepSleep);
                }
            }
            finally
            {
                _heldMouseButtons &= ~upFlag;
                try { DispatchInputs(new INPUT[] { MakeMouseButtonInput(upFlag, 0) }); } catch { }
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["blocked"] = false;
            res["cursor"] = GetCursorPosition();
            return res;
        }

        public static Dictionary<string, object> MouseScroll(int screenX, int screenY, double deltaX, double deltaY)
        {
            EnsureInitialized();
            Dictionary<string, object> uipi = CheckUipiAtPoint(screenX, screenY);
            if (uipi != null) return uipi;

            DispatchInputs(new INPUT[] { MakeMouseMoveInput(screenX, screenY) });
            List<INPUT> events = new List<INPUT>();
            if (Math.Abs(deltaY) > 0.001)
            {
                int wheelY = (int)Math.Round(-deltaY * 120.0);
                if (wheelY == 0) wheelY = deltaY > 0 ? -120 : 120;
                events.Add(MakeMouseButtonInput(MOUSEEVENTF_WHEEL, unchecked((uint)wheelY)));
            }
            if (Math.Abs(deltaX) > 0.001)
            {
                int wheelX = (int)Math.Round(deltaX * 120.0);
                if (wheelX == 0) wheelX = deltaX > 0 ? 120 : -120;
                events.Add(MakeMouseButtonInput(MOUSEEVENTF_HWHEEL, unchecked((uint)wheelX)));
            }
            if (events.Count > 0) DispatchInputs(events.ToArray());

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["blocked"] = false;
            res["cursor"] = GetCursorPosition();
            return res;
        }

        public static Dictionary<string, object> SendKeyChord(string[] tokens)
        {
            EnsureInitialized();
            Dictionary<string, object> uipi = CheckUipiForWindow(GetForegroundWindow());
            if (uipi != null) return uipi;

            List<ushort> vks = new List<ushort>();
            for (int i = 0; i < tokens.Length; i++)
            {
                if (!string.IsNullOrWhiteSpace(tokens[i]))
                {
                    vks.Add(ResolveVirtualKey(tokens[i]));
                }
            }
            if (vks.Count == 0) throw new ArgumentException("Key chord has no valid keys");

            try
            {
                for (int i = 0; i < vks.Count; i++)
                {
                    _heldKeys.Add(vks[i]);
                    DispatchInputs(new INPUT[] { MakeKeyVkInput(vks[i], false) });
                }
                Thread.Sleep(12);
            }
            finally
            {
                for (int i = vks.Count - 1; i >= 0; i--)
                {
                    _heldKeys.Remove(vks[i]);
                    try { DispatchInputs(new INPUT[] { MakeKeyVkInput(vks[i], true) }); } catch { }
                }
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["blocked"] = false;
            return res;
        }

        public static Dictionary<string, object> HoldKey(string keyName, int durationMs)
        {
            EnsureInitialized();
            Dictionary<string, object> uipi = CheckUipiForWindow(GetForegroundWindow());
            if (uipi != null) return uipi;

            ushort vk = ResolveVirtualKey(keyName);
            int dur = Math.Max(10, Math.Min(10000, durationMs));
            try
            {
                _heldKeys.Add(vk);
                DispatchInputs(new INPUT[] { MakeKeyVkInput(vk, false) });
                Thread.Sleep(dur);
            }
            finally
            {
                _heldKeys.Remove(vk);
                try { DispatchInputs(new INPUT[] { MakeKeyVkInput(vk, true) }); } catch { }
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["blocked"] = false;
            return res;
        }

        private static bool TryOpenClipboardWithRetry()
        {
            for (int i = 0; i < 8; i++)
            {
                if (OpenClipboard(IntPtr.Zero)) return true;
                Thread.Sleep(12);
            }
            return false;
        }

        private static void SetClipboardDwordFormat(uint fmt, uint value)
        {
            if (fmt == 0) return;
            IntPtr hMem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, new UIntPtr(4));
            if (hMem == IntPtr.Zero) return;
            IntPtr ptr = GlobalLock(hMem);
            if (ptr != IntPtr.Zero)
            {
                try { Marshal.WriteInt32(ptr, unchecked((int)value)); }
                finally { GlobalUnlock(hMem); }
            }
            if (SetClipboardData(fmt, hMem) == IntPtr.Zero)
            {
                GlobalFree(hMem);
            }
        }

        private static void WriteUnicodeClipboardInternal(string text, bool excludeFromHistory)
        {
            string val = text != null ? text : "";
            byte[] bytes = Encoding.Unicode.GetBytes(val + "\0");
            IntPtr hText = GlobalAlloc(GMEM_MOVEABLE, new UIntPtr((uint)bytes.Length));
            if (hText == IntPtr.Zero) throw new InvalidOperationException("GlobalAlloc failed for clipboard text");
            IntPtr locked = GlobalLock(hText);
            if (locked == IntPtr.Zero)
            {
                GlobalFree(hText);
                throw new InvalidOperationException("GlobalLock failed for clipboard text");
            }
            try
            {
                Marshal.Copy(bytes, 0, locked, bytes.Length);
            }
            finally
            {
                GlobalUnlock(hText);
            }

            EmptyClipboard();
            if (SetClipboardData(CF_UNICODETEXT, hText) == IntPtr.Zero)
            {
                GlobalFree(hText);
                throw new InvalidOperationException("SetClipboardData failed");
            }

            if (excludeFromHistory)
            {
                uint fmtExclude = RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing");
                uint fmtHistory = RegisterClipboardFormat("CanIncludeInClipboardHistory");
                uint fmtCloud = RegisterClipboardFormat("CanUploadToCloudClipboard");
                SetClipboardDwordFormat(fmtExclude, 1u);
                SetClipboardDwordFormat(fmtHistory, 0u);
                SetClipboardDwordFormat(fmtCloud, 0u);
            }
        }

        private static string ReadUnicodeClipboardInternal(out bool hadText)
        {
            hadText = false;
            IntPtr hData = GetClipboardData(CF_UNICODETEXT);
            if (hData == IntPtr.Zero) return "";
            IntPtr ptr = GlobalLock(hData);
            if (ptr == IntPtr.Zero) return "";
            try
            {
                hadText = true;
                return Marshal.PtrToStringUni(ptr) ?? "";
            }
            finally
            {
                GlobalUnlock(hData);
            }
        }

        public static string GetClipboardText()
        {
            EnsureInitialized();
            if (!TryOpenClipboardWithRetry()) throw new InvalidOperationException("Could not open Windows clipboard");
            try
            {
                bool had;
                return ReadUnicodeClipboardInternal(out had);
            }
            finally
            {
                CloseClipboard();
            }
        }

        public static void SetClipboardText(string text, bool excludeFromHistory)
        {
            EnsureInitialized();
            if (!TryOpenClipboardWithRetry()) throw new InvalidOperationException("Could not open Windows clipboard");
            try
            {
                WriteUnicodeClipboardInternal(text, excludeFromHistory);
            }
            finally
            {
                CloseClipboard();
            }
        }

        private static bool NeedsClipboardPaste(string text, string mode)
        {
            string m = mode != null ? mode.Trim().ToLowerInvariant() : "auto";
            if (m == "clipboard") return true;
            if (m == "unicode") return false;
            if (text.Length > 64) return true;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r' || c == '\n' || c == '\t' || c > 0x007E) return true;
            }
            return false;
        }

        public static Dictionary<string, object> TypeText(string text, string mode, bool submit)
        {
            EnsureInitialized();
            Dictionary<string, object> uipi = CheckUipiForWindow(GetForegroundWindow());
            if (uipi != null) return uipi;

            string val = text != null ? text : "";
            string usedMode = "unicode";

            if (val.Length > 0)
            {
                if (NeedsClipboardPaste(val, mode))
                {
                    usedMode = "clipboard";
                    bool hadPrev = false;
                    string prevText = "";
                    if (!TryOpenClipboardWithRetry()) throw new InvalidOperationException("Could not open clipboard for paste");
                    try
                    {
                        prevText = ReadUnicodeClipboardInternal(out hadPrev);
                        WriteUnicodeClipboardInternal(val, true);
                    }
                    finally
                    {
                        CloseClipboard();
                    }

                    try
                    {
                        SendKeyChord(new string[] { "CTRL", "V" });
                        Thread.Sleep(50);
                    }
                    finally
                    {
                        if (TryOpenClipboardWithRetry())
                        {
                            try
                            {
                                if (hadPrev) WriteUnicodeClipboardInternal(prevText, true);
                                else EmptyClipboard();
                            }
                            catch { }
                            finally { CloseClipboard(); }
                        }
                    }
                }
                else
                {
                    List<INPUT> events = new List<INPUT>(val.Length * 2);
                    for (int i = 0; i < val.Length; i++)
                    {
                        ushort unit = (ushort)val[i];
                        events.Add(MakeUnicodeCharInput(unit, false));
                        events.Add(MakeUnicodeCharInput(unit, true));
                    }
                    DispatchInputs(events.ToArray());
                }
            }

            if (submit)
            {
                Thread.Sleep(15);
                SendKeyChord(new string[] { "ENTER" });
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["blocked"] = false;
            res["mode"] = usedMode;
            res["length"] = val.Length;
            return res;
        }

        private static int DictInt(Dictionary<string, object> d, string k, int fallback)
        {
            if (d != null && d.ContainsKey(k) && d[k] != null) return Convert.ToInt32(d[k]);
            return fallback;
        }

        private static double DictDouble(Dictionary<string, object> d, string k, double fallback)
        {
            if (d != null && d.ContainsKey(k) && d[k] != null) return Convert.ToDouble(d[k]);
            return fallback;
        }

        private static bool DictBool(Dictionary<string, object> d, string k, bool fallback)
        {
            if (d != null && d.ContainsKey(k) && d[k] != null) return Convert.ToBoolean(d[k]);
            return fallback;
        }

        private static string DictStr(Dictionary<string, object> d, string k, string fallback)
        {
            if (d != null && d.ContainsKey(k) && d[k] != null) return Convert.ToString(d[k]);
            return fallback;
        }

        private static string[] DictStrArray(Dictionary<string, object> d, string k)
        {
            if (d == null || !d.ContainsKey(k) || d[k] == null) return new string[0];
            object raw = d[k];
            if (raw is string) return new string[] { (string)raw };
            System.Collections.IEnumerable seq = raw as System.Collections.IEnumerable;
            if (seq == null) return new string[0];
            List<string> list = new List<string>();
            foreach (object item in seq)
            {
                if (item != null) list.Add(Convert.ToString(item));
            }
            return list.ToArray();
        }

        public static string BuildReadyLine(int pid)
        {
            EnsureInitialized();
            Dictionary<string, object> msg = new Dictionary<string, object>();
            msg["jsonrpc"] = "2.0";
            msg["method"] = "ready";
            msg["pid"] = pid;
            return SerializeJson(msg);
        }

        public static string HandleRpcLine(string line, int pid, out bool shouldExit)
        {
            shouldExit = false;
            object reqId = null;
            try
            {
                Dictionary<string, object> msg = DeserializeJson(line);
                if (msg != null && msg.ContainsKey("id")) reqId = msg["id"];
                string method = DictStr(msg, "method", "");
                Dictionary<string, object> p = null;
                if (msg != null && msg.ContainsKey("params") && msg["params"] is Dictionary<string, object>)
                {
                    p = (Dictionary<string, object>)msg["params"];
                }

                object result = null;
                switch (method)
                {
                    case "ping":
                    {
                        Dictionary<string, object> d = new Dictionary<string, object>();
                        d["ok"] = true;
                        d["pid"] = pid;
                        result = d;
                        break;
                    }
                    case "listMonitors":
                        result = ListMonitors();
                        break;
                    case "getCursorPos":
                        result = GetCursorPosition();
                        break;
                    case "listWindows":
                    {
                        Dictionary<string, object> d = new Dictionary<string, object>();
                        d["windows"] = ListWindows(DictStr(p, "query", ""));
                        result = d;
                        break;
                    }
                    case "focusWindow":
                        result = FocusOrRestoreWindow(DictStr(p, "hwnd", ""), true);
                        break;
                    case "restoreWindow":
                        result = FocusOrRestoreWindow(DictStr(p, "hwnd", ""), false);
                        break;
                    case "capture":
                        result = CaptureRegion(
                            DictStr(p, "hwnd", ""),
                            DictInt(p, "originX", 0),
                            DictInt(p, "originY", 0),
                            DictInt(p, "targetW", 1920),
                            DictInt(p, "targetH", 1080),
                            DictBool(p, "hasCrop", false),
                            DictInt(p, "cropX", 0),
                            DictInt(p, "cropY", 0),
                            DictInt(p, "cropW", 0),
                            DictInt(p, "cropH", 0),
                            DictInt(p, "maxWidth", 1280),
                            DictInt(p, "maxHeight", 900),
                            DictStr(p, "overlay", "none"),
                            DictBool(p, "includeAccessibility", false),
                            DictStr(p, "format", "png"),
                            DictInt(p, "quality", 80)
                        );
                        break;
                    case "mouseMove":
                        result = MouseMove(DictInt(p, "screenX", 0), DictInt(p, "screenY", 0));
                        break;
                    case "mouseClick":
                        result = MouseClick(
                            DictInt(p, "screenX", 0),
                            DictInt(p, "screenY", 0),
                            DictStr(p, "button", "left"),
                            DictInt(p, "count", 1),
                            DictStrArray(p, "modifiers")
                        );
                        break;
                    case "mouseDown":
                        result = MouseDownUp(
                            true,
                            DictBool(p, "hasCoords", false),
                            DictInt(p, "screenX", 0),
                            DictInt(p, "screenY", 0),
                            DictStr(p, "button", "left")
                        );
                        break;
                    case "mouseUp":
                        result = MouseDownUp(
                            false,
                            DictBool(p, "hasCoords", false),
                            DictInt(p, "screenX", 0),
                            DictInt(p, "screenY", 0),
                            DictStr(p, "button", "left")
                        );
                        break;
                    case "mouseDrag":
                        result = MouseDrag(
                            DictInt(p, "startX", 0),
                            DictInt(p, "startY", 0),
                            DictInt(p, "endX", 0),
                            DictInt(p, "endY", 0),
                            DictStr(p, "button", "left"),
                            DictInt(p, "durationMs", 220)
                        );
                        break;
                    case "mouseScroll":
                        result = MouseScroll(
                            DictInt(p, "screenX", 0),
                            DictInt(p, "screenY", 0),
                            DictDouble(p, "deltaX", 0.0),
                            DictDouble(p, "deltaY", 0.0)
                        );
                        break;
                    case "keyChord":
                        result = SendKeyChord(DictStrArray(p, "keys"));
                        break;
                    case "holdKey":
                        result = HoldKey(DictStr(p, "key", ""), DictInt(p, "durationMs", 250));
                        break;
                    case "typeText":
                        result = TypeText(
                            DictStr(p, "text", ""),
                            DictStr(p, "mode", "auto"),
                            DictBool(p, "submit", false)
                        );
                        break;
                    case "clipboardGet":
                    {
                        Dictionary<string, object> d = new Dictionary<string, object>();
                        d["text"] = GetClipboardText();
                        result = d;
                        break;
                    }
                    case "clipboardSet":
                    {
                        SetClipboardText(DictStr(p, "text", ""), DictBool(p, "excludeFromHistory", false));
                        Dictionary<string, object> d = new Dictionary<string, object>();
                        d["ok"] = true;
                        result = d;
                        break;
                    }
                    case "releaseAll":
                    {
                        ReleaseAllInputs();
                        Dictionary<string, object> d = new Dictionary<string, object>();
                        d["ok"] = true;
                        result = d;
                        break;
                    }
                    case "shutdown":
                        ReleaseAllInputs();
                        shouldExit = true;
                        result = true;
                        break;
                    default:
                        throw new ArgumentException("Unknown Win32 bridge method: " + method);
                }

                Dictionary<string, object> resp = new Dictionary<string, object>();
                resp["jsonrpc"] = "2.0";
                resp["id"] = reqId;
                resp["result"] = result;
                return SerializeJson(resp);
            }
            catch (Exception ex)
            {
                ReleaseAllInputs();
                Dictionary<string, object> errObj = new Dictionary<string, object>();
                errObj["message"] = ex.Message;
                Dictionary<string, object> resp = new Dictionary<string, object>();
                resp["jsonrpc"] = "2.0";
                resp["id"] = reqId;
                resp["error"] = errObj;
                return SerializeJson(resp);
            }
        }

        public static string SerializeJson(object obj)
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = int.MaxValue;
            return ser.Serialize(obj);
        }

        public static Dictionary<string, object> DeserializeJson(string json)
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = int.MaxValue;
            return ser.Deserialize<Dictionary<string, object>>(json);
        }
    }
}
