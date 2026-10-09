// ===========================================================================
// BiliDL FFmpeg 查找工具（控制台程序）
// BiliDL FFmpeg finder (console program)
//
// 何时用：install.cmd 自动下载 FFmpeg 失败或超时时，用它在本机找现成的。
// When: install.cmd could not download FFmpeg (failed or timed out), use this to find one that
// is already on this machine.
//
//   1. 先看 native-host\bin\ffmpeg.exe 在不在、能不能用
//   2. 扫描 PATH 与常见安装目录
//   3. 对每个候选做「能运行 + 能查编码器」的验证，并算出 SHA-256
//   4. 让你挑一个，或者自己指定目录
//   5. 复制到 native-host\bin\ffmpeg.exe —— 宿主以后就优先用它
//
//   1. check native-host\bin\ffmpeg.exe: present and usable?
//   2. scan PATH and the usual install locations
//   3. verify each candidate (does it run, does it list encoders) and hash it with SHA-256
//   4. let you pick one, or point at a folder yourself
//   5. copy it to native-host\bin\ffmpeg.exe -- the host prefers that copy from then on
//
// 编译（Windows 自带 .NET Framework 的 csc 即可，不需要装 SDK）：
// Build (the csc bundled with Windows .NET Framework is enough; no SDK required):
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /codepage:65001 ^
//       /out:ffmpeg-finder.exe ffmpeg-finder.cs
//   （也可以直接双击 build-ffmpeg-finder.cmd）
//   (or just run build-ffmpeg-finder.cmd)
//
// 关于 SHA-256 / About SHA-256：
//   ffmpeg 的构建版本太多（BtbN、gyan.dev、官方、各种 Linux 移植……），根本不存在一个
//   "通用的正确哈希"。所以这里用 SHA-256 做的是**文件身份记录**：打印出来，供你与下载
//   来源的发布页核对。而"这个 ffmpeg 能不能用"是靠**实际运行**验证的（-version 能否返回、
//   -encoders 里有没有需要的编码器），不靠哈希。
//   ffmpeg has far too many builds (BtbN, gyan.dev, official, ...) for a single "correct hash"
//   to exist. SHA-256 here is a **file identity record**: printed so you can cross-check it
//   against the publisher's release page. Whether the binary actually works is established by
//   running it (-version, -encoders), not by the hash.
// ===========================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

class FfmpegFinder
{
    // 宿主里 FindFfmpeg() 的查找顺序是 BILIDL_FFMPEG → bin\ffmpeg.exe → ffmpeg.exe → PATH，
    // 所以把文件放进 bin\ 就会优先于系统里那些。
    // The host's FindFfmpeg() looks at BILIDL_FFMPEG -> bin\ffmpeg.exe -> ffmpeg.exe -> PATH,
    // so dropping a copy into bin\ takes precedence over anything on the system.
    static string AppDir
    {
        get
        {
            try { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); }
            catch { return AppDomain.CurrentDomain.BaseDirectory; }
        }
    }

    static string BinDir { get { return Path.Combine(AppDir, "bin"); } }
    static string Target { get { return Path.Combine(BinDir, "ffmpeg.exe"); } }

    // ---------------------------------------------------------------- 探测
    // ---------------------------------------------------------------- Probing
    class Probe
    {
        public string Path = "";
        public bool Exists;
        public bool Runs;
        public bool HasMp3;
        public string Version = "";
        public string Sha256 = "";
        public long Size;
        public string Reason = "";

        // 能用 = 文件在 + 跑得起来。/ Usable = present and it runs.
        public bool Usable { get { return Exists && Runs; } }
        // 首选 = 能用 + 带 mp3 编码器（转 mp3 需要它）。/ Preferred = usable and mp3-capable.
        public bool Preferred { get { return Usable && HasMp3; } }
    }

    static string Sha256Of(string path)
    {
        try
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream fs = File.OpenRead(path))
            {
                byte[] h = sha.ComputeHash(fs);
                StringBuilder sb = new StringBuilder(h.Length * 2);
                for (int i = 0; i < h.Length; i++) sb.Append(h[i].ToString("x2"));
                return sb.ToString();
            }
        }
        catch { return ""; }
    }

    static string FormatSize(long bytes)
    {
        if (bytes <= 0) return "未知";
        double mb = bytes / 1048576.0;
        if (mb >= 1.0) return mb.ToString("0.0") + " MB";
        return (bytes / 1024.0).ToString("0") + " KB";
    }

    static bool RunCapture(string exe, string arguments, out string stdout, out string stderr)
    {
        stdout = "";
        stderr = "";
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = arguments;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            Process p = Process.Start(psi);
            stdout = p.StandardOutput.ReadToEnd();
            stderr = p.StandardError.ReadToEnd();
            if (!p.WaitForExit(20000))
            {
                try { p.Kill(); } catch { }
                stderr = "超时";
                return false;
            }
            return p.ExitCode == 0;
        }
        catch (Exception e)
        {
            stderr = e.Message;
            return false;
        }
    }

    static Probe Inspect(string path)
    {
        Probe r = new Probe();
        r.Path = path;
        try
        {
            if (!File.Exists(path)) { r.Reason = "文件不存在"; return r; }
            r.Exists = true;
            r.Size = new FileInfo(path).Length;
            // 太小的多半是占位文件或者壳 / anything this small is a stub
            if (r.Size < 1024 * 1024) { r.Reason = "文件过小（" + FormatSize(r.Size) + "），多半不是完整构建"; return r; }
        }
        catch (Exception e)
        {
            r.Reason = e.Message;
            return r;
        }

        string so, se;
        if (!RunCapture(path, "-hide_banner -version", out so, out se))
        {
            r.Reason = "无法运行：" + (se.Length > 0 ? se : "未知原因");
            return r;
        }
        r.Runs = true;

        string firstLine = so;
        int nl = firstLine.IndexOf('\n');
        if (nl > 0) firstLine = firstLine.Substring(0, nl);
        r.Version = firstLine.Trim();

        // 编码器清单：转 mp3 需要 libmp3lame（合并用 -c copy，不需要编码器）
        // Encoder list: mp3 transcoding needs libmp3lame (merging uses -c copy and needs none)
        string encOut, encErr;
        if (RunCapture(path, "-hide_banner -encoders", out encOut, out encErr))
        {
            r.HasMp3 = encOut.IndexOf("libmp3lame", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        r.Sha256 = Sha256Of(path);
        return r;
    }

    // ---------------------------------------------------------------- 搜索
    // ---------------------------------------------------------------- Searching
    static void AddCandidate(List<string> list, string dir)
    {
        if (string.IsNullOrEmpty(dir)) return;
        try
        {
            string exe = Path.Combine(dir.Trim(), "ffmpeg.exe");
            if (File.Exists(exe) && !list.Contains(exe)) list.Add(exe);
        }
        catch { }
    }

    static List<string> CollectCandidates()
    {
        List<string> found = new List<string>();

        // 1) PATH 里的每个目录 / every directory on PATH
        string pathVar = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(pathVar))
        {
            string[] parts = pathVar.Split(';');
            for (int i = 0; i < parts.Length; i++) AddCandidate(found, parts[i]);
        }

        // 2) 常见安装位置 / the usual install locations
        string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        List<string> common = new List<string>();
        common.Add(@"C:\ffmpeg\bin");
        common.Add(@"C:\ffmpeg");
        common.Add(@"C:\Program Files\ffmpeg\bin");
        common.Add(@"C:\Program Files (x86)\ffmpeg\bin");
        common.Add(@"C:\tools\ffmpeg\bin");
        if (!string.IsNullOrEmpty(localApp))
        {
            common.Add(Path.Combine(localApp, "Microsoft\\WinGet\\Links"));
            common.Add(Path.Combine(localApp, "ffmpeg\\bin"));
        }
        if (!string.IsNullOrEmpty(userProfile))
        {
            common.Add(Path.Combine(userProfile, "scoop\\shims"));
            common.Add(Path.Combine(userProfile, "scoop\\apps\\ffmpeg\\current\\bin"));
            common.Add(Path.Combine(userProfile, "Downloads"));
            common.Add(Path.Combine(userProfile, "Desktop"));
        }
        common.Add(@"C:\ProgramData\chocolatey\bin");
        for (int i = 0; i < common.Count; i++) AddCandidate(found, common[i]);

        // 3) 各盘符根目录下一级的 ffmpeg* 文件夹（只扫一层，不做全盘搜索）
        //    one level of ffmpeg* directories at each drive root (a single level, never a full scan)
        try
        {
            DriveInfo[] drives = DriveInfo.GetDrives();
            for (int d = 0; d < drives.Length; d++)
            {
                DriveInfo di = drives[d];
                if (di.DriveType != DriveType.Fixed) continue;
                try
                {
                    string[] dirs = Directory.GetDirectories(di.RootDirectory.FullName, "ffmpeg*");
                    for (int i = 0; i < dirs.Length; i++)
                    {
                        AddCandidate(found, Path.Combine(dirs[i], "bin"));
                        AddCandidate(found, dirs[i]);
                    }
                }
                catch { }
            }
        }
        catch { }

        return found;
    }

    // ---------------------------------------------------------------- 交互
    // ---------------------------------------------------------------- Interaction
    static void PrintDownloadLinks()
    {
        Console.WriteLine("  你可以自己下载一个，解压后得到 bin\\ffmpeg.exe：");
        Console.WriteLine("  Download one yourself; unzip it and you get bin\\ffmpeg.exe:");
        Console.WriteLine();
        Console.WriteLine("    · https://www.gyan.dev/ffmpeg/builds/");
        Console.WriteLine("        Windows 构建，选 \"release essentials\" 或 \"release full\"");
        Console.WriteLine("        Windows builds -- pick \"release essentials\" or \"release full\"");
        Console.WriteLine("    · https://github.com/BtbN/FFmpeg-Builds/releases");
        Console.WriteLine("        选 ffmpeg-master-latest-win64-gpl.zip");
        Console.WriteLine("    · https://ffmpeg.org/download.html");
        Console.WriteLine();
        Console.WriteLine("  提示：要转 mp3 就得选带 libmp3lame 的完整构建（essentials / full 都带）。");
        Console.WriteLine("  Note: mp3 output needs a build with libmp3lame (essentials and full both have it).");
    }

    // 从用户给的目录/文件路径里找出 ffmpeg.exe / resolve whatever the user typed into a real path
    static string ResolveUserInput(string input)
    {
        if (string.IsNullOrEmpty(input)) return null;
        string s = input.Trim().Trim('"');
        try
        {
            if (File.Exists(s))
            {
                if (Path.GetFileName(s).ToLower().EndsWith(".exe")) return s;
                // 也可能拖进来一个压缩包，那没法直接用 / could be an archive; nothing to do with it
                return null;
            }
            if (Directory.Exists(s))
            {
                string direct = Path.Combine(s, "ffmpeg.exe");
                if (File.Exists(direct)) return direct;
                string bin = Path.Combine(s, "bin\\ffmpeg.exe");
                if (File.Exists(bin)) return bin;
            }
        }
        catch { }
        return null;
    }

    static bool CopyToTarget(Probe p)
    {
        try
        {
            if (!Directory.Exists(BinDir)) Directory.CreateDirectory(BinDir);
            File.Copy(p.Path, Target, true);
            Console.WriteLine();
            Console.WriteLine("已复制到: " + Target);
            Console.WriteLine("Copied to: " + Target);
            string after = Sha256Of(Target);
            Console.WriteLine("  复制后 SHA-256: " + after);
            if (after != p.Sha256)
            {
                Console.WriteLine("  [!] 复制后哈希与源文件不一致，请重试。");
                Console.WriteLine("  [!] Hash mismatch after copying -- please retry.");
                return false;
            }
            Console.WriteLine("  哈希一致，复制无误。");
            Console.WriteLine("  Hashes match; the copy is intact.");
            return true;
        }
        catch (Exception e)
        {
            Console.WriteLine("复制失败: " + e.Message);
            Console.WriteLine("Copy failed: " + e.Message);
            return false;
        }
    }

    static void Pause()
    {
        Console.WriteLine();
        Console.WriteLine("按回车键退出... / Press Enter to exit...");
        try { Console.ReadLine(); } catch { }
    }

    static string Tag(Probe p)
    {
        if (p.Preferred) return "可用，且带 mp3 编码器";
        if (p.Usable) return "可用，但没有 mp3 编码器（只能合并，不能转 mp3）";
        return "不可用";
    }

    static void PrintProbe(Probe p, string indent)
    {
        Console.WriteLine(indent + p.Path);
        Console.WriteLine(indent + "  版本 version : " + p.Version);
        Console.WriteLine(indent + "  大小 size    : " + FormatSize(p.Size));
        Console.WriteLine(indent + "  SHA-256      : " + (p.Sha256.Length > 0 ? p.Sha256 : "（计算失败）"));
        Console.WriteLine(indent + "  判定 verdict : " + Tag(p));
    }

    // ---------------------------------------------------------------- 主流程
    // ---------------------------------------------------------------- Main flow
    static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }

        Console.WriteLine("========================================================");
        Console.WriteLine(" BiliDL —— 在本机查找可用的 FFmpeg");
        Console.WriteLine(" BiliDL -- locate a usable FFmpeg on this machine");
        Console.WriteLine("========================================================");
        Console.WriteLine();

        // 0) bin\ 里已经有了？
        // 0) Is there already one in bin\?
        if (File.Exists(Target))
        {
            Console.WriteLine("[0/3] 检查 " + Target + " ...");
            Probe cur = Inspect(Target);
            PrintProbe(cur, "  ");
            if (cur.Usable)
            {
                Console.WriteLine();
                Console.WriteLine("native-host\\bin\\ffmpeg.exe 已经存在且可用，无需处理。");
                Console.WriteLine("native-host\\bin\\ffmpeg.exe is already present and usable; nothing to do.");
                if (!cur.HasMp3)
                {
                    Console.WriteLine();
                    Console.WriteLine("提示：这份不带 mp3 编码器，合并没问题，但音频格式选 mp3 时会退回内置编码器。");
                    Console.WriteLine("Note: no mp3 encoder here; merging is fine, but choosing mp3 will fall back to");
                    Console.WriteLine("the built-in encoder.");
                }
                Pause();
                return 0;
            }
            Console.WriteLine();
            Console.WriteLine("现有文件不可用（" + cur.Reason + "），继续搜索本机其它 ffmpeg。");
            Console.WriteLine("The existing file is unusable (" + cur.Reason + "); searching elsewhere.");
            Console.WriteLine();
        }

        // 1) 搜索
        // 1) Search
        Console.WriteLine("[1/3] 正在搜索本机的 ffmpeg ...");
        Console.WriteLine("[1/3] Searching this machine for ffmpeg ...");
        List<string> candidates = CollectCandidates();
        Console.WriteLine("      共找到 " + candidates.Count + " 个候选文件。");
        Console.WriteLine("      " + candidates.Count + " candidate file(s) found.");
        Console.WriteLine();

        List<Probe> ok = new List<Probe>();
        for (int i = 0; i < candidates.Count; i++)
        {
            Probe p = Inspect(candidates[i]);
            if (p.Usable) ok.Add(p);
        }
        // 带 mp3 编码器的排前面 / mp3-capable ones first
        ok.Sort(delegate (Probe a, Probe b) { return b.Preferred.CompareTo(a.Preferred); });

        // 2) 选一个
        // 2) Pick one
        if (ok.Count > 0)
        {
            Console.WriteLine("[2/3] 找到 " + ok.Count + " 个可用的 ffmpeg：");
            Console.WriteLine("[2/3] " + ok.Count + " usable ffmpeg binaries found:");
            Console.WriteLine();
            for (int i = 0; i < ok.Count; i++)
            {
                Console.WriteLine("  [" + (i + 1) + "] " + ok[i].Path);
                Console.WriteLine("      版本 version : " + ok[i].Version);
                Console.WriteLine("      大小 size    : " + FormatSize(ok[i].Size));
                Console.WriteLine("      SHA-256      : " + ok[i].Sha256);
                Console.WriteLine("      判定 verdict : " + Tag(ok[i]));
                Console.WriteLine();
            }

            Console.WriteLine("[3/3] 选择要复制到 native-host\\bin\\ 的那一个：");
            Console.WriteLine("[3/3] Choose the one to copy into native-host\\bin\\:");
            Console.WriteLine("      直接输入编号（1-" + ok.Count + "），或 P 自己指定目录，或 Q 退出");
            Console.WriteLine("      type a number (1-" + ok.Count + "), P to point at a folder, Q to quit");
            Console.Write("请输入 your choice: ");
            string ans = Console.ReadLine();
            if (!string.IsNullOrEmpty(ans))
            {
                string a = ans.Trim();
                if (a.ToUpper() == "Q") { Console.WriteLine("已退出。 / Quit."); Pause(); return 0; }
                if (a.ToUpper() != "P")
                {
                    int idx;
                    if (int.TryParse(a, out idx) && idx >= 1 && idx <= ok.Count)
                    {
                        int r = CopyToTarget(ok[idx - 1]) ? 0 : 1;
                        Pause();
                        return r;
                    }
                    Console.WriteLine("输入无法识别，改为让你指定目录。");
                    Console.WriteLine("Unrecognised input; falling back to a folder you specify.");
                }
            }
        }
        else
        {
            Console.WriteLine("[2/3] 本机没有找到可用的 ffmpeg。");
            Console.WriteLine("[2/3] No usable ffmpeg was found on this machine.");
            Console.WriteLine();
            PrintDownloadLinks();
            Console.WriteLine();
        }

        // 3) 用户自己指定
        // 3) Let the user point at one
        Console.WriteLine();
        Console.WriteLine("[3/3] 请给出 ffmpeg.exe 所在的位置：");
        Console.WriteLine("[3/3] Point me at ffmpeg.exe:");
        Console.WriteLine("      · 直接把 ffmpeg.exe 拖进这个窗口，或者");
        Console.WriteLine("      · 输入它所在的文件夹（里面的 ffmpeg.exe 或 bin\\ffmpeg.exe 都会被找到），或者");
        Console.WriteLine("      · 什么都不输直接回车 = 退出");
        Console.WriteLine("      drag ffmpeg.exe into this window, or type the folder that holds it, or");
        Console.WriteLine("      press Enter with nothing to quit");
        Console.Write("请输入 your input: ");
        string input = Console.ReadLine();
        string resolved = ResolveUserInput(input);
        if (resolved == null)
        {
            Console.WriteLine();
            Console.WriteLine("没有解析出 ffmpeg.exe。下载好之后可以再运行一次这个工具。");
            Console.WriteLine("No ffmpeg.exe was resolved. Run this tool again once you have downloaded one.");
            Pause();
            return 1;
        }

        Console.WriteLine();
        Console.WriteLine("正在验证 / Verifying: " + resolved);
        Probe p2 = Inspect(resolved);
        PrintProbe(p2, "  ");
        if (!p2.Usable)
        {
            Console.WriteLine();
            Console.WriteLine("这个文件不可用，没有复制。 / That file is not usable; nothing was copied.");
            Pause();
            return 1;
        }

        int rc = CopyToTarget(p2) ? 0 : 1;
        if (rc == 0)
        {
            Console.WriteLine();
            Console.WriteLine("完成。宿主以后会自动优先使用 native-host\\bin\\ffmpeg.exe。");
            Console.WriteLine("Done. The host will prefer native-host\\bin\\ffmpeg.exe from now on.");
        }
        Pause();
        return rc;
    }
}
