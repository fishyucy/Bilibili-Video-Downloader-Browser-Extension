# ===========================================================================
# 卸载 Native Messaging 宿主：删除注册表项与宿主清单
# Uninstall the Native Messaging host: remove the registry keys and the host manifest
#
# 与 install.ps1 同理，注册表操作用 .NET API —— PowerShell 的注册表 provider 在
# 多级路径上并不可靠，而 DeleteSubKeyTree 语义明确：连带子树一起删，不存在也不报错。
# Same reasoning as install.ps1: the registry work goes through the .NET API, because
# PowerShell's registry provider is unreliable on deep paths, while DeleteSubKeyTree has clear
# semantics -- it removes the whole subtree and stays quiet when the key is absent.
# ===========================================================================
$HostName = 'com.bilidl.merger'

$subKeys = @(
    'Software\Google\Chrome\NativeMessagingHosts\' + $HostName,
    'Software\Microsoft\Edge\NativeMessagingHosts\' + $HostName,
    'Software\Chromium\NativeMessagingHosts\' + $HostName,
    'Software\Tabbit Browser\NativeMessagingHosts\' + $HostName,
    'Software\TabbitBrowser\NativeMessagingHosts\' + $HostName,
    'Software\Tabbit\NativeMessagingHosts\' + $HostName
)

foreach ($sub in $subKeys) {
    $full = 'HKCU\' + $sub
    $rk = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub)
    if ($null -eq $rk) {
        Write-Host ('未安装: ' + $full) -ForegroundColor DarkGray
        continue
    }
    $rk.Close()

    # 第二个参数 $false = 键不存在时不抛错 / the second argument $false means "do not throw if absent"
    try {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($sub, $false)
        Write-Host ('已删除: ' + $full) -ForegroundColor Green
    } catch {
        Write-Host ('删除失败: ' + $full + ' —— ' + $_.Exception.Message) -ForegroundColor Red
    }
}

$manifestPath = Join-Path $PSScriptRoot ($HostName + '.json')
if (Test-Path -LiteralPath $manifestPath) {
    Remove-Item -LiteralPath $manifestPath -Force
    Write-Host ('已删除: ' + $manifestPath) -ForegroundColor Green
}
Write-Host '卸载完成。' -ForegroundColor Cyan
