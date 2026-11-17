// ===========================================================================
// update.js —— 更新提醒的纯逻辑（版本比较 / 安装包挑选，可在 Node 里单测）
// update.js -- pure helpers for the update reminder (version compare / asset pick, Node-testable)
// ===========================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.BiliUpdate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function normalize(version) {
        return String(version == null ? '' : version).trim().replace(/^v/i, '');
    }

    function parts(version) {
        return normalize(version).split('.').map(function (p) {
            var n = parseInt(p, 10);
            return isNaN(n) ? 0 : n;
        });
    }

    // latest > current 返回 true；只比较数字段，忽略 v 前缀与多余段
    // true when latest > current; numeric segments only, v prefix and extra segments ignored
    function isNewer(latest, current) {
        var a = parts(latest);
        var b = parts(current);
        var len = Math.max(a.length, b.length);
        for (var i = 0; i < len; i++) {
            var x = a[i] || 0;
            var y = b[i] || 0;
            if (x !== y) return x > y;
        }
        return false;
    }

    // 有新版、且没有被用户「这个版本先不更新」跳过时才提示
    // Prompt only when a newer version exists and was not skipped for this exact version
    function shouldPrompt(latest, current, skipped) {
        if (!isNewer(latest, current)) return false;
        if (skipped && normalize(skipped) === normalize(latest)) return false;
        return true;
    }

    function assetName(version, firefox) {
        return 'Bilibili-Video-Downloader-' + (firefox ? 'Firefox' : 'Browser-Extension') +
            '-v' + normalize(version) + (firefox ? '.xpi' : '.zip');
    }

    function hostAssetName(version, firefox) {
        return 'bili-dl-native-host' + (firefox ? '-firefox' : '') +
            '-v' + normalize(version) + '.zip';
    }

    // 用清单字段 / 扩展 URL 判断发行版；绝不看 window.browser ——
    // 某些 Chromium 浏览器也定义了 browser 兼容对象，会把 Chromium 误判成 Firefox。
    // Identify the edition from manifest fields / extension URL, never from window.browser:
    // some Chromium browsers also expose a browser compatibility object.
    function isFirefoxBuild(manifest, extensionUrl) {
        if (manifest && manifest.browser_specific_settings && manifest.browser_specific_settings.gecko) return true;
        return String(extensionUrl || '').indexOf('moz-extension://') === 0;
    }

    // 只用于按钮文案 / 提示；安装包仍按 Chromium / Firefox 两种版本区分
    // Used for labels only; packages are still chosen by the Chromium / Firefox edition
    function browserLabel(ua, manifestName, hasBrave) {
        var u = String(ua || '');
        var name = String(manifestName || '');
        if (/火狐|Firefox/i.test(name) || /Firefox\//.test(u)) return 'Firefox';
        if (/Edg\//.test(u)) return 'Edge';
        if (/OPR\//.test(u)) return 'Opera';
        if (/Vivaldi\//.test(u)) return 'Vivaldi';
        if (hasBrave || /Brave/.test(u)) return 'Brave';
        if (/Chrome\//.test(u)) return 'Chrome';
        return 'Chromium';
    }

    // assets 来自 GitHub Releases API：{ name, browser_download_url }
    // assets come from the GitHub Releases API: { name, browser_download_url }
    function pickAsset(assets, version, firefox) {
        var want = assetName(version, firefox);
        var list = Array.isArray(assets) ? assets : [];
        for (var i = 0; i < list.length; i++) {
            var a = list[i];
            if (!a || a.name !== want) continue;
            return a.url || a.browser_download_url || '';
        }
        return '';
    }

    return {
        normalize: normalize,
        isNewer: isNewer,
        shouldPrompt: shouldPrompt,
        assetName: assetName,
        hostAssetName: hostAssetName,
        isFirefoxBuild: isFirefoxBuild,
        browserLabel: browserLabel,
        pickAsset: pickAsset
    };
});
