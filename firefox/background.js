// 后台脚本：兜底下载通道
// Background script: the fallback download channel
// （Chrome 版里是 Service Worker；Firefox 版里是事件页 background.scripts ——
//   本文件两边共用，行为一致，注释里统一按「后台」称呼。）
// (A Service Worker in the Chrome edition; an event page loaded via background.scripts in
//   the Firefox edition -- this file is shared by both, so the comments just say "background".)
// 页面直连失败（如 CDN 未返回 CORS 头）时，由这里代发请求并分块回传数据。
// When the direct page fetch fails (say the CDN returned no CORS header), this issues the request and streams chunks back.
// B站 CDN 同时校验 Referer 和 Origin，这两个头属于 forbidden header name，
// The Bilibili CDN checks both Referer and Origin; they are forbidden header names, so setting them
// fetch 的 headers 里写会被浏览器丢弃，只能靠 declarativeNetRequest 在请求发出前改写。
// via fetch headers is silently dropped by the browser -- only declarativeNetRequest can rewrite them in flight.

const DOWNLOAD_HEADERS = {
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    'User-Agent': (self.navigator && self.navigator.userAgent) ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const REFERRER_HEADERS = [
    { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' },
    { header: 'Origin', operation: 'set', value: 'https://www.bilibili.com' }
];

const FLUSH_THRESHOLD = 4 * 1024 * 1024; // 每积累 4MB 回传一次，避免 Worker 内存堆积 / flush every 4MB to keep the Worker's memory in check
const PROGRESS_INTERVAL = 200;           // 进度回传节流（毫秒） / progress throttle (ms)

// ---------------------------------------------------------------------------
// 补 Referer / Origin 的规则
// Rules that inject Referer / Origin
//  规则 1：本扩展自身发起的所有请求（按 initiatorDomains 限定，不碰网页自己的请求）
//  Rule 1: every request this extension makes (scoped by initiatorDomains, page requests untouched)
//  规则 2~4：指向 B站 CDN 域名的请求（兜底，页面侧请求本来就带正确来源，覆盖也无害）
//  Rules 2-4: requests aimed at Bilibili CDN hosts (a fallback; page requests already carry the right origin, so overwriting harms nothing)
// ---------------------------------------------------------------------------
function buildRules() {
    const resourceTypes = ['xmlhttprequest', 'other', 'media', 'image'];
    return [
        {
            id: 1,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: REFERRER_HEADERS },
            condition: {
                urlFilter: '*',
                resourceTypes,
                initiatorDomains: [chrome.runtime.id]
            }
        },
        {
            id: 2,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: REFERRER_HEADERS },
            condition: { urlFilter: '||bilivideo.com', resourceTypes }
        },
        {
            id: 3,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: REFERRER_HEADERS },
            condition: { urlFilter: '||bilivideo.cn', resourceTypes }
        },
        {
            id: 4,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: REFERRER_HEADERS },
            condition: { urlFilter: '||hdslb.com', resourceTypes }
        }
    ];
}

function installHeaderRules() {
    const rules = buildRules();
    const removeRuleIds = rules.map(r => r.id);
    const done = () => {
        if (chrome.runtime.lastError) {
            console.warn('[bili-dl] 请求头规则注册失败:', chrome.runtime.lastError.message);
        } else {
            console.log('[bili-dl] 请求头规则已生效');
        }
    };
    try {
        chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules }, done);
    } catch (e) {
        console.warn('[bili-dl] 请求头规则注册异常:', e);
    }
}

chrome.runtime.onInstalled.addListener(installHeaderRules);
chrome.runtime.onStartup.addListener(installHeaderRules);

// ---------------------------------------------------------------------------
// 文件名
// Filenames
// Firefox 没有 Chrome 的 downloads.onDeterminingFilename（那是 Chrome 独有 API），
// 这里也完全不需要它：Firefox 会直接采纳 downloads.download 的 filename 参数，
// 名字与后缀在调用处就已经指定好了。（Chrome 版才有那段监听器，见兄弟项目。）
// Firefox has no downloads.onDeterminingFilename (that is a Chrome-only API), and none is
// needed: Firefox honours the filename parameter of downloads.download directly, so the name
// and extension are fixed at the call site. (Only the Chrome edition carries that listener.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 落盘：接收内容脚本传来的地址（首选页面生成的 blob: URL，回退 base64 data: URL），
// 用扩展自己的下载接口保存。
// Save to disk: take a URL from the content script (preferably a page-minted blob: URL, with a
// base64 data: URL as the small-file fallback) and store it via the extension's download API.
// 为什么这么绕：沙箱页面里 <a download> 会被浏览器拒绝，落盘只能由扩展发起；
// 而扩展消息单条上限 64MiB，大文件 base64 后必然超限（58MB 的 mp4 就是这么丢的），
// 所以大文件改为把页面里的 blob: URL 直接交给下载系统读取，字节不经过消息通道。
// Why the detour: in a sandboxed page <a download> is refused by the browser, so only the
// extension can save; but a single extension message caps at 64MiB, which a big file exceeds
// once base64'd (that is how a 58MB mp4 went missing). So big files hand the page's blob: URL to
// the download system instead -- the bytes never cross the messaging channel.
// 文件名不需要额外兜底：Firefox 会直接采纳 filename 参数（详见上面的说明）。
// No extra filename machinery is needed: Firefox honours the filename parameter directly
// (see the note above).
// ---------------------------------------------------------------------------
function saveBlobToDisk(url, filename) {
    return new Promise((resolve) => {
        try {
            if (!chrome.downloads || !chrome.downloads.download) {
                resolve({ ok: false, error: '扩展缺少 downloads 权限' });
                return;
            }
            chrome.downloads.download({
                url: url,
                filename: filename,
                saveAs: false,
                conflictAction: 'uniquify'   // 同名文件不覆盖，自动加 (1) / do not overwrite; append (1) instead
            }, (downloadId) => {
                const err = chrome.runtime.lastError;
                if (err) {
                    resolve({ ok: false, error: err.message || String(err) });
                    return;
                }
                if (typeof downloadId !== 'number' || downloadId < 0) {
                    resolve({ ok: false, error: '下载接口未返回有效 ID' });
                    return;
                }
                resolve({ ok: true, downloadId });
            });
        } catch (e) {
            resolve({ ok: false, error: String(e && e.message ? e.message : e) });
        }
    });
}

// ---------------------------------------------------------------------------
// blob: URL 的回收通知
// Releasing page blob: URLs
// blob: URL 的数据由「发起下载的那个页面」持有 —— 下载结束（完成或中断）后要通知它
// revokeObjectURL，否则那份数据会一直占着页面内存，直到页面关闭。
// A blob: URL's bytes are held by the page that minted it; once the download ends (complete or
// interrupted) that page must revoke it, or the data sits in page memory until the page closes.
// ---------------------------------------------------------------------------
const blobUrlByDownload = new Map();   // downloadId -> { url, tabId }

function releaseBlobUrl(rec) {
    if (!rec || rec.tabId === undefined || rec.tabId === null) return;
    try {
        chrome.tabs.sendMessage(rec.tabId, { type: 'release-object-url', url: rec.url }, () => {
            // 页面可能已经关掉；读一下 lastError 把它消费掉，免得控制台报未检查的错误
            // The page may be gone; reading lastError consumes it and keeps the console clean
            void chrome.runtime.lastError;
        });
    } catch (e) { /* ignore */ }
}

function trackBlobUrl(downloadId, url, tabId) {
    blobUrlByDownload.set(downloadId, { url: url, tabId: tabId });
    // 小文件可能在登记之前就已经走完流程，补查一次状态
    // A small file may already have finished before we got here; check its state once
    try {
        chrome.downloads.search({ id: downloadId }, (items) => {
            const it = items && items[0];
            if (!it || (it.state !== 'complete' && it.state !== 'interrupted')) return;
            const rec = blobUrlByDownload.get(downloadId);
            if (!rec) return;
            blobUrlByDownload.delete(downloadId);
            releaseBlobUrl(rec);
        });
    } catch (e) { /* ignore */ }
}

if (chrome.downloads && chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
        if (!delta || !delta.state) return;
        const st = delta.state.current;
        if (st !== 'complete' && st !== 'interrupted') return;
        const rec = blobUrlByDownload.get(delta.id);
        if (!rec) return;
        blobUrlByDownload.delete(delta.id);
        releaseBlobUrl(rec);
    });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || (msg.type !== 'save-blob' && msg.type !== 'save-blob-url')) {
        return undefined;   // 不处理的消息交还给其他监听器 / let other listeners have unrelated messages
    }

    (async () => {
        startKeepAlive();   // 落盘期间保住 Service Worker / hold the Service Worker alive while a file is written
        try {
            const url = msg.type === 'save-blob-url' ? msg.url : msg.dataUrl;
            const res = await saveBlobToDisk(url, msg.filename);
            if (!res.ok) console.warn('[bili-dl] 扩展下载失败：' + res.error);
            else {
                console.log('[bili-dl] 扩展下载已排队' + (msg.type === 'save-blob-url' ? '（blob）' : '（data）') +
                    '：' + msg.filename + ' (id=' + res.downloadId + ')');
                // blob: URL 的数据挂在这个页面上，下载结束后要通知它释放（见上面 trackBlobUrl）
                // The blob: URL's bytes are held by the sending page; ping it to release once done
                if (msg.type === 'save-blob-url') {
                    trackBlobUrl(res.downloadId, msg.url, sender && sender.tab ? sender.tab.id : undefined);
                }
            }
            sendResponse(res);
        } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        } finally {
            stopKeepAlive();
        }
    })();

    return true;   // 异步响应，保持通道打开 / keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// 保活：Chrome 的 MV3 Service Worker 空闲 30 秒会被回收，大文件下载期间需要心跳保住它。
// （Firefox 版是事件页，没有这个回收机制；这段逻辑留着无害，也方便两边代码保持一致。）
// Keep-alive: Chrome's MV3 Service Workers are reaped after 30s idle, so a heartbeat holds
// it alive during large downloads. (The Firefox edition uses an event page without that
// reaper; keeping this logic costs nothing and keeps both editions identical.)
// ---------------------------------------------------------------------------
let keepAliveTimer = null;
let activeCount = 0;

function startKeepAlive() {
    activeCount++;
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
        try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* ignore */ }
    }, 20000);
}

function stopKeepAlive() {
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount === 0 && keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
}

// ---------------------------------------------------------------------------
// 下载：边读边把数据分块推给内容脚本
// Download: read and push chunks to the content script as they arrive
// ---------------------------------------------------------------------------
function concatChunks(chunks, totalLength) {
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
        merged.set(chunks[i], offset);
        offset += chunks[i].length;
    }
    return merged;
}

// 单次下载的可控状态：暂停用「读取前过门」实现，取消用 AbortController + 标志位
// Per-download control state: pausing gates each read, cancelling uses AbortController plus a flag
function createDlState() {
    return {
        controller: new AbortController(),
        paused: false,
        cancelled: false,
        waiters: []
    };
}

function cancelledErr() {
    const e = new Error('已取消');
    e.cancelled = true;
    return e;
}

// 暂停时挂起在等 promise；取消时统一 reject 掉
// While paused the readers park on a promise; on cancel they are all rejected at once
function releaseDlWaiters(state, asError) {
    const waiters = state.waiters;
    state.waiters = [];
    waiters.forEach(w => { asError ? w.reject(cancelledErr()) : w.resolve(); });
}

async function gateDl(state) {
    if (state.cancelled) throw cancelledErr();
    if (!state.paused) return;
    await new Promise((resolve, reject) => state.waiters.push({ resolve: resolve, reject: reject }));
}

async function runDownload(port, url, state) {
    const res = await fetch(url, {
        method: 'GET',
        headers: DOWNLOAD_HEADERS,
        credentials: 'omit',
        cache: 'no-store',
        signal: state.controller.signal
    });

    const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    console.log(`[bili-dl] 后台响应 status=${res.status} content-type=${res.headers.get('content-type')} 声明长度=${total}`);

    if (!res.ok) {
        port.postMessage({ type: 'error', message: `网络请求失败: 状态码 ${res.status}（多为防盗链拦截）` });
        return;
    }
    if (!res.body) {
        port.postMessage({ type: 'error', message: '响应无主体内容' });
        return;
    }

    const reader = res.body.getReader();
    let chunks = [];
    let buffered = 0;
    let loaded = 0;
    let lastProgressAt = 0;

    const flush = () => {
        if (!chunks.length) return;
        const merged = concatChunks(chunks, buffered);
        chunks = [];
        buffered = 0;
        port.postMessage({ type: 'chunk', buffer: merged.buffer });
    };

    while (true) {
        await gateDl(state);   // 暂停点：暂停时卡在这里，取消时抛错 / pause point: parks here while paused, throws when cancelled
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        buffered += value.length;
        loaded += value.length;

        const now = Date.now();
        if (total && now - lastProgressAt > PROGRESS_INTERVAL) {
            lastProgressAt = now;
            port.postMessage({ type: 'progress', percent: Math.min(99, Math.round((loaded / total) * 100)) });
        }

        if (buffered >= FLUSH_THRESHOLD) flush();
    }

    flush();
    console.log(`[bili-dl] 后台实收 ${loaded} 字节`);

    if (state.cancelled) {
        port.postMessage({ type: 'error', message: '已取消', cancelled: true });
        return;
    }
    if (loaded === 0) {
        port.postMessage({ type: 'error', message: '后台下载到 0 字节（CDN 防盗链拦截）' });
        return;
    }

    port.postMessage({ type: 'progress', percent: 100 });
    port.postMessage({ type: 'done' });
}

// ---------------------------------------------------------------------------
// 原生 FFmpeg 宿主（Native Messaging）
// Native FFmpeg host (Native Messaging)
// 扩展沙箱里跑不了 C 程序，只能通过宿主进程调用原生 ffmpeg。
// An extension sandbox cannot run C programs, so native ffmpeg is reached through a host process.
// 宿主名必须与注册表项、宿主清单文件名、host.cs 内部的约定一致。
// The host name must match the registry key, the host manifest filename and the convention inside host.cs.
// ---------------------------------------------------------------------------
const NATIVE_HOST = 'com.bilidl.merger';

function safePost(port, msg) {
    try { port.postMessage(msg); } catch (e) { /* 页面已关闭 */ }
}

function nativePing() {
    return new Promise((resolve) => {
        let port;
        try {
            port = chrome.runtime.connectNative(NATIVE_HOST);
        } catch (e) {
            resolve({ ok: false, error: String(e && e.message ? e.message : e) });
            return;
        }
        let settled = false;
        const done = (res) => {
            if (settled) return;
            settled = true;
            try { port.disconnect(); } catch (e) { /* ignore */ }
            resolve(res);
        };
        port.onMessage.addListener((m) => done(m || { ok: false, error: '宿主返回空响应' }));
        port.onDisconnect.addListener(() => {
            const err = chrome.runtime.lastError;
            done({ ok: false, error: err && err.message ? err.message : '原生宿主未响应' });
        });
        port.postMessage({ action: 'ping' });
        setTimeout(() => done({ ok: false, error: '原生宿主响应超时' }), 8000);
    });
}

function nativeMerge(msg, onProgress, onPort) {
    return new Promise((resolve, reject) => {
        let port;
        try {
            port = chrome.runtime.connectNative(NATIVE_HOST);
        } catch (e) {
            reject(new Error(String(e && e.message ? e.message : e)));
            return;
        }
        if (onPort) onPort(port);   // 交给上层，取消时好下发 cancel / handed to the caller so it can dispatch a cancel
        let settled = false;
        const finish = (err, res) => {
            if (settled) return;
            settled = true;
            try { port.disconnect(); } catch (e) { /* ignore */ }
            if (err) reject(err); else resolve(res);
        };
        port.onMessage.addListener((m) => {
            if (!m) return;
            if (m.type === 'progress') { onProgress(m); return; }
            if (m.type === 'done') {
                if (m.ok) {
                    finish(null, m);
                } else {
                    const err = new Error(m.error || 'FFmpeg 合并失败');
                    if (m.cancelled) err.cancelled = true;
                    finish(err);
                }
            }
        });
        port.onDisconnect.addListener(() => {
            const err = chrome.runtime.lastError;
            finish(new Error(err && err.message ? err.message : '原生宿主连接中断'));
        });
        port.postMessage({
            action: 'merge',
            videoUrl: msg.videoUrl,
            audioUrl: msg.audioUrl,
            filename: msg.filename
        });
    });
}

// ---------------------------------------------------------------------------
// 原生宿主转码：宿主自己下载音频流，再交给 ffmpeg 转 mp3。
// Native host transcoding: the host downloads the audio itself and hands it to ffmpeg.
// 比扩展内的纯 JS 编码器快得多，扩展侧也不必把整个文件读进内存。
// Far faster than the in-extension pure-JS encoder, and the extension never buffers the file.
// ---------------------------------------------------------------------------
function nativeTranscode(msg, onProgress, onPort) {
    return new Promise((resolve, reject) => {
        let port;
        try {
            port = chrome.runtime.connectNative(NATIVE_HOST);
        } catch (e) {
            reject(new Error(String(e && e.message ? e.message : e)));
            return;
        }
        if (onPort) onPort(port);   // 交给上层，取消时好下发 cancel / handed to the caller so it can dispatch a cancel
        let settled = false;
        const finish = (err, res) => {
            if (settled) return;
            settled = true;
            try { port.disconnect(); } catch (e) { /* ignore */ }
            if (err) reject(err); else resolve(res);
        };
        port.onMessage.addListener((m) => {
            if (!m) return;
            if (m.type === 'progress') { onProgress(m); return; }
            if (m.type === 'done') {
                if (m.ok) {
                    finish(null, m);
                } else {
                    const err = new Error(m.error || 'FFmpeg 转码失败');
                    if (m.cancelled) err.cancelled = true;
                    finish(err);
                }
            }
        });
        port.onDisconnect.addListener(() => {
            const err = chrome.runtime.lastError;
            finish(new Error(err && err.message ? err.message : '原生宿主连接中断'));
        });
        port.postMessage({
            action: 'transcode',
            audioUrl: msg.audioUrl,
            filename: msg.filename,
            bitrate: msg.bitrate || 192
        });
    });
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'bili-dl') return;

    let dl = null;             // 本条连接的下载状态（暂停 / 取消） / download state for this connection (pause / cancel)
    let nativePort = null;     // 本条连接的原生宿主 port / native host port for this connection

    port.onMessage.addListener(async (msg) => {
        if (!msg) return;

        // ---- 控制消息：暂停 / 继续 / 取消 ----
        // ---- Control messages: pause / resume / cancel ----
        if (msg.type === 'pause') {
            if (dl) { dl.paused = true; console.log('[bili-dl] 后台下载已暂停'); }
            return;
        }
        if (msg.type === 'resume') {
            if (dl) { dl.paused = false; releaseDlWaiters(dl, false); console.log('[bili-dl] 后台下载已继续'); }
            return;
        }
        if (msg.type === 'cancel') {
            if (dl) {
                dl.cancelled = true;
                dl.paused = false;
                releaseDlWaiters(dl, true);
                try { dl.controller.abort(); } catch (e) { /* ignore */ }
                console.log('[bili-dl] 后台下载已取消');
            }
            return;
        }
        if (msg.type === 'nativeCancel') {
            if (nativePort) {
                try { nativePort.postMessage({ action: 'cancel' }); } catch (e) { /* 宿主可能已退出 */ }
                console.log('[bili-dl] 已向原生宿主发送取消');
            }
            return;
        }

        if (msg.type === 'download') {
            dl = createDlState();
            startKeepAlive();
            try {
                await runDownload(port, msg.url, dl);
            } catch (err) {
                if (err && (err.cancelled || err.name === 'AbortError')) {
                    safePost(port, { type: 'error', message: '已取消', cancelled: true });
                } else {
                    console.error('[bili-dl] 后台下载失败:', err);
                    safePost(port, { type: 'error', message: `下载失败: ${err && err.message ? err.message : err}` });
                }
            } finally {
                dl = null;
                stopKeepAlive();
            }
            return;
        }

        if (msg.type === 'nativePing') {
            const res = await nativePing();
            console.log('[bili-dl] 原生宿主探测:', res);
            safePost(port, {
                type: 'nativePingResult',
                ok: !!res.ok,
                ffmpeg: res.ffmpeg || '',
                version: res.version || '',
                error: res.error || ''
            });
            return;
        }

        if (msg.type === 'nativeMerge') {
            startKeepAlive();
            try {
                const res = await nativeMerge(msg, (m) => {
                    safePost(port, { type: 'nativeProgress', phase: m.phase, label: m.label, percent: m.percent });
                }, (p) => { nativePort = p; });
                console.log('[bili-dl] 宿主合并完成:', res.output, res.size);
                safePost(port, { type: 'nativeDone', ok: true, output: res.output, size: res.size });
            } catch (err) {
                if (err && err.cancelled) console.log('[bili-dl] 宿主合并已取消');
                else console.error('[bili-dl] 宿主合并失败:', err);
                safePost(port, {
                    type: 'nativeDone',
                    ok: false,
                    cancelled: !!(err && err.cancelled),
                    error: err && err.message ? err.message : String(err)
                });
            } finally {
                nativePort = null;
                stopKeepAlive();
            }
            return;
        }

        if (msg.type === 'nativeTranscode') {
            startKeepAlive();
            try {
                const res = await nativeTranscode(msg, (m) => {
                    safePost(port, { type: 'nativeProgress', phase: m.phase, label: m.label, percent: m.percent });
                }, (p) => { nativePort = p; });
                console.log('[bili-dl] 宿主转码完成:', res.output, res.size);
                safePost(port, { type: 'nativeDone', ok: true, output: res.output, size: res.size });
            } catch (err) {
                if (err && err.cancelled) console.log('[bili-dl] 宿主转码已取消');
                else console.error('[bili-dl] 宿主转码失败:', err);
                safePost(port, {
                    type: 'nativeDone',
                    ok: false,
                    cancelled: !!(err && err.cancelled),
                    error: err && err.message ? err.message : String(err)
                });
            } finally {
                nativePort = null;
                stopKeepAlive();
            }
            return;
        }
    });
});
