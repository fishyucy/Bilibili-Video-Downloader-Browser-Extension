// ===========================================================================
// 查找并安装本机可用的 FFmpeg
// Locate a usable local FFmpeg and install it into native-host\bin\
//
// 存在的意义：install.cmd 里自动下载 FFmpeg 经常会超时（尤其国内网络）。
// 与其干等，不如先在**本机**找一份能用的，复制进来即可。
// Why this exists: the automatic FFmpeg download in install.cmd often times out (especially on
// Chinese networks). Rather than waiting, look for a usable copy already on this machine and
// copy it into the host folder.
//
// ── 「可用」的判据 / What "usable" means here ──────────────────────────────
//   1. 能启动，且 -version 输出里含 "ffmpeg version"  →  是真正的 ffmpeg，不是坏文件
//   2. -encoders 里含 libmp3lame                     →  我们的 mp3 转码要用
//   能启动、且 -version 输出里含 "ffmpeg version"；     是真正的 ffmpeg，不是坏文件
//   -encoders 里含 libmp3lame —— 本项目的 mp3 转码要用。
//   It does NOT check "is this an official build": FFmpeg has countless builds (BtbN, gyan.dev,
//   various distros), so there is no universal hash to compare against.
//
// ── SHA-256 的用途 / What the SHA-256 is for ──────────────────────────────
//   · 去重     多个候选指向同一个文件时只保留一份
//   · 校验     复制完成后比对源与目标的哈希，确认复制完整
//   · 溯源     写进 bin\ffmpeg.source.txt，记下来源路径、时间、版本
//   (dedupe / verify the copy / keep a provenance record)
//
// 编译 / Build（由 build-host.cmd 一并完成）:
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /codepage:65001 ^
//       /optimize+ /target:exe /out:find-ffmpeg.exe find_ffmpeg.cs
//
// 用法 / Usage:
//   find-ffmpeg.exe                     交互式查找
//   find-ffmpeg.exe --check            只检查 native-host\bin 里那份是否可用（不交互）
//   find-ffmpeg.exe --path <文件或目录>  直接指定，跳过搜索
// ===========================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;

class FindFfmpeg
{
    // 扫描时的最大目录深度与要跳过的目录名
    // Scan depth cap and directory names to skip
    const int SCAN_DEPTH = 3;
    static readonly string[] SKIP_NAMES = {
        "windows", "$recycle.bin", "system volume information", "node_modules", ".git",
        "temp", "tmp", "cache", "winsxs", "assembly", "driverstore", "installer",
        "microsoft.net", "package cache", "nuget", "sdk", "amt", "servicing"
    };

    static string appDir;
    static string binDir;
    static string targetExe;
    static string sourceTxt;

    static int Main(string[] args)
    {
        appDir = AppDomain.CurrentDomain.BaseDirectory;
        // 允许从任意工作目录运行：统一以 exe 所在目录为准
        // Allow running from anywhere: everything is relative to the exe's own folder
        binDir = Path.Combine(appDir, "bin");
        targetExe = Path.Combine(binDir, "ffmpeg.exe");
        sourceTxt = Path.Combine(binDir, "ffmpeg.source.txt");

        string explicitPath = null;
        bool checkOnly = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--check") checkOnly = true;
            else if (args[i] == "--path" && i + 1 < args.Length) { explicitPath = args[i + 1]; i++; }
        }

        PrintHeader();

        // ---- 0) 已经装好且可用？直接收工 ----
        // ---- 0) Already installed and usable? Done. ----
        if (File.Exists(targetExe))
        {
            ProbeResult have = Probe(targetExe);
            if (have.Ok)
            {
                Console.WriteLine("native-host\\bin\\ffmpeg.exe 已存在且可用，无需操作。");
                Console.WriteLine("  native-host\\bin\\ffmpeg.exe is present and usable -- nothing to do.");
                Console.WriteLine();
                PrintProbe(targetExe, have);
                return 0;
            }
            Console.WriteLine("native-host\\bin\\ffmpeg.exe 存在但不可用，将重新查找。");
            Console.WriteLine("  It exists but is not usable; searching again.");
            Console.WriteLine("  原因 / reason: " + have.Error);
            Console.WriteLine();
        }

        if (checkOnly)
        {
            Console.WriteLine("--check：未找到可用的 native-host\\bin\\ffmpeg.exe");
            Console.WriteLine("--check: no usable native-host\\bin\\ffmpeg.exe");
            return 1;
        }

        // ---- 1) 收集候选 ----
        // ---- 1) Collect candidates ----
        List<string> found = new List<string>();

        if (!string.IsNullOrEmpty(explicitPath))
        {
            Console.WriteLine("[1/4] 使用指定的路径 / Using the path you gave: " + explicitPath);
            AddFromPath(explicitPath, found);
        }
        else
        {
            Console.WriteLine("[1/4] 搜索本机的 ffmpeg ...");
            Console.WriteLine("      Searching this machine for ffmpeg ...");
            Console.WriteLine();
            SearchMachine(found);
        }

        Console.WriteLine();
        if (found.Count == 0)
        {
            Console.WriteLine("未在本机找到可用的 FFmpeg。");
            Console.WriteLine("No usable FFmpeg found on this machine.");
            return ManualFallback();
        }

        // ---- 2) 逐个探测（顺带用 SHA-256 去重） ----
        // ---- 2) Probe each one (deduping by SHA-256 as we go) ----
        Console.WriteLine("[2/4] 校验候选 / Probing candidates ...");
        List<ProbeResult> usable = new List<ProbeResult>();
        List<string> seenHash = new List<string>();

        foreach (string c in found)
        {
            ProbeResult r = Probe(c);
            Console.Write("      ");
            Console.Write(c);
            Console.WriteLine();

            if (seenHash.Contains(r.Sha256))
            {
                Console.WriteLine("        -> 与已有候选内容相同（SHA-256 相同），跳过 / same content as an earlier one, skipped");
                continue;
            }
            seenHash.Add(r.Sha256);

            if (r.Ok)
            {
                Console.WriteLine("        -> 可用 ✅  版本 " + r.Version + "   " + r.SizeMb + " MB");
                Console.WriteLine("           SHA-256 " + r.Sha256);
                usable.Add(r);
            }
            else
            {
                Console.WriteLine("        -> 不可用 / unusable: " + r.Error);
            }
        }

        Console.WriteLine();
        if (usable.Count == 0)
        {
            Console.WriteLine("本机这些 ffmpeg 都不满足要求（需要能跑起来且带 libmp3lame）。");
            Console.WriteLine("None of them qualify (must run and carry libmp3lame).");
            return ManualFallback();
        }

        // ---- 3) 选一个并复制 ----
        // ---- 3) Pick one and copy it in ----
        ProbeResult chosen = usable[0];
        if (usable.Count > 1)
        {
            Console.WriteLine("找到 " + usable.Count + " 个可用候选，请选择：");
            Console.WriteLine("Found " + usable.Count + " usable candidates; pick one:");
            for (int i = 0; i < usable.Count; i++)
            {
                Console.WriteLine("  [" + (i + 1) + "] " + usable[i].Path);
                Console.WriteLine("      " + usable[i].Version + "   " + usable[i].SizeMb + " MB");
            }
            Console.Write("输入序号，回车用第 1 个 / number, Enter for the first: ");
            string line = Console.ReadLine();
            int pick;
            if (int.TryParse((line == null ? "" : line.Trim()), out pick) && pick >= 1 && pick <= usable.Count)
            {
                chosen = usable[pick - 1];
            }
        }

        Console.WriteLine();
        Console.WriteLine("[3/4] 安装到 native-host\\bin\\ ...");
        Console.WriteLine("      Installing into native-host\\bin\\ ...");
        if (!Install(chosen))
        {
            return 1;
        }

        Console.WriteLine();
        Console.WriteLine("[4/4] 完成。以后 host.exe 合并 / 转码时会自动用 native-host\\bin\\ffmpeg.exe。");
        Console.WriteLine("      Done. host.exe will now use native-host\\bin\\ffmpeg.exe automatically.");
        return 0;
    }

    // ------------------------------------------------------------------ 搜索
    // ------------------------------------------------------------------ Search
    static void SearchMachine(List<string> found)
    {
        // 1) 环境变量指定 / pointed to by an environment variable
        string env = Environment.GetEnvironmentVariable("BILIDL_FFMPEG");
        if (!string.IsNullOrEmpty(env))
        {
            Console.WriteLine("  · BILIDL_FFMPEG = " + env);
            AddFromPath(env, found);
        }

        // 2) 常见安装位置 / well-known install locations
        string[] guesses = {
            @"C:\ffmpeg\bin\ffmpeg.exe",
            @"C:\ffmpeg.exe",
            @"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
            @"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe",
            @"C:\ProgramData\chocolatey\bin\ffmpeg.exe",
            @"C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin\ffmpeg.exe"
        };
        Console.WriteLine("  · 常见安装位置 / common install paths");
        foreach (string g in guesses)
        {
            if (File.Exists(g)) Add(g, found);
        }

        // 用户级目录下的几个常见落点 / common per-user spots
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string[] userGuesses = {
            Path.Combine(local, @"Microsoft\WinGet\Links\ffmpeg.exe"),
            Path.Combine(userProfile, @"scoop\shims\ffmpeg.exe"),
            Path.Combine(local, @"Programs\ffmpeg\bin\ffmpeg.exe"),
            Path.Combine(userProfile, @"Downloads\ffmpeg\bin\ffmpeg.exe"),
            Path.Combine(userProfile, @"Desktop\ffmpeg\bin\ffmpeg.exe"),
            Path.Combine(local, @"Microsoft\WindowsApps\ffmpeg.exe")
        };
        foreach (string g in userGuesses)
        {
            if (File.Exists(g)) Add(g, found);
        }

        // 3) PATH / whatever is on PATH
        Console.WriteLine("  · PATH");
        string pathVar = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(pathVar))
        {
            string[] parts = pathVar.Split(';');
            foreach (string p in parts)
            {
                string dir = p.Trim();
                if (dir.Length == 0) continue;
                try
                {
                    string f = Path.Combine(dir, "ffmpeg.exe");
                    if (File.Exists(f)) Add(f, found);
                }
                catch { }
            }
        }

        // 4) 浅扫各个盘 / shallow scan of each drive
        Console.WriteLine("  · 浅扫各磁盘（深度 " + SCAN_DEPTH + "）/ shallow scan of each drive (depth " + SCAN_DEPTH + ")");
        foreach (DriveInfo d in DriveInfo.GetDrives())
        {
            try
            {
                if (d.DriveType != DriveType.Fixed) continue;
                if (!d.IsReady) continue;
                ScanDir(d.RootDirectory.FullName, 0, found);
            }
            catch { }
        }
    }

    static void ScanDir(string dir, int depth, List<string> found)
    {
        if (depth > SCAN_DEPTH) return;
        string[] files;
        try { files = Directory.GetFiles(dir, "ffmpeg.exe"); }
        catch { return; }
        foreach (string f in files) Add(f, found);

        string[] subs;
        try { subs = Directory.GetDirectories(dir); }
        catch { return; }
        foreach (string s in subs)
        {
            string name;
            try { name = Path.GetFileName(s).ToLowerInvariant(); }
            catch { continue; }
            bool skip = false;
            foreach (string bad in SKIP_NAMES)
            {
                if (name == bad || name.StartsWith("$")) { skip = true; break; }
            }
            if (skip) continue;
            try
            {
                // 无权限的目录（如系统还原点）直接跳过，不要中断整轮扫描
                // Skip directories we cannot read instead of aborting the whole scan
                if ((File.GetAttributes(s) & FileAttributes.ReparsePoint) != 0) continue;
            }
            catch { continue; }
            ScanDir(s, depth + 1, found);
        }
    }

    static void AddFromPath(string p, List<string> found)
    {
        try
        {
            if (File.Exists(p))
            {
                if (Path.GetFileName(p).ToLowerInvariant() == "ffmpeg.exe") Add(p, found);
                return;
            }
            if (Directory.Exists(p))
            {
                string direct = Path.Combine(p, "ffmpeg.exe");
                if (File.Exists(direct)) Add(direct, found);
                string inBin = Path.Combine(p, "bin\\ffmpeg.exe");
                if (File.Exists(inBin)) Add(inBin, found);
            }
        }
        catch { }
    }

    static void Add(string path, List<string> found)
    {
        try
        {
            string full = Path.GetFullPath(path);
            // 已经在 native-host\bin 里那份不算"候选"，那是目标位置
            // The copy already sitting in native-host\bin is the destination, not a candidate
            if (string.Equals(full, Path.GetFullPath(targetExe), StringComparison.OrdinalIgnoreCase)) return;
            foreach (string f in found)
            {
                if (string.Equals(f, full, StringComparison.OrdinalIgnoreCase)) return;
            }
            found.Add(full);
        }
        catch { }
    }

    // ------------------------------------------------------------------ 探测
    // ------------------------------------------------------------------ Probe
    class ProbeResult
    {
        public string Path = "";
        public bool Ok = false;
        public string Error = "";
        public string Version = "";
        public string Sha256 = "";
        public double SizeMb = 0;
        public bool HasMp3 = false;
    }

    static ProbeResult Probe(string exe)
    {
        ProbeResult r = new ProbeResult();
        r.Path = exe;

        try
        {
            FileInfo fi = new FileInfo(exe);
            r.SizeMb = Math.Round(fi.Length / 1048576.0, 1);
            r.Sha256 = Sha256Of(exe);
        }
        catch (Exception e)
        {
            r.Error = "读文件失败 / cannot read: " + e.Message;
            return r;
        }

        // 1) 能不能跑、是不是 ffmpeg
        string ver;
        if (!RunCapture(exe, "-hide_banner -version", 20000, out ver))
        {
            r.Error = "无法执行（不是有效的可执行文件，或被杀软拦下）/ cannot execute";
            return r;
        }
        if (ver.IndexOf("ffmpeg version", StringComparison.OrdinalIgnoreCase) < 0)
        {
            r.Error = "-version 输出里没有 \"ffmpeg version\"，可能不是 ffmpeg / not ffmpeg";
            return r;
        }
        string firstLine = ver.Split('\n')[0].Trim();
        r.Version = ShortVersion(firstLine);

        // 2) 有没有我们要用的 mp3 编码器
        string enc;
        if (!RunCapture(exe, "-hide_banner -encoders", 30000, out enc))
        {
            r.Error = "无法读取编码器列表 / cannot list encoders";
            return r;
        }
        r.HasMp3 = enc.IndexOf("libmp3lame", StringComparison.OrdinalIgnoreCase) >= 0;
        if (!r.HasMp3)
        {
            r.Error = "缺少 libmp3lame（无法转 mp3）/ missing libmp3lame";
            return r;
        }

        r.Ok = true;
        return r;
    }

    static string ShortVersion(string firstLine)
    {
        // "ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) ..." -> 取前两段
        // Grab just the first couple of tokens so the output stays readable
        string[] parts = firstLine.Split(' ');
        if (parts.Length >= 3) return parts[2];
        return firstLine;
    }

    static string Sha256Of(string path)
    {
        using (FileStream fs = File.OpenRead(path))
        using (SHA256 sha = SHA256.Create())
        {
            byte[] hash = sha.ComputeHash(fs);
            StringBuilder sb = new StringBuilder(hash.Length * 2);
            foreach (byte b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    static bool RunCapture(string exe, string args, int timeoutMs, out string output)
    {
        output = "";
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = args;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            using (Process p = Process.Start(psi))
            {
                // stderr 也要收：ffmpeg 习惯把信息写到 stderr
                // Collect stderr too: ffmpeg habitually writes its banner there
                StringBuilder so = new StringBuilder();
                StringBuilder se = new StringBuilder();
                p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) so.AppendLine(e.Data); };
                p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) se.AppendLine(e.Data); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();

                if (!p.WaitForExit(timeoutMs))
                {
                    try { p.Kill(); } catch { }
                    return false;
                }
                p.WaitForExit();
                output = so.ToString() + se.ToString();
                return p.ExitCode == 0 || output.Length > 0;
            }
        }
        catch
        {
            return false;
        }
    }

    // ------------------------------------------------------------------ 安装
    // ------------------------------------------------------------------ Install
    static bool Install(ProbeResult src)
    {
        try
        {
            if (!Directory.Exists(binDir)) Directory.CreateDirectory(binDir);

            // 同哈希就别重复搬了 / skip the copy when it is byte-identical anyway
            if (File.Exists(targetExe))
            {
                string oldHash = Sha256Of(targetExe);
                if (oldHash == src.Sha256)
                {
                    Console.WriteLine("      bin 里那份内容相同（SHA-256 一致），不重复复制。");
                    Console.WriteLine("      The one in bin is byte-identical; not copying again.");
                    WriteSource(src);
                    return true;
                }
            }

            Console.WriteLine("      源 / from: " + src.Path);
            Console.WriteLine("      目标 / to: " + targetExe);
            File.Copy(src.Path, targetExe, true);

            // 复制后校验：确认落盘的和源完全一致（大文件复制中断过就知道）
            // Verify after copying, so an interrupted copy cannot slip through
            string newHash = Sha256Of(targetExe);
            if (newHash != src.Sha256)
            {
                Console.WriteLine("      复制后校验失败！源 " + src.Sha256 + " 目标 " + newHash);
                Console.WriteLine("      Copy verification FAILED (source and destination differ).");
                return false;
            }
            Console.WriteLine("      SHA-256 校验一致 ✅  " + newHash);

            // 顺手把 ffprobe 一起搬过来（有的话）：日后排查问题方便
            // Bring ffprobe along when present; handy for troubleshooting later
            try
            {
                string srcProbe = Path.Combine(Path.GetDirectoryName(src.Path), "ffprobe.exe");
                if (File.Exists(srcProbe))
                {
                    string dstProbe = Path.Combine(binDir, "ffprobe.exe");
                    File.Copy(srcProbe, dstProbe, true);
                    Console.WriteLine("      一并复制了 / also copied: ffprobe.exe");
                }
            }
            catch { }

            WriteSource(src);
            return true;
        }
        catch (Exception e)
        {
            Console.WriteLine("      安装失败 / install failed: " + e.Message);
            return false;
        }
    }

    static void WriteSource(ProbeResult src)
    {
        try
        {
            List<string> lines = new List<string>();
            lines.Add("这个文件由 find-ffmpeg.exe 生成，记录 native-host\\bin\\ffmpeg.exe 的来源。");
            lines.Add("Generated by find-ffmpeg.exe; records where native-host\\bin\\ffmpeg.exe came from.");
            lines.Add("");
            lines.Add("来源路径 / source path : " + src.Path);
            lines.Add("SHA-256                : " + src.Sha256);
            lines.Add("版本 / version          : " + src.Version);
            lines.Add("大小 / size             : " + src.SizeMb + " MB");
            lines.Add("写入时间 / written at   : " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            lines.Add("由谁生成 / by           : find-ffmpeg.exe");
            System.IO.File.WriteAllLines(sourceTxt, lines.ToArray(), new UTF8Encoding(false));
        }
        catch { }
    }

    // ------------------------------------------------------------- 人工兜底
    // ------------------------------------------------------------- Manual fallback
    static int ManualFallback()
    {
        while (true)
        {
            Console.WriteLine();
            Console.WriteLine("你可以 / You can:");
            Console.WriteLine("  [A] 直接给出 ffmpeg.exe 的路径（可把文件拖进本窗口）/ give the path to ffmpeg.exe (drag it in)");
            Console.WriteLine("  [B] 给一个目录，我在里面找 / give a folder and I will look inside it");
            Console.WriteLine("  [C] 退出，先去下载 / quit, download one first");
            Console.WriteLine();
            Console.WriteLine("下载地址 / download links（解压后取出 bin\\ffmpeg.exe 的路径填到这里）:");
            Console.WriteLine("  · https://www.gyan.dev/ffmpeg/builds/            （选 ffmpeg-release-essentials.zip）");
            Console.WriteLine("  · https://github.com/BtbN/FFmpeg-Builds/releases  （选 *-win64-gpl.zip）");
            Console.WriteLine();
            Console.Write("选择 [A/B/C]: ");
            string ans = Console.ReadLine();
            if (ans == null) return 1;
            ans = ans.Trim().ToLowerInvariant();

            if (ans == "c" || ans == "")
            {
                Console.WriteLine("已退出。下载好后把 ffmpeg.exe 拖到本窗口重跑一次即可。");
                Console.WriteLine("Bye. Once downloaded, drag ffmpeg.exe here and run this again.");
                return 1;
            }

            if (ans != "a" && ans != "b")
            {
                Console.WriteLine("请输入 A、B 或 C。");
                continue;
            }

            Console.Write(ans == "a" ? "ffmpeg.exe 的路径 / path: " : "目录 / folder: ");
            string input = Console.ReadLine();
            if (string.IsNullOrEmpty(input)) continue;
            input = input.Trim().Trim('"');

            List<string> found = new List<string>();
            AddFromPath(input, found);
            if (found.Count == 0)
            {
                Console.WriteLine("那里没找到 ffmpeg.exe，再试一次。");
                Console.WriteLine("No ffmpeg.exe there; try again.");
                continue;
            }

            foreach (string f in found)
            {
                ProbeResult r = Probe(f);
                Console.WriteLine("  检查 / checking: " + f);
                if (!r.Ok)
                {
                    Console.WriteLine("    -> 不可用 / unusable: " + r.Error);
                    continue;
                }
                Console.WriteLine("    -> 可用 ✅  版本 " + r.Version + "  SHA-256 " + r.Sha256);
                Console.WriteLine();
                Console.WriteLine("[3/4] 安装到 native-host\\bin\\ ...");
                if (Install(r)) 
                {
                    Console.WriteLine();
                    Console.WriteLine("[4/4] 完成。以后 host.exe 会自动用 native-host\\bin\\ffmpeg.exe。");
                    Console.WriteLine("      Done. host.exe will use native-host\\bin\\ffmpeg.exe from now on.");
                    return 0;
                }
                return 1;
            }
        }
    }

    // ------------------------------------------------------------------ 输出
    // ------------------------------------------------------------------ Output
    static void PrintHeader()
    {
        Console.WriteLine("============================================================");
        Console.WriteLine(" BiliDL  FFmpeg 查找工具 / FFmpeg locator");
        Console.WriteLine(" 把本机可用的 ffmpeg.exe 装进 native-host\\bin\\");
        Console.WriteLine(" Installs a usable local ffmpeg.exe into native-host\\bin\\");
        Console.WriteLine("============================================================");
        Console.WriteLine();
    }

    static void PrintProbe(string path, ProbeResult r)
    {
        Console.WriteLine("  路径 / path     : " + path);
        Console.WriteLine("  版本 / version  : " + r.Version);
        Console.WriteLine("  大小 / size     : " + r.SizeMb + " MB");
        Console.WriteLine("  mp3 编码器      : " + (r.HasMp3 ? "有 libmp3lame ✅" : "缺少 ❌"));
        Console.WriteLine("  SHA-256        : " + r.Sha256);
        Console.WriteLine();
    }
}
