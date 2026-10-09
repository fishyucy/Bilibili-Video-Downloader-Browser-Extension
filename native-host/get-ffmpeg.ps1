# ===========================================================================
# 下载 FFmpeg 静态构建（GitHub BtbN/FFmpeg-Builds）并抽出 ffmpeg.exe 到 native-host\bin\
# Download a static FFmpeg build (GitHub BtbN/FFmpeg-Builds) and extract ffmpeg.exe into native-host\bin\
# ===========================================================================
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$root = $PSScriptRoot
$binDir = Join-Path $root 'bin'
$zipPath = Join-Path $env:TEMP 'ffmpeg-bilidl.zip'
$url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'

Write-Host '正在下载 FFmpeg（约 90MB，来自 GitHub BtbN/FFmpeg-Builds）...' -ForegroundColor Cyan
Write-Host $url

$client = New-Object System.Net.Http.HttpClient
# 超时压到 5 分钟：国内直连 GitHub 常连不上，与其干等 30 分钟，不如早点失败交给
# find-ffmpeg.exe 去本机找现成的。
# Timeout trimmed to 5 minutes: GitHub is often unreachable from China, and failing early beats
# burning 30 minutes -- install.cmd then hands over to find-ffmpeg.exe to look locally instead.
$client.Timeout = [TimeSpan]::FromMinutes(5)
[void]$client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', 'Mozilla/5.0')
try {
    $resp = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
} catch {
    $client.Dispose()
    throw ('下载失败或超时（5 分钟）：' + $_.Exception.Message)
}
if (-not $resp.IsSuccessStatusCode) {
    $code = [int]$resp.StatusCode
    $client.Dispose()
    throw ('下载失败: HTTP ' + $code)
}

$total = 0
if ($resp.Content.Headers.ContentLength) { $total = [long]$resp.Content.Headers.ContentLength }
$inStream = $resp.Content.ReadAsStreamAsync().Result
$outStream = [System.IO.File]::Create($zipPath)
try {
    $buf = New-Object byte[] 262144
    $loaded = 0
    $lastPct = -1
    while ($true) {
        $n = $inStream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $outStream.Write($buf, 0, $n)
        $loaded += $n
        if ($total -gt 0) {
            $pct = [int](($loaded / $total) * 100)
            if ($pct -ne $lastPct) {
                $lastPct = $pct
                Write-Progress -Activity '下载 FFmpeg' -Status ("$pct%  (" + [int]($loaded / 1MB) + 'MB / ' + [int]($total / 1MB) + 'MB)') -PercentComplete $pct
            }
        }
    }
} finally {
    $outStream.Close()
    $inStream.Close()
    $client.Dispose()
}
Write-Progress -Activity '下载 FFmpeg' -Completed

Write-Host '正在解压...' -ForegroundColor Cyan
$extractDir = Join-Path $env:TEMP 'ffmpeg-bilidl-extract'
if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

$found = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
if (-not $found) { throw '压缩包里没有找到 ffmpeg.exe' }

if (-not (Test-Path -LiteralPath $binDir)) { New-Item -ItemType Directory -Force -Path $binDir | Out-Null }
Copy-Item -LiteralPath $found.FullName -Destination (Join-Path $binDir 'ffmpeg.exe') -Force

Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ('完成：' + (Join-Path $binDir 'ffmpeg.exe')) -ForegroundColor Green
