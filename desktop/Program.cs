using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace PhoneShare
{
    static class Program
    {
        // PHONESHARE_HOME moves everything the app writes (tests, portable use).
        internal static readonly string HomeOverride = Environment.GetEnvironmentVariable("PHONESHARE_HOME");
        internal static readonly string Home = string.IsNullOrEmpty(HomeOverride)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PhoneShare") : HomeOverride;

        /// <summary>"--updated" / "--update-failed" from the update script (Updater.Run).</summary>
        internal static string[] Args = new string[0];

        [STAThread]
        static void Main(string[] args)
        {
            Args = args;
            // One-file app: the WebView2 assemblies ride inside the exe and load from there.
            // Nothing in this method may touch a WebView2 type: the handler must exist before they resolve.
            AppDomain.CurrentDomain.AssemblyResolve += (s, e) => EmbeddedLib.Assembly(new AssemblyName(e.Name).Name);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Run();
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static void Run()
        {
            string loader = EmbeddedLib.ExtractLoader();
            if (loader != null) CoreWebView2Environment.SetLoaderDllFolderPath(loader);   // must precede every other WebView2 call
            Application.Run(new MainForm());
        }
    }

    /// <summary>WebView2 libraries embedded in the exe (resources lib/*), so PhoneShare.exe runs alone.</summary>
    static class EmbeddedLib
    {
        static readonly Dictionary<string, Assembly> Loaded = new Dictionary<string, Assembly>();

        static byte[] Bytes(string file)
        {
            using (Stream r = typeof(EmbeddedLib).Assembly.GetManifestResourceStream("lib/" + file))
            {
                if (r == null) return null;
                var ms = new MemoryStream();
                r.CopyTo(ms);
                return ms.ToArray();
            }
        }

        public static Assembly Assembly(string name)
        {
            lock (Loaded)
            {
                if (Loaded.TryGetValue(name, out Assembly a)) return a;
                byte[] b = Bytes(name + ".dll");
                a = b == null ? null : System.Reflection.Assembly.Load(b);
                Loaded[name] = a;
                return a;
            }
        }

        /// <summary>The native loader has to be a file: unpacked once per version into Home\bin\&lt;hash&gt;. Null if it is not embedded.</summary>
        public static string ExtractLoader()
        {
            byte[] b = Bytes("WebView2Loader.dll");
            if (b == null) return null;
            string hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(b), 0, 8).Replace("-", "").ToLowerInvariant();
            foreach (string root in new[] { Program.Home, Path.Combine(Path.GetTempPath(), "PhoneShare") })   // ponytail: temp if the profile folder is read-only
            {
                string dir = Path.Combine(root, "bin", hash), file = Path.Combine(dir, "WebView2Loader.dll");
                try
                {
                    if (!File.Exists(file) || new FileInfo(file).Length != b.Length)
                    {
                        Directory.CreateDirectory(dir);
                        File.WriteAllBytes(file, b);
                    }
                    return dir;
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { }
            }
            return null;
        }
    }

    /// <summary>The window: shows web/ in WebView2 and does what a page cannot (UDP discovery, window chrome).</summary>
    sealed class MainForm : Form
    {
        const int MinW = 420, MinH = 560;   // the web UI is laid out down to 375 px
        // the page's palette (web/style.css); dev/check-palette.mjs keeps the two equal
        static readonly Color PaperLight = Color.FromArgb(0xEE, 0xF0, 0xF3), PaperDark = Color.FromArgb(0x15, 0x18, 0x1E);
        static readonly Color SurfaceLight = Color.FromArgb(0xFF, 0xFF, 0xFF), SurfaceDark = Color.FromArgb(0x1D, 0x21, 0x29);
        static readonly Color InkLight = Color.FromArgb(0x14, 0x18, 0x21), InkDark = Color.FromArgb(0xED, 0xEF, 0xF3);
        static readonly Color Ink2Light = Color.FromArgb(0x5B, 0x62, 0x72), Ink2Dark = Color.FromArgb(0x9C, 0xA3, 0xB1);
        static readonly Color LineLight = Color.FromArgb(0xDC, 0xE0, 0xE6), LineDark = Color.FromArgb(0x31, 0x37, 0x44);
        static readonly Color Lamp = Color.FromArgb(0xF4, 0xAE, 0x00), LampPress = Color.FromArgb(0xDB, 0x9C, 0x00);
        const string WebView2Download = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";   // official Evergreen bootstrapper

        readonly string home = Program.Home;

        /// <summary>Screenshots go to Pictures\PhoneShare, recordings to Videos\PhoneShare (or under PHONESHARE_HOME).</summary>
        static string SaveFolder(string file)
        {
            bool video = string.Equals(Path.GetExtension(file), ".webm", StringComparison.OrdinalIgnoreCase);
            if (!string.IsNullOrEmpty(Program.HomeOverride)) return Path.Combine(Program.HomeOverride, video ? "Recordings" : "Screenshots");
            return Path.Combine(Environment.GetFolderPath(video ? Environment.SpecialFolder.MyVideos : Environment.SpecialFolder.MyPictures), "PhoneShare");
        }

        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        readonly AssetServer server = new AssetServer();
        string origin = "";
        string screen = "home";
        bool fullscreen;
        FormWindowState savedState;
        Rectangle savedBounds;
        int discovering;
        Updater.Release offer;   // a checked newer release, kept for the "update" click
        int updating;
        readonly System.Windows.Forms.Timer updateTimer = new System.Windows.Forms.Timer { Interval = 6 * 3600 * 1000 };

        public MainForm()
        {
            Text = "PhoneShare";
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;   // sizes are scaled by hand from DeviceDpi
            BackColor = DarkTheme() ? PaperDark : PaperLight;   // no white frame before the page paints
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);
            LoadPlacement();
            SystemEvents.UserPreferenceChanged += OnThemeChanged;
        }

        float Scale1 => DeviceDpi / 96f;

        // ---------------------------------------------------------------- startup

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            try
            {
                origin = "http://127.0.0.1:" + server.Start();
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(home, "WebView2"),
                    new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"));
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                ShowStartError(ex);
                return;
            }
            SetUpWeb(web.CoreWebView2);
        }

        void SetUpWeb(CoreWebView2 core)
        {
            var s = core.Settings;
            s.AreDefaultContextMenusEnabled = false;
            s.AreDevToolsEnabled = Environment.GetEnvironmentVariable("PHONESHARE_DEVTOOLS") == "1";
            s.IsStatusBarEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsPinchZoomEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;

            core.DocumentTitleChanged += (o, a) => Text = string.IsNullOrEmpty(core.DocumentTitle) ? "PhoneShare" : core.DocumentTitle;
            core.ContainsFullScreenElementChanged += (o, a) => SetFullscreen(core.ContainsFullScreenElement);
            core.WebMessageReceived += OnPageMessage;

            // Only our own page lives in the window; anything else goes to the default browser.
            core.NavigationStarting += (o, a) =>
            {
                if (IsOwn(a.Uri)) return;
                a.Cancel = true;
                OpenExternal(a.Uri);
            };
            core.NewWindowRequested += (o, a) =>
            {
                a.Handled = true;
                if (!IsOwn(a.Uri)) OpenExternal(a.Uri);
            };

            // Screenshots and recordings: straight into Pictures / Videos, without the download flyout.
            core.DownloadStarting += (o, a) =>
            {
                string name = Path.GetFileName(a.ResultFilePath), dir = SaveFolder(name);
                Directory.CreateDirectory(dir);
                a.ResultFilePath = Path.Combine(dir, name);
                a.Handled = true;
            };

            // ponytail: UnknownPermission covers Chromium prompts this SDK has no kind for (local network access);
            // allowed only for our own page, everything else (camera, mic, location) is denied.
            core.PermissionRequested += (o, a) =>
            {
                var k = a.PermissionKind;
                bool ok = IsOwn(a.Uri) && (k == CoreWebView2PermissionKind.MultipleAutomaticDownloads
                    || k == CoreWebView2PermissionKind.Autoplay || k == CoreWebView2PermissionKind.UnknownPermission);
                a.State = ok ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
            };

            core.ProcessFailed += (o, a) =>
            {
                if (a.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited
                    || a.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive) core.Reload();
            };

            core.Navigate(origin + "/");
        }

        bool IsOwn(string uri) => uri == origin || (uri ?? "").StartsWith(origin + "/", StringComparison.Ordinal);

        static void OpenExternal(string uri)
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var u) || (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps)) return;
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception || ex is InvalidOperationException) { }
        }

        // ---------------------------------------------------------------- page bridge (specs/001-windows-receiver/contracts/host-bridge.md)

        void OnPageMessage(object sender, CoreWebView2WebMessageReceivedEventArgs a)
        {
            if (!IsOwn(a.Source)) return;
            string m;
            try { m = a.TryGetWebMessageAsString(); }
            catch (ArgumentException) { return; }   // not a string: not ours

            if (m == "hello")
            {
                Post(new Dictionary<string, object> { ["t"] = "host", ["name"] = Environment.MachineName, ["nets"] = Networks(), ["version"] = Updater.Current.ToString() });
                Hello();
            }
            else if (m == "update") ApplyUpdate();
            else if (m == "discover") Discover();
            else if (m == "miracast?" || m == "miracast") Miracast(open: m == "miracast");
            else if (m == "ontop:1" || m == "ontop:0") TopMost = m == "ontop:1";
            else if (m.StartsWith("screen:", StringComparison.Ordinal))
            {
                screen = m.Substring(7);
                PaintChrome();
            }
        }

        void Post(object message)
        {
            string json = new JavaScriptSerializer().Serialize(message);
            void Send() { if (!IsDisposed && web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(json); }
            if (!InvokeRequired) { Send(); return; }
            try { BeginInvoke((Action)Send); }
            catch (InvalidOperationException) { }   // window already closed
        }

        // ---------------------------------------------------------------- updates (Updater.cs)

        /// <summary>The page is up (again, after a reload): report how the last update went, look for a new one now and every 6 h.</summary>
        void Hello()
        {
            string a = Program.Args.FirstOrDefault();
            if (a == "--updated" || a == "--update-failed")
            {
                Program.Args = new string[0];
                Updater.Finish();
                Post(new Dictionary<string, object> { ["t"] = "updated", ["ok"] = a == "--updated", ["version"] = Updater.Current.ToString() });
            }
            if (!updateTimer.Enabled)
            {
                updateTimer.Tick += (o, e) => CheckUpdate();
                updateTimer.Start();
            }
            CheckUpdate();
        }

        void CheckUpdate()
        {
            if (Volatile.Read(ref updating) == 1) return;
            Task.Run(() =>
            {
                try
                {
                    Updater.Release r = Updater.Check();
                    if (r == null) { Post(new Dictionary<string, object> { ["t"] = "update", ["latest"] = true }); return; }
                    offer = r;
                    Post(new Dictionary<string, object> { ["t"] = "update", ["version"] = r.Version.ToString() });
                }
                catch (Exception ex) when (ex is IOException || ex is InvalidDataException || ex is FormatException
                    || ex is KeyNotFoundException || ex is InvalidCastException || ex is ArgumentException || ex is CryptographicException)
                {
                    Post(new Dictionary<string, object> { ["t"] = "update", ["checkError"] = ex.Message });   // silent on the page, kept in its stats
                }
            });
        }

        void ApplyUpdate()
        {
            Updater.Release r = offer;
            if (r == null || Interlocked.Exchange(ref updating, 1) == 1) return;
            string v = r.Version.ToString();
            Task.Run(() =>
            {
                try
                {
                    int last = -1;
                    string file = Updater.Download(r, p => { if (p != last) { last = p; Post(new Dictionary<string, object> { ["t"] = "update", ["version"] = v, ["progress"] = p }); } });
                    Updater.Run(file);
                    BeginInvoke((Action)Close);
                }
                catch (Exception ex) when (ex is IOException || ex is InvalidDataException || ex is UnauthorizedAccessException
                    || ex is System.ComponentModel.Win32Exception || ex is InvalidOperationException)
                {
                    Volatile.Write(ref updating, 0);
                    Post(new Dictionary<string, object> { ["t"] = "update", ["version"] = v, ["error"] = ex.Message });
                }
            });
        }

        void Discover()
        {
            if (Interlocked.Exchange(ref discovering, 1) == 1) return;   // one search at a time
            Task.Run(() =>
            {
                try { Post(new Dictionary<string, object> { ["t"] = "devices", ["list"] = Discovery.Find(1000) }); }
                catch (SocketException) { }   // no network at all: the page keeps its saved list
                finally { Volatile.Write(ref discovering, 0); }
            });
        }

        /// <summary>Finds Windows' Miracast receiver off the UI thread; on "miracast" also opens it (or Settings to install it).</summary>
        void Miracast(bool open)
        {
            Task.Run(() =>
            {
                string aumid = MiracastReceiver.Find();
                var reply = new Dictionary<string, object> { ["t"] = "miracast", ["installed"] = aumid != null };
                if (open) reply["opened"] = MiracastReceiver.Open(aumid);
                Post(reply);
            });
        }

        /// <summary>
        /// The PC's own networks for the "phone is missing" help: adapters with a gateway (host-only and most virtual ones have none),
        /// named as Windows names the network (usually the Wi-Fi name), else by the adapter.
        /// </summary>
        static List<Dictionary<string, object>> Networks()
        {
            var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // adapter id -> network name
            try
            {
                dynamic nlm = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DCB00C01-570F-4A9B-8D69-199FDBA5723B")));
                foreach (dynamic net in nlm.GetNetworks(1))   // NLM_ENUM_NETWORK_CONNECTED
                {
                    string name = net.GetName();
                    foreach (dynamic conn in net.GetNetworkConnections()) names[((Guid)conn.GetAdapterId()).ToString("B")] = name;
                }
            }
            catch (Exception ex) when (ex is COMException || ex is InvalidCastException || ex is ArgumentException
                || ex is Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { }   // adapter names below still help

            var list = new List<Dictionary<string, object>>();
            foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                IPInterfaceProperties props = ni.GetIPProperties();
                if (!props.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any))) continue;
                UnicastIPAddressInformation ip = props.UnicastAddresses.FirstOrDefault(u => u.Address.AddressFamily == AddressFamily.InterNetwork);
                if (ip == null) continue;
                list.Add(new Dictionary<string, object>
                {
                    ["name"] = names.TryGetValue(ni.Id, out string n) ? n : ni.Name,
                    ["ip"] = ip.Address.ToString(),
                });
            }
            return list;
        }

        // ---------------------------------------------------------------- window chrome

        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_CAPTION_COLOR = 35, DWMWA_TEXT_COLOR = 36;

        static bool DarkTheme()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                return k?.GetValue("AppsUseLightTheme") is int v && v == 0;
        }

        /// <summary>Title bar takes the colour of the screen under it: paper on the list and PIN, black in the player.</summary>
        void PaintChrome()
        {
            if (!IsHandleCreated) return;
            bool dark = DarkTheme(), player = screen == "player";
            Color caption = player ? Color.Black : dark ? PaperDark : PaperLight;
            int darkMode = player || dark ? 1 : 0, cap = ColorRef(caption), text = ColorRef(player || dark ? InkDark : InkLight);
            DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref darkMode, 4);
            DwmSetWindowAttribute(Handle, DWMWA_CAPTION_COLOR, ref cap, 4);   // Windows 11; Windows 10 ignores it
            DwmSetWindowAttribute(Handle, DWMWA_TEXT_COLOR, ref text, 4);
        }

        static int ColorRef(Color c) => c.R | c.G << 8 | c.B << 16;

        void OnThemeChanged(object sender, UserPreferenceChangedEventArgs e)
        {
            if (e.Category != UserPreferenceCategory.General && e.Category != UserPreferenceCategory.VisualStyle && e.Category != UserPreferenceCategory.Color) return;
            try { BeginInvoke((Action)(() => { BackColor = DarkTheme() ? PaperDark : PaperLight; PaintChrome(); })); }
            catch (InvalidOperationException) { }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            PaintChrome();
            SetIcons();
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr hInst, IntPtr name, int type, int cx, int cy, int flags);
        [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(IntPtr name);
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

        /// <summary>Sharp taskbar and title icons at any DPI, picked from the exe's own icon resource.</summary>
        void SetIcons()
        {
            const int IMAGE_ICON = 1, WM_SETICON = 0x80, IconResource = 32512;   // csc stores ApplicationIcon under 32512
            IntPtr module = GetModuleHandle(IntPtr.Zero);
            int small = (int)Math.Round(16 * Scale1), big = (int)Math.Round(32 * Scale1);
            IntPtr hs = LoadImage(module, (IntPtr)IconResource, IMAGE_ICON, small, small, 0);
            IntPtr hb = LoadImage(module, (IntPtr)IconResource, IMAGE_ICON, big, big, 0);
            if (hb == IntPtr.Zero) { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); return; }
            Icon = Icon.FromHandle(hb);
            if (hs != IntPtr.Zero) SendMessage(Handle, WM_SETICON, IntPtr.Zero, hs);
        }

        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            MinimumSize = new Size((int)(MinW * Scale1), (int)(MinH * Scale1));
        }

        // ---------------------------------------------------------------- fullscreen

        void SetFullscreen(bool on)
        {
            if (on == fullscreen) return;
            fullscreen = on;
            if (on)
            {
                savedState = WindowState;
                savedBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Normal;
                Bounds = Screen.FromControl(this).Bounds;   // covers the taskbar too
            }
            else
            {
                FormBorderStyle = FormBorderStyle.Sizable;
                Bounds = savedBounds;
                WindowState = savedState;
                PaintChrome();
            }
        }

        // ---------------------------------------------------------------- size and place, kept between runs

        string PlacementFile => Path.Combine(home, "window.txt");

        void LoadPlacement()
        {
            MinimumSize = new Size((int)(MinW * Scale1), (int)(MinH * Scale1));
            try
            {
                int[] p = File.ReadAllText(PlacementFile).Trim().Split(' ').Select(int.Parse).ToArray();
                var r = new Rectangle(p[0], p[1], p[2], p[3]);
                if (p.Length == 5 && r.Width >= MinimumSize.Width && r.Height >= MinimumSize.Height
                    && Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(r)))
                {
                    Bounds = r;
                    if (p[4] == 1) WindowState = FormWindowState.Maximized;
                    return;
                }
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is FormatException
                || ex is OverflowException || ex is IndexOutOfRangeException) { }

            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int w = Math.Min((int)(1024 * Scale1), wa.Width), h = Math.Min((int)(720 * Scale1), wa.Height);
            Bounds = new Rectangle(wa.X + (wa.Width - w) / 2, wa.Y + (wa.Height - h) / 2, w, h);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            Rectangle r = fullscreen ? savedBounds : WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            bool max = fullscreen ? savedState == FormWindowState.Maximized : WindowState == FormWindowState.Maximized;
            try
            {
                Directory.CreateDirectory(home);
                File.WriteAllText(PlacementFile, $"{r.X} {r.Y} {r.Width} {r.Height} {(max ? 1 : 0)}");
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { }
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            SystemEvents.UserPreferenceChanged -= OnThemeChanged;   // static event: unhook or the form leaks
            updateTimer.Dispose();
            server.Stop();
            base.OnFormClosed(e);
        }

        // ---------------------------------------------------------------- no WebView2

        void ShowStartError(Exception ex)
        {
            bool missing = ex is WebView2RuntimeNotFoundException;
            bool webview = missing || !(ex is IOException);
            Controls.Remove(web);
            web.Dispose();

            float k = Scale1;
            bool dark = DarkTheme();
            Color ink = dark ? InkDark : InkLight, ink2 = dark ? Ink2Dark : Ink2Light;
            int textWidth = (int)(440 * k);

            var title = new Label
            {
                AutoSize = true, MaximumSize = new Size(textWidth, 0), ForeColor = ink,
                Font = new Font("Bahnschrift SemiBold", 20f), Margin = new Padding(0, 0, 0, (int)(10 * k)),
                Text = missing ? "Для PhoneShare нужен WebView2" : webview ? "WebView2 не запустился" : "PhoneShare не запустился",
            };
            var body = new Label
            {
                AutoSize = true, MaximumSize = new Size(textWidth, 0), ForeColor = ink,
                Font = new Font("Segoe UI", 10.5f), Margin = new Padding(0, 0, 0, (int)(8 * k)),
                Text = missing
                    ? "Это компонент Windows от Microsoft. Через него PhoneShare показывает экран телефона. "
                      + "В Windows 11 он уже есть, в Windows 10 его ставят один раз, бесплатно. После установки запусти PhoneShare снова."
                    : webview
                        ? "PhoneShare показывает экран телефона через компонент Windows WebView2, и он не запустился. "
                          + "Переустанови его по кнопке ниже и запусти PhoneShare снова."
                        : "Не получилось занять порт на этом компьютере. Закрой лишние окна PhoneShare и запусти его снова.",
            };
            var stack = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = Color.Transparent };
            stack.Controls.Add(title);
            stack.Controls.Add(body);
            if (!missing)
            {
                stack.Controls.Add(new Label
                {
                    AutoSize = true, MaximumSize = new Size(textWidth, 0), ForeColor = ink2,
                    Font = new Font("Segoe UI", 9f), Margin = new Padding(0, 0, 0, (int)(8 * k)), Text = ex.Message,
                });
            }

            var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Margin = new Padding(0, (int)(16 * k), 0, 0) };
            Button MakeButton(string text, bool primary)
            {
                var b = new Button
                {
                    Text = text, AutoSize = true, FlatStyle = FlatStyle.Flat, UseVisualStyleBackColor = false,
                    Font = new Font("Segoe UI Semibold", 10.5f), MinimumSize = new Size(0, (int)(44 * k)),
                    Padding = new Padding((int)(14 * k), 0, (int)(14 * k), 0), Margin = new Padding(0, 0, (int)(8 * k), 0),
                    BackColor = primary ? Lamp : dark ? SurfaceDark : SurfaceLight, ForeColor = primary ? InkLight : ink, Cursor = Cursors.Hand,
                };
                b.FlatAppearance.BorderSize = primary ? 0 : 1;
                b.FlatAppearance.BorderColor = dark ? LineDark : LineLight;
                b.FlatAppearance.MouseOverBackColor = primary ? LampPress : b.BackColor;
                buttons.Controls.Add(b);
                return b;
            }
            if (webview)
            {
                var download = MakeButton("Скачать WebView2", true);
                download.Click += (o, a) => OpenExternal(WebView2Download);
                AcceptButton = download;
            }
            var close = MakeButton("Закрыть", !webview);
            close.Click += (o, a) => Close();
            CancelButton = close;
            stack.Controls.Add(buttons);

            var page = new Panel { Dock = DockStyle.Fill, BackColor = dark ? PaperDark : PaperLight };
            page.Controls.Add(stack);
            void Center() => stack.Location = new Point(Math.Max((int)(24 * k), (page.Width - stack.Width) / 2), Math.Max((int)(24 * k), (page.Height - stack.Height) / 2 - (int)(24 * k)));
            page.Resize += (o, a) => Center();
            stack.SizeChanged += (o, a) => Center();
            Controls.Add(page);
            Center();
            (AcceptButton as Control ?? close).Focus();
        }
    }

    /// <summary>Serves the embedded web/ files to the window on 127.0.0.1 (a secure context, so WebCodecs works).</summary>
    sealed class AssetServer
    {
        public const int FirstPort = 47810;
        static readonly Regex AssetName = new Regex("^[A-Za-z0-9._-]+$");
        static readonly Regex RequestLine = new Regex(@"^(GET|HEAD) (/[^ ?#]*)\S* HTTP/1\.[01]\r\n");
        TcpListener listener;

        /// <summary>The port is fixed because the page origin, and with it the saved phones and PINs, depends on it.</summary>
        public int Start()
        {
            // ponytail: a second copy of the app lands on the next port, a different origin with an empty phone list
            for (int port = FirstPort; port < FirstPort + 10; port++)
            {
                var l = new TcpListener(IPAddress.Loopback, port) { ExclusiveAddressUse = true };
                try { l.Start(); }
                catch (SocketException) { continue; }
                listener = l;
                new Thread(AcceptLoop) { IsBackground = true, Name = "ps-http" }.Start();
                return port;
            }
            throw new IOException($"Порты {FirstPort}–{FirstPort + 9} на 127.0.0.1 заняты.");
        }

        public void Stop() => listener?.Stop();

        void AcceptLoop()
        {
            while (true)
            {
                TcpClient c;
                try { c = listener.AcceptTcpClient(); }
                catch (Exception ex) when (ex is SocketException || ex is ObjectDisposedException || ex is InvalidOperationException) { return; }
                ThreadPool.QueueUserWorkItem(_ => Serve(c));
            }
        }

        static void Serve(TcpClient c)
        {
            using (c)
            {
                try
                {
                    c.ReceiveTimeout = 5000;
                    c.SendTimeout = 5000;
                    NetworkStream s = c.GetStream();
                    string head = ReadHead(s);
                    if (head == null) return;
                    Match m = RequestLine.Match(head);
                    byte[] body = null;
                    string name = "";
                    if (m.Success)
                    {
                        name = m.Groups[2].Value.Substring(1);
                        if (name.Length == 0) name = "index.html";
                        if (AssetName.IsMatch(name)) body = Asset(name);
                    }
                    Respond(s, body, name, m.Success && m.Groups[1].Value == "HEAD");
                }
                catch (Exception ex) when (ex is IOException || ex is SocketException || ex is ObjectDisposedException) { }
            }
        }

        /// <summary>Request line and headers, at most 8 KB; null if the client sends more or nothing.</summary>
        static string ReadHead(Stream s)
        {
            var buf = new byte[8192];
            int n = 0;
            while (n < buf.Length)
            {
                int r = s.Read(buf, n, buf.Length - n);
                if (r <= 0) return null;
                n += r;
                string text = Encoding.ASCII.GetString(buf, 0, n);
                if (text.Contains("\r\n\r\n")) return text;
            }
            return null;
        }

        static byte[] Asset(string name)
        {
            using (Stream r = typeof(AssetServer).Assembly.GetManifestResourceStream("web/" + name))
            {
                if (r == null) return null;
                var ms = new MemoryStream();
                r.CopyTo(ms);
                return ms.ToArray();
            }
        }

        static string ContentType(string name)
        {
            switch (Path.GetExtension(name).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".js": return "text/javascript; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".ico": return "image/x-icon";
                default: return "application/octet-stream";
            }
        }

        static void Respond(Stream s, byte[] body, string name, bool headOnly)
        {
            bool ok = body != null;
            if (!ok) body = Encoding.UTF8.GetBytes("Not found");
            string head = (ok ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found") + "\r\n"
                + "Content-Type: " + (ok ? ContentType(name) : "text/plain; charset=utf-8") + "\r\n"
                + "Content-Length: " + body.Length + "\r\n"
                + "Cache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
            byte[] h = Encoding.ASCII.GetBytes(head);
            s.Write(h, 0, h.Length);
            if (!headOnly) s.Write(body, 0, body.Length);
        }
    }

    /// <summary>Windows' own Miracast receiver: "Wireless Display" (Windows 11 optional feature) or "Connect" (Windows 10).</summary>
    static class MiracastReceiver
    {
        static readonly Regex AumidHint = new Regex("WirelessDisplay|PPIProjection|Miracast", RegexOptions.IgnoreCase);
        static readonly string[] Names = { "Wireless Display", "Беспроводной дисплей", "Connect", "Подключить" };

        /// <summary>AUMID of the receiver app from the Start menu's app list (no admin rights needed), or null if it is not installed.</summary>
        public static string Find()
        {
            string found = null;
            var t = new Thread(() =>   // Shell.Application wants an STA thread
            {
                try
                {
                    dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
                    foreach (dynamic item in shell.NameSpace("shell:AppsFolder").Items())
                    {
                        string path = item.Path, name = item.Name;
                        if (string.IsNullOrEmpty(path)) continue;
                        // ponytail: the exact AUMID is undocumented, so a few hints; add one here if a Windows build renames the app
                        if (AumidHint.IsMatch(path) || (path.StartsWith("Microsoft", StringComparison.OrdinalIgnoreCase)
                            && Names.Contains(name, StringComparer.OrdinalIgnoreCase)))
                        {
                            found = path;
                            break;
                        }
                    }
                }
                // best effort: any failure means "not found". The app list changes under the loop while an installer adds
                // shortcuts (InvalidComObjectException right after the MSI starts PhoneShare), and on this thread an
                // exception would end the whole process
                catch (Exception) { }
            }) { IsBackground = true };
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join(5000);
            return found;
        }

        /// <summary>Opens the receiver, or the "Projecting to this PC" settings page where the feature is added.</summary>
        public static string Open(string aumid)
        {
            try
            {
                if (aumid != null) Process.Start("explorer.exe", "shell:AppsFolder\\" + aumid);
                else Process.Start(new ProcessStartInfo("ms-settings:project") { UseShellExecute = true });
                return aumid != null ? "receiver" : "settings";
            }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception || ex is InvalidOperationException) { return "failed"; }
        }
    }

    /// <summary>Finds phones by UDP broadcast; each running PhoneShare answers with its name and HTTP port.</summary>
    static class Discovery
    {
        public const int Port = 47800;
        static readonly byte[] Query = Encoding.ASCII.GetBytes("PHONESHARE?");

        public static List<Dictionary<string, object>> Find(int ms)
        {
            var found = new Dictionary<string, Dictionary<string, object>>();
            using (var udp = new UdpClient(new IPEndPoint(IPAddress.Any, 0)))
            {
                udp.EnableBroadcast = true;
                const int SIO_UDP_CONNRESET = -1744830452;
                udp.Client.IOControl(SIO_UDP_CONNRESET, new byte[] { 0 }, null);   // an ICMP "port unreachable" must not end the search
                foreach (IPAddress target in Targets())
                {
                    try { udp.Send(Query, Query.Length, new IPEndPoint(target, Port)); }
                    catch (SocketException) { }   // that adapter cannot broadcast; the others still can
                }
                var json = new JavaScriptSerializer();
                DateTime end = DateTime.UtcNow.AddMilliseconds(ms);
                while (true)
                {
                    int left = (int)(end - DateTime.UtcNow).TotalMilliseconds;
                    if (left <= 0) break;
                    udp.Client.ReceiveTimeout = left;
                    IPEndPoint from = null;
                    byte[] data;
                    try { data = udp.Receive(ref from); }
                    catch (SocketException e) when (e.SocketErrorCode == SocketError.TimedOut) { break; }
                    catch (SocketException) { continue; }
                    KeyValuePair<string, Dictionary<string, object>> d = Parse(json, data, from);
                    // the same phone answering through two of our adapters keeps its first (fastest) address
                    if (d.Key != null && !found.ContainsKey(d.Key)) found[d.Key] = d.Value;
                }
            }
            return found.Values.ToList();
        }

        /// <summary>255.255.255.255 leaves through one adapter only, so every adapter's own broadcast address is added (VPN, virtual).</summary>
        static IEnumerable<IPAddress> Targets()
        {
            var set = new HashSet<IPAddress> { IPAddress.Broadcast };
            foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (UnicastIPAddressInformation ua in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ua.Address.AddressFamily != AddressFamily.InterNetwork || ua.IPv4Mask == null) continue;
                    byte[] ip = ua.Address.GetAddressBytes(), mask = ua.IPv4Mask.GetAddressBytes();
                    for (int i = 0; i < 4; i++) ip[i] |= (byte)~mask[i];
                    set.Add(new IPAddress(ip));
                }
            }
            return set;
        }

        /// <summary>Reply from the network, so untrusted: {"t":"phoneshare","v":1,"id":"…","name":"…","port":8080}.
        /// Key: the phone's run id, or host:port for a phone without one.</summary>
        static KeyValuePair<string, Dictionary<string, object>> Parse(JavaScriptSerializer json, byte[] data, IPEndPoint from)
        {
            var none = default(KeyValuePair<string, Dictionary<string, object>>);
            if (data.Length > 2048) return none;
            Dictionary<string, object> m;
            try { m = json.DeserializeObject(Encoding.UTF8.GetString(data)) as Dictionary<string, object>; }
            catch (Exception ex) when (ex is ArgumentException || ex is InvalidOperationException) { return none; }
            if (m == null || !(m.TryGetValue("t", out object t) && "phoneshare".Equals(t))) return none;
            if (!(m.TryGetValue("port", out object p) && p is int port && port > 0 && port < 65536)) return none;
            string name = m.TryGetValue("name", out object n) && n is string s && s.Trim().Length > 0 ? s.Trim() : from.Address.ToString();
            if (name.Length > 64) name = name.Substring(0, 64);
            string host = from.Address.ToString();
            string key = m.TryGetValue("id", out object i) && i is string id && Regex.IsMatch(id, "^[0-9a-f]{1,16}$") ? id : host + ":" + port;
            return new KeyValuePair<string, Dictionary<string, object>>(key, new Dictionary<string, object> { ["host"] = host, ["port"] = port, ["name"] = name });
        }
    }
}
