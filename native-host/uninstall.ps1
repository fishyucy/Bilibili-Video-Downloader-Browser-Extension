# ===========================================================================
# 卸载 Native Messaging 宿主：删除注册表项与宿主清单
# Uninstall the Native Messaging host: remove the registry keys and the host manifest
# ===========================================================================
$HostName = 'com.bilidl.merger'
$keys = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $HostName,
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + $HostName,
    'HKCU:\Software\Chromium\NativeMessagingHosts\' + $HostName
)
foreach ($key in $keys) {
    if (Test-Path $key) {
        Remove-Item -Path $key -Recurse -Force
        Write-Host ('已删除: ' + $key) -ForegroundColor Green
    } else {
        Write-Host ('未安装: ' + $key) -ForegroundColor DarkGray
    }
}
$manifestPath = Join-Path $PSScriptRoot ($HostName + '.json')
if (Test-Path -LiteralPath $manifestPath) {
    Remove-Item -LiteralPath $manifestPath -Force
    Write-Host ('已删除: ' + $manifestPath) -ForegroundColor Green
}
Write-Host '卸载完成。' -ForegroundColor Cyan
