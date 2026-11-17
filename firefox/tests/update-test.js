// ===========================================================================
// update.js 测试（纯逻辑，不需要联网）
// update.js tests (pure logic, no network needed)
//   node tests/update-test.js
// ===========================================================================
const fs = require('fs');
const path = require('path');
const U = require(path.join(__dirname, '..', 'update.js'));

const lines = [];
const checks = [];
const log = (s) => lines.push(s);
const check = (name, cond, extra) => checks.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));

log('===== 1. 版本比较 =====');
check('v1.26.0 > 1.25.0', U.isNewer('v1.26.0', '1.25.0') === true);
check('1.25.0 = 1.25.0', U.isNewer('1.25.0', '1.25.0') === false);
check('1.25.1 > 1.25.0', U.isNewer('1.25.1', '1.25.0') === true);
check('1.25.0 < 1.25.1', U.isNewer('1.25.0', '1.25.1') === false);
check('1.26 > 1.25.9', U.isNewer('1.26', '1.25.9') === true);
check('v2.0.0 > 1.99.99', U.isNewer('v2.0.0', '1.99.99') === true);
check('1.25.0.0 = 1.25', U.isNewer('1.25.0.0', '1.25') === false);
check('空值不会报错', U.isNewer(null, undefined) === false && U.isNewer('', '') === false);
check('normalize 去掉 v 前缀', U.normalize(' v1.2.3 ') === '1.2.3', U.normalize(' v1.2.3 '));

log('\n===== 2. 安装包匹配 =====');
check('Chrome 安装包名', U.assetName('v1.26.0', false) === 'Bilibili-Video-Downloader-Browser-Extension-v1.26.0.zip',
    U.assetName('v1.26.0', false));
check('Firefox 安装包名', U.assetName('1.26.0', true) === 'Bilibili-Video-Downloader-Firefox-v1.26.0.xpi',
    U.assetName('1.26.0', true));

const assets = [
    { name: 'bili-dl-native-host-v1.26.0.zip', browser_download_url: 'https://example/host.zip' },
    { name: 'Bilibili-Video-Downloader-Browser-Extension-v1.26.0.zip', browser_download_url: 'https://example/chrome.zip' },
    { name: 'Bilibili-Video-Downloader-Firefox-v1.26.0.xpi', browser_download_url: 'https://example/firefox.xpi' }
];
check('Chrome 选 zip 而不是宿主包', U.pickAsset(assets, '1.26.0', false) === 'https://example/chrome.zip',
    U.pickAsset(assets, '1.26.0', false));
check('Firefox 选 xpi', U.pickAsset(assets, 'v1.26.0', true) === 'https://example/firefox.xpi',
    U.pickAsset(assets, 'v1.26.0', true));
check('缺包时返回空串', U.pickAsset(assets, '1.27.0', false) === '');
check('assets 非数组时不抛错', U.pickAsset(null, '1.26.0', false) === '');

log('\n===== 3. 浏览器识别 / 宿主包名 =====');
const uaChrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const uaEdge = uaChrome + ' Edg/140.0.0.0';
const uaFirefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0';
const uaOpera = uaChrome + ' OPR/120.0.0.0';
const uaVivaldi = uaChrome + ' Vivaldi/7.0';
const chromeName = 'B站视频/音频下载器 · Bilibili Video & Audio Downloader';
const firefoxName = 'B站视频/音频下载器（火狐版）';

check('Edge UA -> Edge', U.browserLabel(uaEdge, chromeName, false) === 'Edge');
check('Firefox UA -> Firefox', U.browserLabel(uaFirefox, chromeName, false) === 'Firefox');
check('Firefox 清单名 -> Firefox', U.browserLabel(uaChrome, firefoxName, false) === 'Firefox');
check('Chrome UA -> Chrome', U.browserLabel(uaChrome, chromeName, false) === 'Chrome');
check('Opera UA -> Opera', U.browserLabel(uaOpera, chromeName, false) === 'Opera');
check('Vivaldi UA -> Vivaldi', U.browserLabel(uaVivaldi, chromeName, false) === 'Vivaldi');
check('Brave 标志 -> Brave', U.browserLabel(uaChrome, chromeName, true) === 'Brave');
check('未知 UA -> Chromium', U.browserLabel('curl/8.0', chromeName, false) === 'Chromium');
check('Chrome 宿主包名', U.hostAssetName('v1.26.0', false) === 'bili-dl-native-host-v1.26.0.zip',
    U.hostAssetName('v1.26.0', false));
check('Firefox 宿主包名', U.hostAssetName('1.26.0', true) === 'bili-dl-native-host-firefox-v1.26.0.zip',
    U.hostAssetName('1.26.0', true));

log('\n===== 4. 发行版判断（Chromium 不能因为 browser 对象被误判） =====');
const chromeManifest = { version: '1.26.0', name: chromeName };
const fxManifest = { version: '1.26.0', name: firefoxName, browser_specific_settings: { gecko: { id: 'bili-dl@fishyucy.github.io' } } };
check('Chromium 清单 + chrome-extension URL -> false', U.isFirefoxBuild(chromeManifest, 'chrome-extension://abc/') === false);
check('Firefox 清单 + moz-extension URL -> true', U.isFirefoxBuild(fxManifest, 'moz-extension://abc/') === true);
check('Firefox 清单（无 URL）-> true', U.isFirefoxBuild(fxManifest, '') === true);
check('Chromium 清单 + moz-extension URL -> true（URL 兜底）', U.isFirefoxBuild(chromeManifest, 'moz-extension://abc/') === true);
check('空清单 + chrome-extension -> false', U.isFirefoxBuild(null, 'chrome-extension://abc/') === false);

log('\n===== 5. 「这个版本先不更新」跳过逻辑 =====');
check('有新版且未跳过 -> 提示', U.shouldPrompt('1.26.0', '1.25.0', '') === true);
check('已是最新 -> 不提示', U.shouldPrompt('1.26.0', '1.26.0', '') === false);
check('跳过当前最新版 -> 不提示', U.shouldPrompt('1.26.0', '1.25.0', '1.26.0') === false);
check('跳过 1.26 后出现 1.27 -> 提示', U.shouldPrompt('1.27.0', '1.25.0', '1.26.0') === true);
check('v 前缀不影响跳过判断', U.shouldPrompt('v1.26.0', '1.25.0', '1.26.0') === false);
check('跳过的是更老版本 -> 提示', U.shouldPrompt('1.26.0', '1.25.0', '1.24.0') === true);
check('空 latest 不提示', U.shouldPrompt('', '1.25.0', '') === false);

log('\n===== 结果 =====');
checks.forEach(c => log(c));
const fails = checks.filter(c => c.indexOf('FAIL') === 0).length;
log('\n共 ' + checks.length + ' 项，FAIL ' + fails + ' 项');
lines.forEach(l => console.log(l));
fs.writeFileSync(path.join(__dirname, 'update-last-run.txt'), lines.join('\n'), 'utf8');
process.exit(fails ? 1 : 0);
