@echo off
rem Build ffmpeg-finder.exe from ffmpeg-finder.cs using the .NET Framework compiler bundled with Windows.
rem (No SDK needed. Keep this file ASCII-only: cmd.exe chokes on a BOM and mangles UTF-8 before chcp.)
cd /d "%~dp0"
chcp 65001 >nul
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo [ERROR] csc.exe not found. .NET Framework 4.x is required.
    pause
    exit /b 1
)
rem /target:exe = console program, so it can print progress and read your input.
rem /codepage:65001 = read the source as UTF-8 (the source also has a BOM; belt and braces).
"%CSC%" /nologo /codepage:65001 /optimize+ /target:exe /out:ffmpeg-finder.exe ffmpeg-finder.cs
echo.
echo Build finished. Exit code: %ERRORLEVEL%
echo If it printed errors and you have not edited the source, please send them back.
pause
