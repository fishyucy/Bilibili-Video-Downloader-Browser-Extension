// 权限引导页：检查并请求「站点访问」权限。
// Permission guide page: checks and requests the site-access permission.
// Firefox 的 MV3 把 host_permissions 当作「可选权限」，安装后可能尚未授予；
// 没有站点访问时内容脚本不会注入，扩展等于失效 —— 这一页负责把用户引到授权按钮上。
// Firefox MV3 treats host_permissions as an optional permission that may not be granted at
// install time; without site access the content script is never injected and the extension
// cannot work -- this page guides the user to the grant button.
'use strict';

const SITE_ORIGINS = { origins: ['*://*/*'] };

const statusEl = document.getElementById('status');
const grantBtn = document.getElementById('grant');
const hintEl = document.getElementById('hint');

function render(granted, justGranted) {
    if (granted) {
        statusEl.textContent = '已授权 ✓ / Granted ✓';
        statusEl.className = 'status ok';
        grantBtn.disabled = true;
        grantBtn.textContent = '已开启 / Enabled';
        hintEl.textContent = justGranted
            ? '授权成功！请刷新已打开的 B 站视频页再使用。 / Granted! Reload any open Bilibili video page to start.'
            : '一切就绪，打开任意 B 站视频页即可看到右下角下载面板。 / All set -- open a Bilibili video page and the panel appears bottom-right.';
    } else {
        statusEl.textContent = '未授权 ✗ / Not granted ✗';
        statusEl.className = 'status miss';
        grantBtn.disabled = false;
        grantBtn.textContent = '开启站点访问权限 / Grant site access';
        hintEl.textContent = '未授权时扩展无法读取视频页，右下角面板不会出现。 / Without it the extension cannot read video pages and the panel will not appear.';
    }
}

function refresh(justGranted) {
    browser.permissions.contains(SITE_ORIGINS).then(function (granted) {
        render(granted, justGranted);
    }).catch(function () { /* 拿不到状态就维持现状 / keep the current state if the check fails */ });
}

grantBtn.addEventListener('click', function () {
    // 必须在用户手势里直接调用 request()：前面不要加任何 await，否则可能丢失用户激活。
    // request() must be called straight from the user gesture -- no await before it, or the
    // transient user activation may be lost.
    browser.permissions.request(SITE_ORIGINS).then(function (ok) {
        refresh(ok);
    }).catch(function (e) {
        hintEl.textContent = '请求失败 / Request failed: ' + (e && e.message ? e.message : e);
    });
});

// 用户在别处（about:addons）授权/撤销时，这一页也实时刷新
// Keep this page in sync when the user grants or revokes elsewhere (about:addons)
browser.permissions.onAdded.addListener(function () { refresh(); });
browser.permissions.onRemoved.addListener(function () { refresh(); });

refresh();
