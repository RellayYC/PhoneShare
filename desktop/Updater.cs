using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace PhoneShare
{
    /// <summary>
    /// Updates from GitHub Releases: Url is .../releases/latest/download, where installer/release.mjs puts the MSI, the bare exe,
    /// the APK and latest.txt, the release JSON plus its ECDSA P-256 signature (key in W:\Keys\PhoneShare\signing.pem). The files
    /// are public; the signature is the guard, and nothing it does not cover is run. An installed copy takes the MSI, a portable
    /// one just the new exe: it needs no Windows Installer at all.
    /// </summary>
    static class Updater
    {
        const string DefaultUrl = "https://github.com/RellayYC/PhoneShare/releases/latest/download";
        const string PublicKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEnd/400xe/oR7dSpH8ZFm8igPbylKaWcIf8lKOz6uJ28PVax/gS1Ov5KJ0py0CJK15PThSDghkcVm0JqjQGfKZg==";

        // PHONESHARE_UPDATE_URL points a test at a local server; the signature check stays the same
        static string Url => (Environment.GetEnvironmentVariable("PHONESHARE_UPDATE_URL") is string u && u.Length > 0 ? u : DefaultUrl).TrimEnd('/');

        public sealed class Release
        {
            public Version Version;
            public string File, Sha256;
        }

        public static Version Current => new Version(typeof(Updater).Assembly.GetName().Version.ToString(3));

        /// <summary>This copy is the one the MSI put in place (HKCU\Software\PhoneShare\Setup); any other is portable.</summary>
        static bool Installed
        {
            get
            {
                string dir = Registry.GetValue(@"HKEY_CURRENT_USER\Software\PhoneShare\Setup", "InstallDir", null) as string;
                return dir != null && string.Equals(dir.TrimEnd('\\'), Path.GetDirectoryName(Exe), StringComparison.OrdinalIgnoreCase);
            }
        }

        static string Exe => System.Windows.Forms.Application.ExecutablePath;

        /// <summary>Where the download waits until the script runs; emptied on the first start after an update.</summary>
        static string Cache => Path.Combine(Program.Home, "Update");

        static HttpWebResponse Get(string name)
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;   // GitHub refuses older TLS
            var req = (HttpWebRequest)WebRequest.Create(Url + "/" + name);    // follows GitHub's redirect to its file storage
            req.UserAgent = "PhoneShare/" + Current;
            req.Timeout = 15000;
            req.ReadWriteTimeout = 30000;
            try { return (HttpWebResponse)req.GetResponse(); }
            catch (WebException e) when (e.Response is HttpWebResponse r)
            {
                r.Dispose();
                throw new IOException($"Сервер обновлений ответил ошибкой {(int)r.StatusCode}. Попробуй позже.", e);
            }
            catch (WebException e) { throw new IOException("Не удалось связаться с сервером обновлений. Проверь интернет.", e); }
        }

        /// <summary>The signed release if it is newer than this build, else null.</summary>
        public static Release Check()
        {
            string text;
            using (var res = Get("latest.txt"))
            using (var rd = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) text = rd.ReadToEnd();
            string[] lines = text.Split('\n');
            Release r = null;
            try { if (lines.Length >= 2) r = Verify(Encoding.UTF8.GetBytes(lines[0]), Convert.FromBase64String(lines[1].Trim())); }
            catch (FormatException) { }
            if (r == null) throw new InvalidDataException("Подпись обновления не сходится, обновление отклонено.");
            return r.Version > Current ? r : null;
        }

        static Release Verify(byte[] json, byte[] sig)
        {
            // SubjectPublicKeyInfo of a P-256 key ends with 04 || X || Y; .NET Framework has no SPKI import, so the point goes in by hand
            byte[] spki = Convert.FromBase64String(PublicKey);
            var p = new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                Q = new ECPoint { X = spki.Skip(spki.Length - 64).Take(32).ToArray(), Y = spki.Skip(spki.Length - 32).ToArray() },
            };
            using (ECDsa ec = ECDsa.Create(p))
                if (!ec.VerifyData(json, sig, HashAlgorithmName.SHA256)) return null;
            var m = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(json));
            bool msi = Installed;
            return new Release
            {
                Version = new Version((string)m["version"]),
                File = Path.GetFileName((string)m[msi ? "msi" : "exe"]),
                Sha256 = (string)m[msi ? "sha256" : "exeSha256"],
            };
        }

        /// <summary>Downloads the MSI (or the exe) and checks its hash; nothing is left behind if that fails.</summary>
        public static string Download(Release r, Action<int> percent)
        {
            if (Directory.Exists(Cache)) Directory.Delete(Cache, true);
            string path = Path.Combine(Directory.CreateDirectory(Cache).FullName, r.File);
            try
            {
                using (var res = Get(r.File))
                using (Stream src = res.GetResponseStream())
                using (FileStream dst = File.Create(path))
                {
                    long total = res.ContentLength;
                    var buf = new byte[1 << 16];
                    for (int n; (n = src.Read(buf, 0, buf.Length)) > 0;)
                    {
                        dst.Write(buf, 0, n);
                        if (total > 0) percent((int)(dst.Length * 100 / total));
                    }
                }
                string hash;
                using (var sha = SHA256.Create())
                using (FileStream f = File.OpenRead(path)) hash = BitConverter.ToString(sha.ComputeHash(f)).Replace("-", "");
                if (!hash.Equals(r.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Скачанный файл повреждён: контрольная сумма не совпала.");
                return path;
            }
            catch
            {
                File.Delete(path);
                throw;
            }
        }

        // waits for PhoneShare to exit, then: installed copy - MSI upgrade with a progress bar only; portable copy - the new exe
        // over the old one (retried while Windows still holds the file). Either way PhoneShare starts again and is told how it went.
        // Paths reach the script through the environment, never through its text.
        const string Script = @"
Wait-Process -Id $env:PS_PID -ErrorAction SilentlyContinue
$ok = $false
if ($env:PS_PORTABLE) {
    for ($i = 0; -not $ok -and $i -lt 20; $i++) {
        try { Copy-Item $env:PS_FILE $env:PS_EXE -Force -ErrorAction Stop; $ok = $true } catch { Start-Sleep -Milliseconds 500 }
    }
} else {
    $p = Start-Process msiexec.exe -ArgumentList '/i', ('""' + $env:PS_FILE + '""'), '/passive', '/norestart' -Wait -PassThru
    $ok = $p.ExitCode -in 0, 3010
}
Start-Process $env:PS_EXE -ArgumentList $(if ($ok) { '--updated' } else { '--update-failed' })
";

        /// <summary>Hands the downloaded file to the script above; the caller quits right after.</summary>
        public static void Run(string file)
        {
            var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
                + Convert.ToBase64String(Encoding.Unicode.GetBytes(Script))) { UseShellExecute = false, CreateNoWindow = true };
            psi.EnvironmentVariables["PS_FILE"] = file;
            psi.EnvironmentVariables["PS_EXE"] = Exe;
            psi.EnvironmentVariables["PS_PID"] = Process.GetCurrentProcess().Id.ToString();
            psi.EnvironmentVariables["PS_PORTABLE"] = Installed ? "" : "1";
            Process.Start(psi).Dispose();
        }

        /// <summary>First start after the script: the downloaded MSI is not needed any more.</summary>
        public static void Finish()
        {
            try { if (Directory.Exists(Cache)) Directory.Delete(Cache, true); }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { }
        }
    }
}
