@echo off
rem ===========================================================================
rem  Rebuild the native host tools from source using the .NET Framework compiler
rem  bundled with Windows (no SDK needed). Produces two binaries:
rem
rem    host.exe          the Native Messaging host (windowless: /target:winexe)
rem    find-ffmpeg.exe   the FFmpeg locator (console app: /target:exe)
rem
rem  从源码重建两个可执行文件：host.exe（无窗口）与 find-ffmpeg.exe（控制台），
rem  编译完还会自动跑一遍宿主自检并把结果打出来。
rem
rem  注意：本文件必须保持「无 BOM 的 UTF-8 + CRLF」。cmd.exe 会把 BOM 当成
rem  第一条命令的一部分而直接报错；行尾用 CRLF 才稳。
rem  Note: keep this file BOM-less UTF-8 with CRLF line endings. cmd.exe treats a BOM as
rem  part of the first command and fails outright; CRLF is the safe line ending.
rem ===========================================================================

rem 先把控制台切到 UTF-8，否则下面的中文提示会是乱码
rem Switch the console to UTF-8 first, or the Chinese messages below come out garbled
chcp 65001 >nul

cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo [ERROR] csc.exe not found. .NET Framework 4.x is required.
    echo [错误] 没找到 csc.exe，需要 .NET Framework 4.x。
    pause
    exit /b 1
)

rem 公共编译开关 / shared compiler flags
rem   /codepage:65001  源码是 UTF-8；不指定的话编译器按系统代码页读，中文注释会乱
rem                    sources are UTF-8; without this the compiler reads them with the
rem                    system code page and Chinese comments come out garbled
set FLAGS=/nologo /codepage:65001 /optimize+ /warn:4

echo [1/3] 编译 host.exe ...
"%CSC%" %FLAGS% /target:winexe /out:host.exe /r:System.Net.Http.dll host.cs
if errorlevel 1 goto failed

echo [2/3] 编译 find-ffmpeg.exe ...
rem find_ffmpeg.cs 只用到 mscorlib / System.dll 里就有的类型（含 SHA256），无需额外 /r:
rem find_ffmpeg.cs only uses types already in mscorlib / System.dll (SHA256 included), so no extra /r: is needed
"%CSC%" %FLAGS% /target:exe /out:find-ffmpeg.exe find_ffmpeg.cs
if errorlevel 1 goto failed

echo.
echo [3/3] 跑一遍宿主自检 ...
rem host.exe 是 GUI 子系统程序，屏幕上什么都看不到，所以它把结果写成 selfcheck.txt
rem host.exe is a GUI-subsystem program and prints nothing on screen, so it writes selfcheck.txt
if exist selfcheck.txt del selfcheck.txt >nul 2>&1
"%~dp0host.exe" --selfcheck
if exist selfcheck.txt (
    echo.
    echo ---------- selfcheck.txt ----------
    type selfcheck.txt
    echo -----------------------------------
) else (
    echo [警告] 没有生成 selfcheck.txt —— 宿主可能一启动就失败了。
    echo [warn] selfcheck.txt was not produced -- the host may fail right at startup.
)

echo.
echo 编译完成，生成了 host.exe 与 find-ffmpeg.exe。
echo Build finished. Exit code: 0
echo.
echo 下一步：双击 install.cmd 注册宿主（如果还没注册过）。
echo Next: double-click install.cmd to register the host (if you have not yet).
pause
exit /b 0

:failed
echo.
echo [ERROR] 编译失败，请把上面的报错发回来。
echo [ERROR] Build failed. Please send the errors above back.
pause
exit /b 1
