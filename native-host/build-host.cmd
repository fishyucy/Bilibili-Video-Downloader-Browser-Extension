@echo off
rem ===========================================================================
rem  Rebuild the native host tools from source using the .NET Framework compiler
rem  bundled with Windows (no SDK needed). Produces two binaries:
rem
rem    host.exe          the Native Messaging host (windowless: /target:winexe)
rem    find-ffmpeg.exe   the FFmpeg locator (console app: /target:exe)
rem
rem  从源码重建两个可执行文件：host.exe（无窗口）与 find-ffmpeg.exe（控制台）。
rem ===========================================================================
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
rem   /codepage:65001  源码是 UTF-8，不指定的话编译器会按系统代码页读，中文注释会乱
rem                    sources are UTF-8; without this the compiler reads them with the
rem                    system code page and Chinese comments come out garbled
set FLAGS=/nologo /codepage:65001 /optimize+ /w:4

echo [1/2] 编译 host.exe ...
"%CSC%" %FLAGS% /target:winexe /out:host.exe /r:System.Net.Http.dll host.cs
if errorlevel 1 goto :failed

echo [2/2] 编译 find-ffmpeg.exe ...
"%CSC%" %FLAGS% /target:exe /out:find-ffmpeg.exe find_ffmpeg.cs
if errorlevel 1 goto :failed

echo.
echo Build finished. Exit code: 0
echo 编译完成，生成了 host.exe 与 find-ffmpeg.exe。
pause
exit /b 0

:failed
echo.
echo [ERROR] Build failed. 编译失败，请把上面的报错发回来。
pause
exit /b 1
