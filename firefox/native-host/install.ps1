# ===========================================================================
# 安装 Native Messaging 宿主（Firefox 版）：写入宿主清单 + 注册表项（当前用户，不需要管理员）
# Install the Native Messaging host (Firefox edition): write the host manifest + registry key
# (current user, no admin required)
#
# 为什么注册表用 .NET API 而不是 New-Item / Set-Item：
# Why the registry work goes through the .NET API instead of New-Item / Set-Item:
#   PowerShell 的注册表 provider 下，New-Item -Path <多级路径> 并不可靠 ——
#   它可能不创建中间层，于是随后的 Set-Item 报「指定路径下的注册表项不存在」。
#   Under PowerShell's registry provider, New-Item -Path <deep path> is unreliable: it may not
#   create the intermediate keys, after which Set-Item fails with "the registry key does not exist".
#   .NET 的 CreateSubKey 会保证把整条链建出来。
#   .NET's CreateSubKey guarantees the whole chain is created.
# ===========================================================================
$ErrorActionPreference = 'Stop'

$HostName = 'com.bilidl.merger'
$ExtId = 'bili-dl@fishyucy.github.io'   # Firefox 用 gecko id，与 manifest.json 的 browser_specific_settings.gecko.id 一致

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
    allowed_extensions = @($ExtId)   # Firefox 读这个字段（Chrome 读的是 allowed_origins）
}
# 注意：必须写「无 BOM」的 UTF-8，Chrome 解析带 BOM 的 JSON 可能失败
# Note: must be BOM-less UTF-8 -- Chrome can fail to parse JSON that starts with a BOM
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '[1/3] 已生成宿主清单: ' -NoNewline -ForegroundColor Green
Write-Host $manifestPath

# 2) 写注册表（Firefox 版只写 Mozilla 键）
# 2) Write the registry key (the Firefox edition writes only the Mozilla key)
#    Firefox 在 Windows 上固定从 HKCU\Software\Mozilla\NativeMessagingHosts\<名字> 找宿主，
#    与 Chrome 各厂商键互不影响 —— 两个版本可以并存，各注册各的。
#    On Windows Firefox always looks under HKCU\Software\Mozilla\NativeMessagingHosts\<name>;
#    it does not touch the Chromium vendor keys, so the two editions can coexist.

function Register-HostKey([string]$subKey, [string]$value) {
    $rk = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey)
    if ($null -eq $rk) { throw ('CreateSubKey 返回空，无法创建 HKCU\' + $subKey) }
    try { $rk.SetValue('', $value, [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $rk.Close() }
}

# 写回读一遍，确认值真的落进去了（避免"看着成功其实没写"）
# Read it back to confirm the value really landed (guards against a silent no-op)
function Test-HostKey([string]$subKey, [string]$want) {
    $rk = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey)
    if ($null -eq $rk) { return $false }
    try { return ([string]$rk.GetValue('')) -eq $want }
    finally { $rk.Close() }
}

# 逐个 += 累加，不要写成 @( ... , ... )。
# 之前那种写法在这里被解析成了「嵌套数组」：整个 @() 只产出 1 个元素，而那个元素是
# 多个字符串组成的数组。于是循环只跑一轮，CreateSubKey 收到的是一串用空格连起来的
# 伪路径 —— 注册表里凭空多出一个名叫「键1 键2 键3…」的怪键，而浏览器真正要找的键
# 一个都没建出来，最后就是 "Specified native messaging host not found."
# Accumulate with += rather than a @( ... , ... ) literal: that form got parsed as a nested
# array here, so the loop ran once and CreateSubKey received one space-joined pseudo-path.
# The registry gained a single bogus key and none of the keys the browser looks for, which
# is exactly why it reported "Specified native messaging host not found."
$regSubKeys = @()
$regSubKeys += 'Software\Mozilla\NativeMessagingHosts\' + $HostName

# 先把数量打出来：应该是 1。不是就说明上面又写错了。
# Print the count first: it must be 1. Anything else means the lines above are malformed again.
Write-Host ('[2/3] 待注册注册表键: ' + $regSubKeys.Count + ' 个') -ForegroundColor Cyan

$failed = @()
foreach ($sub in $regSubKeys) {
    $full = 'HKCU\' + $sub
    try {
        Register-HostKey $sub $manifestPath
        if (Test-HostKey $sub $manifestPath) {
            Write-Host '[2/3] 已注册: ' -NoNewline -ForegroundColor Green
            Write-Host $full
        } else {
            Write-Host ('[2/3] 写入后读回不一致: ' + $full) -ForegroundColor Red
            $failed += $full
        }
    } catch {
        # 单个键失败不该让整个脚本停下：浏览器可能用的正是别的键
        # One bad key must not abort the run: the browser may well use a different one
        Write-Host ('[2/3] 注册失败: ' + $full + ' —— ' + $_.Exception.Message) -ForegroundColor Red
        $failed += $full
    }
}

# 3) 用 reg query 读回一遍 —— 这是最权威的验证：
#    「Specified native messaging host not found」几乎总是注册表没写进去，
#    所以与其猜，不如把注册表里真实的内容打出来。
# 3) Read it back with reg query -- the most authoritative check: "Specified native
#    messaging host not found" almost always means the registry write did not land, so print
#    what is really in the registry instead of guessing.
Write-Host ''
Write-Host '---- 注册表读回验证 / registry read-back ----' -ForegroundColor Cyan
foreach ($sub in $regSubKeys) {
    $full = 'HKCU\' + $sub
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'   # 查询失败不该中断脚本 / a failed query must not abort the script
    $out = & reg query $full /ve 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $saved
    if ($code -eq 0) {
        Write-Host ('  [OK] ' + $full) -ForegroundColor Green
        foreach ($l in $out) {
            $t = ('' + $l).Trim()
            if ($t.Length -gt 0) { Write-Host ('       ' + $t) }
        }
    } else {
        Write-Host ('  [缺失] ' + $full + ' —— 读不到这个键') -ForegroundColor Red
    }
}
Write-Host ''

# 4) 检查 ffmpeg
# 4) Look for ffmpeg
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
    Write-Host ''
    Write-Host '两条路，任选一条：' -ForegroundColor Cyan
    Write-Host '  [D] 下载一份（约 90MB，来自 GitHub）'
    Write-Host '  [F] 先在本机找现成的（推荐 —— 国内下载经常超时）'
    Write-Host '      找到后会把 ffmpeg.exe 复制进 native-host\bin\，以后一直用它。'
    $answer = Read-Host '选择 [D/F]，直接回车按 F 走'
    if ($answer -match '^[Dd]') {
        try {
            & (Join-Path $root 'get-ffmpeg.ps1')
        } catch {
            # 下载超时/失败不当成致命错误：本机往往就有一份能用的
            # A failed or timed-out download is not fatal: there is often a usable copy locally
            Write-Host ''
            Write-Host ('下载失败或超时：' + $_.Exception.Message) -ForegroundColor Red
            Write-Host '换成本机查找 ...' -ForegroundColor Yellow
            $finder = Join-Path $root 'find-ffmpeg.exe'
            if (Test-Path -LiteralPath $finder) { & $finder }
            else {
                Write-Host ('没找到 ' + $finder + ' —— 请先运行 build-host.cmd 重新编译。') -ForegroundColor Red
                Write-Host '也可以手动下载后，把 ffmpeg.exe 放到 native-host\bin\ 下。' -ForegroundColor Yellow
            }
        }
    } else {
        $finder = Join-Path $root 'find-ffmpeg.exe'
        if (Test-Path -LiteralPath $finder) { & $finder }
        else {
            Write-Host ('没找到 ' + $finder + ' —— 请先运行 build-host.cmd 重新编译。') -ForegroundColor Red
            Write-Host '也可以手动下载后，把 ffmpeg.exe 放到 native-host\bin\ 下。' -ForegroundColor Yellow
        }
    }
}

Write-Host ''
if ($failed.Count -gt 0) {
    Write-Host ('注意：有 ' + $failed.Count + ' 个键没能写入：') -ForegroundColor Yellow
    foreach ($f in $failed) { Write-Host ('  ' + $f) -ForegroundColor Yellow }
    Write-Host '若浏览器报「无法与宿主通信」，把上面的错误信息发回来即可。' -ForegroundColor Yellow
} else {
    Write-Host '安装完成。' -ForegroundColor Cyan
}
Write-Host ('扩展 ID: ' + $ExtId)
Write-Host '接下来：在 Firefox 里加载扩展（about:debugging#/runtime/this-firefox →「临时载入附加组件」选本目录的上一级文件夹里的 manifest.json），然后刷新 B 站页面。'
