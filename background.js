// 后台 Service Worker：兜底下载通道
// Background Service Worker: the fallback download channel
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
// 文件名纠正
// Filename correction
// chrome.downloads.download 的 filename 只是「建议名」，而且一旦本扩展注册了
// onDeterminingFilename，这个建议名会被直接忽略，改成由监听器说了算。
// The filename passed to chrome.downloads.download is only a suggestion, and as soon as this
// extension registers onDeterminingFilename that suggestion is ignored entirely -- the listener
// decides instead.
// 实测：URL 为 data: 时 Chrome 完全忽略 filename，落盘成默认名（中文环境是「下载」），
// 后缀也没了。所以这里记下「这次下载想要叫什么」，等 Chrome 定名时再改一次。
// Measured: with a data: URL Chrome ignores the filename outright and saves under the
// localized default name (「下载」in Chinese) with no extension. So record the intended name
// and rewrite it when Chrome asks.
// ---------------------------------------------------------------------------
const pendingNames = new Map();   // url 指纹 -> { filename, at } / url fingerprint -> { filename, at }
let lastPending = null;           // 最近一次请求的名字，供 data: 下载兜底 / most recent request, a fallback for data: downloads

function nameKey(url) {
    if (!url) return '';
    // data: URL 可能十几 MB，用「长度 + 头部指纹」当键，不把整串存下来
    // A data: URL can be tens of MB, so key it by length plus a head fingerprint rather than storing it whole
    if (url.lastIndexOf('data:', 0) === 0) return 'data:' + url.length + '|' + url.slice(0, 96);
    return url;
}

function rememberName(url, filename) {
    if (!url || !filename) return;
    const rec = { filename: filename, at: Date.now() };
    pendingNames.set(nameKey(url), rec);
    lastPending = rec;
    const now = Date.now();
    for (const [k, v] of pendingNames) {
        if (now - v.at > 120000) pendingNames.delete(k);   // 两分钟没等到就丢弃 / drop anything that never came back within two minutes
    }
}

if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
        // 1) URL 精确匹配（扩展直下走的 http(s) 地址走这条）
        // 1) Exact URL match (this is the path for extension downloads over http(s))
        for (const u of [item.finalUrl, item.url]) {
            const k = nameKey(u);
            const rec = k ? pendingNames.get(k) : null;
            if (rec) {
                pendingNames.delete(k);
                lastPending = null;
                console.log('[bili-dl] 纠正文件名 -> ' + rec.filename);
                suggest({ filename: rec.filename, conflictAction: 'uniquify' });
                return;
            }
        }
        // 2) data: 下载一定出自本扩展，内容无从比对，取最近一次请求的名字兜底
        // 2) A data: download can only come from this extension; its payload cannot be compared,
        //    so fall back to the most recent requested name
        const u = String(item.finalUrl || item.url || '');
        if (u.lastIndexOf('data:', 0) === 0 && lastPending && Date.now() - lastPending.at < 120000) {
            const rec = lastPending;
            lastPending = null;
            console.log('[bili-dl] 纠正文件名（data: 兜底）-> ' + rec.filename);
            suggest({ filename: rec.filename, conflictAction: 'uniquify' });
            return;
        }
        suggest();   // 不是本扩展发起的下载，不做任何改动 / not one of ours: leave it alone
    });
}

// ---------------------------------------------------------------------------
// 落盘：接收内容脚本传来的 blob（base64 的 data: URL），用扩展的下载接口保存。
// Save to disk: take the blob sent by the content script (as a base64 data: URL) and store
// it through the extension's own download API.
// 为什么需要这条路：B 站有时把播放器放进 sandbox iframe，页面内的 <a download> 会被浏览器
// 拒绝（"Download is disallowed. The frame initiating ... is sandboxed, but the flag
// 'allow-downloads' is not set"），文件根本落不了盘。扩展发起的下载不受页面沙箱约束。
// 注意：这里的 url 是 data:，Chrome 会忽略 filename 参数，文件名由上面的
// onDeterminingFilename 监听器改写回正确值 —— 别删那个监听器。
// Note: the url here is a data: URL, and Chrome ignores the filename parameter for those; the
// filename is restored by the onDeterminingFilename listener above -- do not remove it.
// Why this path is needed: Bilibili sometimes puts the player in a sandboxed iframe, where the
// browser refuses an in-page <a download> ("Download is disallowed. The frame initiating ...
// is sandboxed, but the flag 'allow-downloads' is not set") and the file never lands on disk.
// A download started by the extension is not subject to the page sandbox.
// ---------------------------------------------------------------------------
function saveBlobToDisk(dataUrl, filename) {
    return new Promise((resolve) => {
        try {
            if (!chrome.downloads || !chrome.downloads.download) {
                resolve({ ok: false, error: '扩展缺少 downloads 权限' });
                return;
            }
            rememberName(dataUrl, filename);   // 登记意图文件名，供 onDeterminingFilename 纠正 / record the intended name for onDeterminingFilename
            chrome.downloads.download({
                url: dataUrl,
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'save-blob') return undefined;   // 不处理的消息交还给其他监听器 / let other listeners have unrelated messages

    (async () => {
        startKeepAlive();   // 大文件落盘期间保住 Service Worker / hold the Service Worker alive while a big file is written
        try {
            const res = await saveBlobToDisk(msg.dataUrl, msg.filename);
            if (!res.ok) console.warn('[bili-dl] 扩展下载失败：' + res.error);
            else console.log('[bili-dl] 扩展下载已排队：' + msg.filename + ' (id=' + res.downloadId + ')');
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
// 保活：MV3 的 Service Worker 空闲 30 秒会被回收，大文件下载期间需要心跳保住它
// Keep-alive: MV3 Service Workers are reaped after 30s idle, so a heartbeat holds it alive during large downloads
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
