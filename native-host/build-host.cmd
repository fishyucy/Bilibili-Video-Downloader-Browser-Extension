@echo off
rem Rebuild host.exe from host.cs using the .NET Framework compiler bundled with Windows.
cd /d "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo [ERROR] csc.exe not found. .NET Framework 4.x is required.
    pause
    exit /b 1
)
"%CSC%" /nologo /codepage:65001 /optimize+ /target:winexe /out:host.exe /r:System.Net.Http.dll host.cs
echo.
echo Build finished. Exit code: %ERRORLEVEL%
pause
