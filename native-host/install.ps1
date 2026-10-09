# ===========================================================================
# 安装 Native Messaging 宿主：写入宿主清单 + 注册表项（当前用户，不需要管理员）
# Install the Native Messaging host: write the host manifest + registry keys (current user, no admin required)
# ===========================================================================
$ErrorActionPreference = 'Stop'

$HostName = 'com.bilidl.merger'
$ExtId = 'djhojijihfclaicehnnpjodjdjpcceha'   # 由 manifest.json 里的 "key" 固定，与扩展 ID 一致

$root = $PSScriptRoot
$hostExe = Join-Path $root 'host.exe'
$manifestPath = Join-Path $root ($HostName + '.json')

if (-not (Test-Path -LiteralPath $hostExe)) {
    throw ('未找到 ' + $hostExe + ' —— 请先运行 build-host.cmd 编译宿主')
}

# 1) 写宿主清单
# 1) Write the host manifest
$manifest = [ordered]@{
    name = $HostName
    description = 'BiliDL FFmpeg 合并宿主'
    path = $hostExe
    type = 'stdio'
    allowed_origins = @('chrome-extension://' + $ExtId + '/')
}
# 注意：必须写「无 BOM」的 UTF-8，Chrome 解析带 BOM 的 JSON 可能失败
# Note: must be BOM-less UTF-8 -- Chrome can fail to parse JSON that starts with a BOM
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '[1/3] 已生成宿主清单: ' -NoNewline -ForegroundColor Green
Write-Host $manifestPath

# 2) 写注册表（各种 Chromium 系浏览器都写一遍，用不到的不影响）
# 2) Write the registry keys (every Chromium-based browser gets one; unused ones do no harm)
#    每个 Chromium 分支在自己的厂商键下找 NativeMessagingHosts，键名写多了不会有副作用。
#    Each Chromium fork looks under its own vendor key for NativeMessagingHosts; extra keys are harmless.
$regKeys = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $HostName,
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + $HostName,
    'HKCU:\Software\Chromium\NativeMessagingHosts\' + $HostName,
    'HKCU:\Software\Tabbit Browser\NativeMessagingHosts\' + $HostName,
    'HKCU:\Software\TabbitBrowser\NativeMessagingHosts\' + $HostName,
    'HKCU:\Software\Tabbit\NativeMessagingHosts\' + $HostName
)
foreach ($key in $regKeys) {
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    try {
        Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
    } catch {
        Set-Item -Path $key -Value $manifestPath
    }
    Write-Host '[2/3] 已注册: ' -NoNewline -ForegroundColor Green
    Write-Host $key
}

# 3) 检查 ffmpeg
# 3) Look for ffmpeg
function Find-Ffmpeg {
    $candidates = New-Object System.Collections.ArrayList
    if ($env:BILIDL_FFMPEG) { [void]$candidates.Add($env:BILIDL_FFMPEG) }
    [void]$candidates.Add((Join-Path $root 'bin\ffmpeg.exe'))
    $cmd = Get-Command 'ffmpeg' -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { [void]$candidates.Add($cmd.Source) }
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path } }
    return $null
}

$ffmpeg = Find-Ffmpeg
if ($ffmpeg) {
    Write-Host '[3/3] 已找到 FFmpeg: ' -NoNewline -ForegroundColor Green
    Write-Host $ffmpeg
} else {
    Write-Host '[3/3] 未找到 FFmpeg。' -ForegroundColor Yellow
    $answer = Read-Host '是否现在自动下载 FFmpeg（约 90MB，来自 GitHub BtbN 构建）? [Y/N]'
    if ($answer -match '^[Yy]') {
        & (Join-Path $root 'get-ffmpeg.ps1')
    } else {
        Write-Host '已跳过。可稍后运行 native-host\get-ffmpeg.cmd 下载，或自行把 ffmpeg.exe 放到 native-host\bin\ 下。' -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Cyan
Write-Host ('扩展 ID: ' + $ExtId)
Write-Host '接下来：到 chrome://extensions 重新加载扩展（若还没加载过就先加载本目录的上一级文件夹），然后刷新 B 站页面。'
