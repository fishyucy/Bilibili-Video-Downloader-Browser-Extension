// ===========================================================================
// BiliDL 原生宿主（Native Messaging Host）
// BiliDL native host (Native Messaging Host)
//
// 与扩展通过 stdin/stdout 上的「4 字节小端长度前缀 + UTF-8 JSON」协议通信。
// Talks to the extension over stdin/stdout with a "4-byte little-endian length prefix + UTF-8 JSON" protocol.
// 职责：
// Responsibilities:
//   1. 按 B 站 CDN 的防盗链要求（Referer / Origin）下载 DASH 音视频流
//   1. Download the DASH video/audio streams with the Referer / Origin the Bilibili CDN demands
//   2. 调用 FFmpeg 以 -c copy 无损封装成单个可播放 MP4（不重新编码）
//   2. Call FFmpeg with -c copy to package them into one playable MP4 (no re-encode)
//
// 编译（无需安装任何 SDK，Windows 自带 .NET Framework 的 csc 即可）：
// Build (no SDK required -- the csc bundled with Windows .NET Framework is enough):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /out:host.exe /r:System.Net.Http.dll host.cs
//
// 说明：用 /target:winexe 编译是为了避免 Chrome 拉起宿主时闪黑框；
// Note: /target:winexe is used to stop a console window flashing when Chrome spawns the host;
//      stdio 是通过管道继承的，GUI 子系统程序照样能读写。
//      stdio is inherited through pipes, and a GUI-subsystem program can still read and write it.
// ===========================================================================

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;

class BiliDlHost
{
    const string UserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    static Stream stdin;
    static Stream stdout;
    static string logPath = Path.Combine(Path.GetTempPath(), "bilidl_host.log");

    // 下载过程中主线程会阻塞在读取网络流里，没法同时读 stdin，
    // While downloading, the main thread blocks on the network stream and cannot read stdin at the same time,
    // 所以用一个独立线程专门读协议消息：控制类消息（暂停/继续/取消）就地处理，
    // so a dedicated thread reads protocol messages: control messages (pause / resume / cancel) are handled
    // 其余消息投进收件箱交给主线程。
    // right there, while everything else is queued into an inbox for the main thread.
    static BlockingCollection<string> inbox = new BlockingCollection<string>();
    static volatile bool hCancelled = false;
    static volatile bool hPaused = false;

    static void Log(string msg)
    {
        try
        {
            File.AppendAllText(logPath, "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg + "\r\n", Encoding.UTF8);
        }
        catch { }
    }

    static int Main(string[] args)
    {
        // 顶层兜底：任何未捕获异常都写进日志。
        // 之前遇到的怪现象就是「日志只写了 "host 启动" 就没了」—— 进程静默崩掉，
        // 从外面完全看不出原因。加上这层之后，崩溃会带着完整堆栈落到日志里。
        // Top-level safety net: log any uncaught exception. The puzzling symptom was a log that
        // stopped right after "host 启动" -- the process died silently with no trace. With this
        // in place a crash lands in the log together with a full stack trace.
        try
        {
            return Run(args);
        }
        catch (Exception e)
        {
            Log("!! 未捕获异常 / uncaught: " + e.ToString());
            return 1;
        }
    }

    static int Run(string[] args)
    {
        try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; } // TLS 1.2
        catch { }

        try
        {
            stdin = Console.OpenStandardInput();
            stdout = Console.OpenStandardOutput();
        }
        catch (Exception e)
        {
            Log("stdio 初始化失败: " + e.Message);
            return 1;
        }

        Log("host 启动");
        // 把 stdio 的真实类型记下来：如果是 NullStream，说明 GUI 子系统下标准句柄没接上，
        // 那浏览器那边就会看到 "Error when communicating with the native messaging host."
        // Record the concrete stdio types: a NullStream means the standard handles were not wired
        // up under the GUI subsystem, which is exactly what makes the browser report
        // "Error when communicating with the native messaging host."
        Log("  stdin  = " + (stdin == null ? "(null)" : stdin.GetType().Name) +
            "   stdout = " + (stdout == null ? "(null)" : stdout.GetType().Name));
        // 把关键路径记下来：排查「明明有 ffmpeg 却说找不到」时，这条最有用
        // Record the key paths: this line is the most useful when debugging "ffmpeg exists but is not found"
        Log("  AppDir      = " + AppDir);
        Log("  期望的 ffmpeg = " + Path.Combine(AppDir, "bin\\ffmpeg.exe") + "  存在=" + File.Exists(Path.Combine(AppDir, "bin\\ffmpeg.exe")));

        // --version 之类的手动调试模式
        // Manual debug mode, e.g. --version
        if (args.Length > 0 && args[0] == "--selfcheck")
        {
            // 这个 exe 是 /target:winexe（GUI 子系统），Console.Error 在双击或管道下
            // 都可能写到空流里 —— 所以结果也写一份到 selfcheck.txt，那才是靠得住的。
            // This exe is /target:winexe (GUI subsystem), so Console.Error may go nowhere.
            // The result is therefore also written to selfcheck.txt, which can be relied on.
            string found = FindFfmpeg();
            List<string> rep = new List<string>();
            rep.Add("BiliDL host 自检 / self check");
            rep.Add("");
            rep.Add("AppDir                : " + AppDir);
            rep.Add("期望的 ffmpeg 路径    : " + Path.Combine(AppDir, "bin\\ffmpeg.exe"));
            rep.Add("该文件存在            : " + File.Exists(Path.Combine(AppDir, "bin\\ffmpeg.exe")));
            rep.Add("BILIDL_FFMPEG 环境变量: " + (Environment.GetEnvironmentVariable("BILIDL_FFMPEG") ?? "(未设置)"));
            rep.Add("FindFfmpeg() 的结果   : " + (found ?? "(未找到)"));
            rep.Add("");
            rep.Add("时间 / at             : " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            try
            {
                System.IO.File.WriteAllLines(Path.Combine(AppDir, "selfcheck.txt"), rep.ToArray(), new UTF8Encoding(false));
            }
            catch { }
            try { Console.Error.WriteLine("ffmpeg: " + (found ?? "未找到")); } catch { }
            return 0;
        }

        // 协议读取线程：控制类指令直接改标志位，其余排队给主线程
        // Protocol reader thread: control commands flip flags in place, the rest queue up for the main thread
        Thread reader = new Thread(delegate ()
        {
            try
            {
                while (true)
                {
                    string raw = ReadMessage();
                    if (raw == null) { inbox.CompleteAdding(); break; }

                    string action = GetString(raw, "action");
                    if (action == "cancel") { hCancelled = true; hPaused = false; Log("收到取消"); continue; }
                    if (action == "pause") { hPaused = true; Log("收到暂停"); continue; }
                    if (action == "resume") { hPaused = false; Log("收到继续"); continue; }

                    inbox.Add(raw);
                }
            }
            catch (Exception e)
            {
                Log("读取线程结束: " + e.Message);
                try { inbox.CompleteAdding(); } catch { }
            }
        });
        reader.IsBackground = true;
        reader.Start();

        foreach (string raw in inbox.GetConsumingEnumerable())
        {
            string action = GetString(raw, "action");
            if (action == "quit") { Log("host 退出"); break; }
            if (action == "ping") { HandlePing(); continue; }
            if (action == "merge") { HandleMerge(raw); continue; }
            if (action == "transcode") { HandleTranscode(raw); continue; }

            WriteMessage("{\"ok\":false,\"error\":\"" + Escape("未知指令: " + action) + "\"}");
        }
        return 0;
    }

    // ---------------------------------------------------------------- 协议
    // ---------------------------------------------------------------- Protocol
    static byte[] ReadExact(int count)
    {
        byte[] buf = new byte[count];
        int off = 0;
        while (off < count)
        {
            int n = stdin.Read(buf, off, count - off);
            if (n <= 0) return null;
            off += n;
        }
        return buf;
    }

    static string ReadMessage()
    {
        byte[] lenBuf = ReadExact(4);
        if (lenBuf == null) return null;
        int len = BitConverter.ToInt32(lenBuf, 0);
        if (len <= 0 || len > 67108864) return null;
        byte[] body = ReadExact(len);
        if (body == null) return null;
        return Encoding.UTF8.GetString(body);
    }

    static void WriteMessage(string json)
    {
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            byte[] lenBytes = BitConverter.GetBytes(bytes.Length);
            stdout.Write(lenBytes, 0, 4);
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
        catch (Exception e)
        {
            Log("写协议消息失败: " + e.Message);
        }
    }

    // ------------------------------------------------------- 极简 JSON 处理
    // ------------------------------------------------------- Minimal JSON handling
    static string Escape(string s)
    {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.Length + 16);
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    static string GetString(string json, string key)
    {
        string pat = "\"" + key + "\"";
        int i = json.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return null;
        i = json.IndexOf(':', i + pat.Length);
        if (i < 0) return null;
        i++;
        while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
        if (i >= json.Length || json[i] != '"') return null;
        i++;

        StringBuilder sb = new StringBuilder();
        while (i < json.Length)
        {
            char c = json[i];
            if (c == '\\' && i + 1 < json.Length)
            {
                char n = json[i + 1];
                if (n == 'u' && i + 5 < json.Length)
                {
                    try { sb.Append((char)Convert.ToInt32(json.Substring(i + 2, 4), 16)); }
                    catch { }
                    i += 6;
                    continue;
                }
                switch (n)
                {
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    default: sb.Append(n); break;
                }
                i += 2;
                continue;
            }
            if (c == '"') break;
            sb.Append(c);
            i++;
        }
        return sb.ToString();
    }

    // ------------------------------------------------------------ 找 FFmpeg
    // ------------------------------------------------------------ Locate FFmpeg
    static string AppDir
    {
        get
        {
            // 优先用 exe 的实际位置；拿不到再退回 BaseDirectory。
            // 两个都试是有原因的：某些安全软件会「虚拟化」启动路径，
            // 只认其中一个就可能找错目录，于是明明 bin\ffmpeg.exe 在，却报「未找到」。
            // Prefer the real exe location, then fall back to BaseDirectory. Both are tried
            // because some security tools virtualise the launch path; trusting only one can
            // resolve to the wrong directory and report "not found" while bin\ffmpeg.exe exists.
            try
            {
                string loc = Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrEmpty(loc))
                {
                    string dir = Path.GetDirectoryName(loc);
                    if (!string.IsNullOrEmpty(dir)) return dir.TrimEnd('\\');
                }
            }
            catch { }
            // BaseDirectory 理论上不会为 null，但真为 null 时 TrimEnd 会抛；兜一下更稳
            // BaseDirectory should never be null, but if it ever is, TrimEnd would throw
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            return (baseDir == null ? string.Empty : baseDir.TrimEnd('\\'));
        }
    }

    static string FindFfmpeg()
    {
        List<string> cands = new List<string>();

        // 优先用 native-host\bin\ffmpeg.exe：install.cmd / find-ffmpeg.exe 会把本机那份复制到
        // 这里，从此一直用它 —— 用户选过一次就不该再变。
        // Prefer native-host\bin\ffmpeg.exe: install.cmd / find-ffmpeg.exe copies a local build
        // there, and that is the one used from then on -- once chosen, it should not drift.
        cands.Add(Path.Combine(AppDir, "bin\\ffmpeg.exe"));

        string envPath = Environment.GetEnvironmentVariable("BILIDL_FFMPEG");
        if (!string.IsNullOrEmpty(envPath)) cands.Add(envPath);

        cands.Add(Path.Combine(AppDir, "ffmpeg.exe"));

        string pathVar = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(pathVar))
        {
            foreach (string p in pathVar.Split(';'))
            {
                string dir = p.Trim();
                if (dir.Length == 0) continue;
                try { cands.Add(Path.Combine(dir, "ffmpeg.exe")); }
                catch { }
            }
        }

        foreach (string c in cands)
        {
            try { if (File.Exists(c)) return c; }
            catch { }
        }
        return null;
    }

    static void HandlePing()
    {
        string ffmpeg = FindFfmpeg();
        // 浏览器报「未检测到 ffmpeg」时，这行日志能立刻说明宿主这边到底找到了什么
        // When the browser says "no ffmpeg detected", this line shows what the host actually found
        Log("ping -> " + (ffmpeg == null ? "未找到 ffmpeg" : ffmpeg));
        if (ffmpeg == null)
        {
            WriteMessage("{\"ok\":false,\"error\":\"未找到 ffmpeg.exe\"}");
            return;
        }
        string version = "";
        try { version = RunCapture(ffmpeg, "-version").Split('\n')[0].Trim(); }
        catch { version = "unknown"; }
        WriteMessage("{\"ok\":true,\"ffmpeg\":\"" + Escape(ffmpeg) + "\",\"version\":\"" + Escape(version) + "\"}");
    }

    static string RunCapture(string exe, string arguments)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = exe;
        psi.Arguments = arguments;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        Process p = Process.Start(psi);
        string so = p.StandardOutput.ReadToEnd();
        p.StandardError.ReadToEnd();
        p.WaitForExit();
        return so;
    }

    // ---------------------------------------------------------------- 下载
    // ---------------------------------------------------------------- Download
    static long DownloadWithReferer(string url, string dest, long baseOffset, int spanPercent, string label)
    {
        using (HttpClient client = new HttpClient())
        {
            client.Timeout = TimeSpan.FromMinutes(60);

            HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Get, url);
            try { req.Headers.Referrer = new Uri("https://www.bilibili.com/"); }
            catch { }
            req.Headers.TryAddWithoutValidation("Origin", "https://www.bilibili.com");
            req.Headers.TryAddWithoutValidation("User-Agent", UserAgent);

            // 用 GetAwaiter().GetResult() 而不是 .Result：后者会把真实异常包成
            // AggregateException，Message 只剩一句「发生一个或多个错误。」，什么线索都没有。
            // Use GetAwaiter().GetResult() rather than .Result: the latter wraps the real exception
            // in an AggregateException whose Message is just "One or more errors occurred.",
            // throwing away every useful detail.
            HttpResponseMessage resp = client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead)
                                             .GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode)
            {
                throw new Exception("HTTP " + (int)resp.StatusCode + " " + resp.ReasonPhrase + "（多为防盗链拦截）");
            }

            long total = 0;
            if (resp.Content.Headers.ContentLength.HasValue) total = resp.Content.Headers.ContentLength.Value;

            long loaded = 0;
            using (Stream src = resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult())
            using (FileStream fs = File.Create(dest))
            {
                byte[] buf = new byte[262144];
                DateTime last = DateTime.UtcNow;
                int n;
                while (true)
                {
                    // 暂停门 + 取消检查（读之前过一道）
                    // Pause gate + cancel check (run before every read)
                    while (hPaused && !hCancelled) Thread.Sleep(100);
                    if (hCancelled) throw new OperationCanceledException("已取消");

                    n = src.Read(buf, 0, buf.Length);
                    if (n <= 0) break;

                    fs.Write(buf, 0, n);
                    loaded += n;
                    if ((DateTime.UtcNow - last).TotalMilliseconds >= 300)
                    {
                        last = DateTime.UtcNow;
                        int pct = (int)baseOffset;
                        if (total > 0) pct = (int)(baseOffset + (loaded * spanPercent) / total);
                        if (pct > 99) pct = 99;
                        WriteMessage("{\"type\":\"progress\",\"phase\":\"download\",\"label\":\"" + Escape(label) +
                                     "\",\"percent\":" + pct + ",\"loaded\":" + loaded + ",\"total\":" + total + "}");
                    }
                }
            }
            return loaded;
        }
    }

    // ---------------------------------------------------------------- 合并
    // ---------------------------------------------------------------- Merge
    static void HandleMerge(string raw)
    {
        string ffmpeg = FindFfmpeg();
        Log("merge -> ffmpeg " + (ffmpeg == null ? "未找到" : ffmpeg));
        if (ffmpeg == null)
        {
            WriteMessage("{\"type\":\"done\",\"ok\":false,\"error\":\"未找到 ffmpeg.exe。请运行 native-host\\\\install.cmd 自动下载，或把 ffmpeg.exe 放到 native-host\\\\bin\\\\ 下。\"}");
            return;
        }

        string videoUrl = GetString(raw, "videoUrl");
        string audioUrl = GetString(raw, "audioUrl");
        string filename = SanitizeName(GetString(raw, "filename"));
        string outDir = GetString(raw, "outDir");
        if (string.IsNullOrEmpty(outDir)) outDir = Environment.GetEnvironmentVariable("BILIDL_OUTDIR");
        if (string.IsNullOrEmpty(outDir))
        {
            outDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }

        hCancelled = false;   // 每次合并都从干净状态开始 / every merge starts from a clean state
        hPaused = false;

        string id = Guid.NewGuid().ToString("N");
        string tmpVideo = Path.Combine(Path.GetTempPath(), "bilidl_" + id + "_v.m4s");
        string tmpAudio = Path.Combine(Path.GetTempPath(), "bilidl_" + id + "_a.m4s");
        string outFile = Path.Combine(outDir, filename);

        try
        {
            if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir);

            WriteMessage("{\"type\":\"progress\",\"phase\":\"download\",\"label\":\"视频\",\"percent\":1}");
            DownloadWithReferer(videoUrl, tmpVideo, 1, 48, "视频");

            WriteMessage("{\"type\":\"progress\",\"phase\":\"download\",\"label\":\"音频\",\"percent\":50}");
            DownloadWithReferer(audioUrl, tmpAudio, 50, 45, "音频");

            WriteMessage("{\"type\":\"progress\",\"phase\":\"merge\",\"percent\":96}");

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = ffmpeg;
            psi.Arguments = "-hide_banner -nostdin -y -loglevel error -i \"" + tmpVideo + "\" -i \"" + tmpAudio +
                            "\" -c copy -movflags +faststart \"" + outFile + "\"";
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            Log("ffmpeg " + psi.Arguments);
            Process p = Process.Start(psi);

            // 不能直接 ReadToEnd 阻塞等待：那样期间无法响应取消，所以改成轮询 + 异步收 stderr
            // ReadToEnd would block and make cancel unresponsive, so poll instead and collect stderr asynchronously
            StringBuilder errBuf = new StringBuilder();
            p.ErrorDataReceived += delegate (object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) { lock (errBuf) { errBuf.AppendLine(e.Data); } }
            };
            p.BeginErrorReadLine();
            while (!p.WaitForExit(200))
            {
                if (hCancelled)
                {
                    try { p.Kill(); } catch { }
                    try { p.WaitForExit(2000); } catch { }
                    throw new OperationCanceledException("已取消");
                }
            }
            p.CancelErrorRead();

            string stderr;
            lock (errBuf) { stderr = errBuf.ToString(); }

            if (p.ExitCode != 0)
            {
                throw new Exception("FFmpeg 合并失败（退出码 " + p.ExitCode + "）：" +
                                    stderr.Replace("\r", " ").Replace("\n", " ").Trim());
            }

            long size = 0;
            if (File.Exists(outFile)) size = new FileInfo(outFile).Length;
            if (size <= 0) throw new Exception("合并结果为空文件");

            WriteMessage("{\"type\":\"done\",\"ok\":true,\"output\":\"" + Escape(outFile) + "\",\"size\":" + size + "}");
        }
        catch (OperationCanceledException)
        {
            Log("合并已取消");
            WriteMessage("{\"type\":\"done\",\"ok\":false,\"cancelled\":true,\"error\":\"已取消\"}");
        }
        catch (Exception e)
        {
            Log("合并失败: " + e.ToString());
            WriteMessage("{\"type\":\"done\",\"ok\":false,\"error\":\"" + Escape(e.Message) + "\"}");
        }
        finally
        {
            try { if (File.Exists(tmpVideo)) File.Delete(tmpVideo); } catch { }
            try { if (File.Exists(tmpAudio)) File.Delete(tmpAudio); } catch { }
        }
    }

    // ---------------------------------------------------------------- 转码
    // ---------------------------------------------------------------- Transcode
    // 把音频流转成 mp3：宿主自己下载，再交给 ffmpeg。扩展侧因此不必把整个
    // 文件读进内存，也比纯 JS 编码器快得多。
    // Turn an audio stream into mp3: the host downloads it and hands it to ffmpeg, so the
    // extension never buffers the whole file and it is far faster than a pure-JS encoder.
    static void HandleTranscode(string raw)
    {
        string ffmpeg = FindFfmpeg();
        Log("transcode -> ffmpeg " + (ffmpeg == null ? "未找到" : ffmpeg));
        if (ffmpeg == null)
        {
            WriteMessage("{\"type\":\"done\",\"ok\":false,\"error\":\"未找到 ffmpeg.exe。请运行 native-host\\\\install.cmd 自动下载，或把 ffmpeg.exe 放到 native-host\\\\bin\\\\ 下。\"}");
            return;
        }

        string audioUrl = GetString(raw, "audioUrl");
        if (string.IsNullOrEmpty(audioUrl))
        {
            WriteMessage("{\"type\":\"done\",\"ok\":false,\"error\":\"缺少音频地址\"}");
            return;
        }

        string filename = SanitizeName(GetString(raw, "filename"));
        // 兜底名按目标格式来（正常都会传文件名） / fallback name follows the target format (a name is normally supplied)
        if (filename == "bilibili.mp4") filename = "bilibili.mp3";

        int bitrate = 192;
        string bitrateText = GetString(raw, "bitrate");
        if (!string.IsNullOrEmpty(bitrateText))
        {
            int parsed;
            if (int.TryParse(bitrateText, out parsed) && parsed >= 32 && parsed <= 320) bitrate = parsed;
        }

        string outDir = GetString(raw, "outDir");
        if (string.IsNullOrEmpty(outDir)) outDir = Environment.GetEnvironmentVariable("BILIDL_OUTDIR");
        if (string.IsNullOrEmpty(outDir))
        {
            outDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }

        // 先确认这份 ffmpeg 带 mp3 编码器，再开始下载：否则下完一遍才发现转不了，纯浪费
        // Check for the mp3 encoder before downloading; otherwise a build without it wastes the whole download
        string encoders = "";
        try { encoders = RunCapture(ffmpeg, "-hide_banner -encoders"); }
        catch { encoders = ""; }
        if (encoders.IndexOf("libmp3lame", StringComparison.OrdinalIgnoreCase) < 0)
        {
            WriteMessage("{\"type\":\"done\",\"ok\":false,\"error\":\"这份 ffmpeg 不带 libmp3lame（mp3 编码器），请换一个完整构建\"}");
            return;
        }

        hCancelled = false;   // 每次转码都从干净状态开始 / every transcode starts from a clean state
        hPaused = false;

        string id = Guid.NewGuid().ToString("N");
        string tmpAudio = Path.Combine(Path.GetTempPath(), "bilidl_" + id + "_t.m4s");
        string outFile = Path.Combine(outDir, filename);

        try
        {
            if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir);

            WriteMessage("{\"type\":\"progress\",\"phase\":\"download\",\"label\":\"音频\",\"percent\":1}");
            DownloadWithReferer(audioUrl, tmpAudio, 1, 69, "音频");

            WriteMessage("{\"type\":\"progress\",\"phase\":\"transcode\",\"percent\":80}");

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = ffmpeg;
            psi.Arguments = "-hide_banner -nostdin -y -loglevel error -i \"" + tmpAudio +
                            "\" -vn -c:a libmp3lame -b:a " + bitrate + "k \"" + outFile + "\"";
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            Log("ffmpeg " + psi.Arguments);
            Process p = Process.Start(psi);

            // 和合并一样：轮询等待，这样取消能立刻生效 / poll like the merge does, so cancel stays responsive
            StringBuilder errBuf = new StringBuilder();
            p.ErrorDataReceived += delegate (object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) { lock (errBuf) { errBuf.AppendLine(e.Data); } }
            };
            p.BeginErrorReadLine();
            while (!p.WaitForExit(200))
            {
                if (hCancelled)
                {
                    try { p.Kill(); } catch { }
                    try { p.WaitForExit(2000); } catch { }
                    throw new OperationCanceledException("已取消");
                }
            }
            p.CancelErrorRead();

            string stderr;
            lock (errBuf) { stderr = errBuf.ToString(); }

            if (p.ExitCode != 0)
            {
                throw new Exception("FFmpeg 转码失败（退出码 " + p.ExitCode + "）：" +
                                    stderr.Replace("\r", " ").Replace("\n", " ").Trim());
            }

            long size = 0;
            if (File.Exists(outFile)) size = new FileInfo(outFile).Length;
            if (size <= 0) throw new Exception("转码结果为空文件");

            WriteMessage("{\"type\":\"done\",\"ok\":true,\"output\":\"" + Escape(outFile) + "\",\"size\":" + size + "}");
        }
        catch (OperationCanceledException)
        {
            Log("转码已取消");
            WriteMessage("{\"type\":\"done\",\"ok\":false,\"cancelled\":true,\"error\":\"已取消\"}");
        }
        catch (Exception e)
        {
            // 记完整 ToString()（含内部异常与堆栈），一句笼统的 Message 没有排查价值
            // Log the full ToString() (inner exceptions and stack included); a bare Message tells nothing
            Log("转码失败: " + e.ToString());
            WriteMessage("{\"type\":\"done\",\"ok\":false,\"error\":\"" + Escape(e.Message) + "\"}");
        }
        finally
        {
            try { if (File.Exists(tmpAudio)) File.Delete(tmpAudio); } catch { }
        }
    }

    static string SanitizeName(string name)
    {
        // 兜底名不带 merged 之类的类型后缀（正常都走扩展传来的文件名）
        // Fallback name carries no type suffix such as "merged" (normally the name comes from the extension)
        if (string.IsNullOrEmpty(name)) return "bilibili.mp4";
        StringBuilder sb = new StringBuilder();
        foreach (char c in name)
        {
            if (c == '\\' || c == '/' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') continue;
            if (c < 32) continue;
            sb.Append(c);
        }
        string s = sb.ToString().Trim().Trim('.');
        return s.Length == 0 ? "bilibili.mp4" : s;
    }
}
