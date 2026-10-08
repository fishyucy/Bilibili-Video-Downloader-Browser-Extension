// ===========================================================================
// content.js —— B 站视频/音频下载器 · 页面内容脚本
// content.js -- Bilibili video/audio downloader, page content script
//
// 职责：在视频页注入右下角面板（档位菜单 / 下载按钮 / 暂停取消），
// Job: inject the bottom-right panel into a video page (tier menu / download buttons / pause+cancel),
//       解析分P、取流、下载、合并；耗时与跨域受限的部分交给后台 Service Worker，
//   resolve parts, fetch streams, download and merge; the slow, CORS-constrained parts go to the background SW,
//       装了 native-host 时优先走原生 FFmpeg。
//   and the native FFmpeg host is preferred when native-host is installed.
//
// 依赖同目录下按 manifest.json 顺序先加载的模块（挂到 window 上）：
// Depends on sibling modules loaded first in manifest.json order (each attached to window):
//   quality.js  画质/音质纯逻辑（选流、编码识别、诊断文案）
//   quality.js  pure quality/tier logic (stream picking, codec detection, diagnostic text)
//   wbi.js      WBI 签名
//   wbi.js      WBI signature
//   muxer.js    分片 MP4 重封装
//   muxer.js    fragmented-MP4 remux
// ===========================================================================

(function () {
    'use strict';

    // 启动横幅：装好后控制台第一行就能看到版本号，方便确认浏览器跑的是哪份代码
    // Startup banner: the version shows up on the first console line, making it obvious which
    // copy of the code the browser actually loaded
    let EXT_VERSION = '?';
    try { EXT_VERSION = chrome.runtime.getManifest().version; } catch (e) { /* 扩展上下文异常 / extension context gone */ }
    console.log('[bili-dl] 内容脚本已加载 v' + EXT_VERSION + '（' + location.href.split('?')[0] + '）');


    // ===================== 工具函数 =====================
    // ===================== Utilities =====================
    // 只剔除 Windows 文件名真正非法的字符，保留中文、空格和【】（）等全角符号，保证标题可读
    // Strip only characters Windows truly forbids; keep CJK, spaces and full-width punctuation so titles stay readable
    function sanitizeFilename(name, maxLen) {
        const len = maxLen || 60;
        const cleaned = String(name || '')
            .replace(/[\\/:*?"<>|]/g, '')      // Windows 非法字符 / illegal on Windows
            .replace(/[\u0000-\u001F\u007F]/g, '')  // 控制字符 / control characters
            .replace(/\s+/g, ' ')              // 折叠连续空白 / collapse runs of whitespace
            .trim()
            .replace(/^[.\s]+|[.\s]+$/g, '');  // 去掉首尾的点与空格（Windows 不允许以点结尾） / trim leading/trailing dots and spaces (Windows forbids a trailing dot)
        return cleaned.slice(0, len) || 'bilibili_video';
    }

    // 统一提示出口。页面有可能被放进沙箱 iframe，此时 alert() 会被浏览器拦下并抛异常
    // （"The document is sandboxed, and the 'allow-modals' keyword is not set"），
    // 那样连「下载成功」的提示都会变成报错。所以：能用 alert 就用（保持原体验），被拦就退回页面内浮层。
    // Single exit point for messages. The page can sit inside a sandboxed iframe where alert()
    // is blocked and throws ("The document is sandboxed, and the 'allow-modals' keyword is not
    // set") -- which would turn even a "download finished" notice into an error. So: use alert
    // when allowed, otherwise fall back to an in-page toast.
    function notify(msg) {
        try {
            window.alert(msg);
            return;
        } catch (e) {
            // 沙箱化文档不允许弹窗，改用浮层 / sandboxed: no modals allowed, use the toast
        }
        showToast(String(msg));
    }

    // 页面内浮层：不依赖面板样式，也不需要 allow-modals 权限；点一下可关掉
    // In-page toast: independent of the panel styles, needs no allow-modals, click to dismiss
    function showToast(msg) {
        try {
            let box = document.getElementById('bili-dl-toast');
            if (!box) {
                box = document.createElement('div');
                box.id = 'bili-dl-toast';
                box.style.cssText = [
                    'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
                    'max-width:420px', 'max-height:60vh', 'overflow:auto',
                    'padding:12px 14px', 'border-radius:8px',
                    'background:rgba(20,24,32,.96)', 'color:#fff',
                    'font:12px/1.6 Consolas,Menlo,monospace', 'white-space:pre-wrap',
                    'box-shadow:0 8px 28px rgba(0,0,0,.5)', 'border:1px solid rgba(0,161,214,.6)',
                    'cursor:pointer'
                ].join(';');
                box.title = '点击关闭';
                box.addEventListener('click', () => { box.style.display = 'none'; });
                document.body.appendChild(box);
            }
            box.textContent = msg;
            box.style.display = 'block';
            clearTimeout(showToast._timer);
            showToast._timer = setTimeout(() => { box.style.display = 'none'; }, 12000);
        } catch (e) {
            // 连浮层都插不进去（极罕见），至少保证控制台有记录
            // If even the toast cannot be inserted (very rare), at least log it
            console.log('[bili-dl] 提示：' + msg);
        }
    }

    // 从页面标题兜底解析视频主标题（接口取不到时才用）
    // Fallback: parse the main title from the page title (used only when the API gives none)
    function parseMainTitleFromDocument() {
        const t = document.title || '';
        const patterns = [
            /^(.+?)\s*_\s*B站/,
            /^(.+?)_-/,
            /^(.+?)\s*_\s*哔哩哔哩/,
            /^(.+?)\s*-\s*哔哩哔哩/,
            /^(.+?)\s*_\s*bilibili/i
        ];
        for (let i = 0; i < patterns.length; i++) {
            const m = t.match(patterns[i]);
            if (m && m[1] && m[1].trim()) return m[1].trim();
        }
        return '';
    }

    // 从URL提取BV号和当前分P页码
    // Extract the BV id and the current part number from the URL
    function getBvidAndPage() {
        const bvidMatch = location.href.match(/BV([a-zA-Z0-9]+)/);
        const bvid = bvidMatch ? 'BV' + bvidMatch[1] : '';
        const urlParams = new URLSearchParams(window.location.search);
        let p = parseInt(urlParams.get('p'), 10);
        if (isNaN(p) || p < 1) p = 1;
        return { bvid, p };
    }

    // ===================== 获取分P列表 =====================
    // ===================== Fetch the part list =====================
    // 通过 pagelist 接口获取该BV下所有分P的 cid 和 part 标题
    // Use the pagelist endpoint to get every part's cid and part title for this BV
    async function getPageList(bvid) {
        const res = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
            headers: { 'Referer': 'https://www.bilibili.com/' }
        }).then(r => r.json());
        if (res.code !== 0) throw new Error('获取分P列表失败');
        return res.data; // [{ cid, part, page, ... }, ...]
    }

    // 获取当前分P的信息（cid + 标题）
    // Info for the current part (cid + title)
    async function getCurrentPageInfo() {
        const { bvid, p } = getBvidAndPage();
        if (!bvid) throw new Error('未识别到BV号');

        const pages = await getPageList(bvid);
        if (!pages || pages.length === 0) throw new Error('分P列表为空');

        // p 从1开始，数组索引 p-1
        // p is 1-based, so the array index is p-1
        const page = pages[p - 1] || pages[0];

        // 获取 aid 与视频主标题
        // Fetch the aid and the video's main title
        const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
            headers: { 'Referer': 'https://www.bilibili.com/' }
        }).then(r => r.json());
        const aid = viewRes.code === 0 ? viewRes.data.aid : '';
        const rawMainTitle = (viewRes.code === 0 && viewRes.data && viewRes.data.title)
            ? String(viewRes.data.title).trim()
            : '';
        // 优先用接口返回的标题，取不到再退回解析页面标题
        // Prefer the title from the API; fall back to parsing the page title
        const mainTitle = sanitizeFilename(rawMainTitle || parseMainTitleFromDocument(), 80);

        // 分P名：仅多P视频才拼到文件名里
        // Part name: only appended to the filename for multi-part videos
        const partTitle = page.part ? page.part.trim() : `P${p}`;
        const cleanPart = sanitizeFilename(partTitle, 40);
        const hasMultiPage = pages.length > 1;

        let title;
        if (mainTitle) {
            title = (hasMultiPage && cleanPart) ? `${mainTitle}_${cleanPart}` : mainTitle;
        } else {
            title = cleanPart || `P${p}`;
        }

        return {
            aid,
            bvid,
            cid: page.cid,
            title,
            p,
            total: pages.length
        };
    }

    // 统一拼输出文件名：单P视频不带 P 号（多P才带），也不再拼 audio / video / merged 之类后缀。
    // 只有通道 C 的兜底合并结果需要多一个「完整版」标记 —— 否则会和它的两个输入文件同名，
    // ffmpeg 会直接报「输出文件与输入文件相同」。
    // Single source of truth for output names: only multi-part videos carry a P marker, and no
    // audio / video / merged type suffix is appended any more. The one exception is the channel-C
    // fallback merge output, which needs a distinct name or ffmpeg refuses to run
    // ("output file same as input").
    function outputName(info, ext, suffix) {
        const partTag = info.total > 1 ? `_p${info.p}` : '';
        return `${info.title}${partTag}${suffix || ''}.${ext}`;
    }

    // ===================== 画质 / 音质 =====================
    // ===================== Quality / audio tiers =====================
    // fnval 位标志：DASH(16) + HDR(64) + 4K(128) + 杜比音频(256) + 杜比视界(512) + 8K(1024) + AV1(2048)
    // fnval bit flags: DASH(16) + HDR(64) + 4K(128) + Dolby audio(256) + Dolby Vision(512) + 8K(1024) + AV1(2048)
    // 全开才能让接口把账号权限内的最高档流都返回出来
    // All bits on, otherwise the API will not return every tier the account is entitled to
    const PLAYURL_FNVAL = 4048;

    // 纯逻辑都放在 quality.js 里（可单测），这里取本地别名，调用处保持简洁
    // All pure logic lives in quality.js (unit-testable); local aliases keep the call sites tidy
    const Q = window.BiliQuality;
    if (!Q) {
        console.error('[bili-dl] quality.js 未加载（请检查 manifest.json 的 content_scripts 顺序）');
        return;
    }
    const VIDEO_QUALITY_NAMES = Q.VIDEO_QUALITY_NAMES;
    const AUDIO_QUALITY_NAMES = Q.AUDIO_QUALITY_NAMES;
    const qualityLabel = Q.qualityLabel;
    const kbps = Q.kbps;
    const codecFamily = Q.codecFamily;
    const optionValue = Q.optionValue;
    const optionLabel = Q.optionLabel;
    const pickBest = Q.pickBest;
    const pickByKey = Q.pickByKey;
    const sortStreams = Q.sortStreams;
    const streamUrls = Q.streamUrls;
    const collectAudio = Q.collectAudio;
    const qualitySummary = Q.summarize;

    // 杜比视界（id 126）在不支持 DV 的播放器上可能偏色，介意的话改成 true
    // Dolby Vision (id 126) can shift colours on players without DV support; set to true if that bothers you
    const EXCLUDE_DOLBY_VISION = false;

    // 账号状态 + WBI 密钥：一次 nav 请求同时拿到，缓存 10 分钟
    // Account state + WBI keys come from one nav request, cached for 10 minutes
    // 账号状态直接决定能拿到几档画质（未登录 480P 封顶，登录 1080P，大会员 4K/8K）
    // Account state decides the tier ceiling: anonymous 480P, logged in 1080P, premium 4K/8K
    let navCache = { at: 0, account: null, mixinKey: '' };
    const NAV_TTL = 10 * 60 * 1000;

    async function getNavInfo() {
        if (navCache.at && (Date.now() - navCache.at) < NAV_TTL) return navCache;

        let nav = null;
        try {
            nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
                .then(r => r.json());
        } catch (e) {
            console.warn('[bili-dl] nav 接口请求失败（不影响下载，只是缺少 WBI 密钥）：', e && e.message);
        }

        // 未登录时 nav 的 code 是 -101，但 data.wbi_img 依然会返回，所以不能只看 code
        // When logged out nav returns code -101 yet data.wbi_img is still present, so never trust code alone
        const data = (nav && nav.data) || null;
        const wbi = data && data.wbi_img;
        let mixinKey = '';
        if (wbi && wbi.img_url && wbi.sub_url && window.BiliWbi) {
            mixinKey = window.BiliWbi.mixinKeyFromUrls(wbi.img_url, wbi.sub_url);
        }

        navCache = { at: Date.now(), account: data, mixinKey: mixinKey };
        if (data) {
            console.log(`[bili-dl] 账号状态：${data.isLogin ? ('已登录 ' + (data.uname || '')) : '未登录'}` +
                `，大会员=${data.vipStatus ? '是' : '否'}，WBI 密钥=${mixinKey ? '已获取' : '未获取'}`);
        }
        return navCache;
    }

    function logAvailableStreams(dash) {
        const v = (dash.video || []).map(s =>
            `${qualityLabel(VIDEO_QUALITY_NAMES, s.id)}/${s.width}x${s.height}/${codecFamily(s.codecs)}/${kbps(s.bandwidth)}`);
        const a = collectAudio(dash).map(s =>
            `${qualityLabel(AUDIO_QUALITY_NAMES, s.id)}/${codecFamily(s.codecs)}/${kbps(s.bandwidth)}`);
        console.log('[bili-dl] 接口返回的视频流：' + (v.length ? v.join('  |  ') : '无'));
        console.log('[bili-dl] 接口返回的音频流：' + (a.length ? a.join('  |  ') : '无'));
    }

    // ===================== 获取 DASH 播放地址 =====================
    // ===================== Fetch the DASH playback URLs =====================
    // 单次取流请求：优先带 WBI 签名的现行接口，失败退旧接口，再失败退匿名。
    // One stream request: prefer the current WBI-signed endpoint, fall back to the legacy one, then to anonymous.
    // 关键：必须带 Cookie（credentials: 'include'）。fetch 默认是 same-origin，
    // Critical: cookies must be sent (credentials: 'include'). fetch defaults to same-origin and
    // 而 api.bilibili.com 相对页面属跨域 → 默认不会发 SESSDATA，等于匿名请求，
    // api.bilibili.com is cross-origin from the page, so SESSDATA is dropped by default = an anonymous
    // 那样无论 qn 填多少，B 站都只给 480P。
    // request, and no matter what qn says Bilibili then caps you at 480P.
    async function requestPlayUrl(bvid, cid, params) {
        const q = Object.assign({ bvid: bvid, cid: cid }, params);
        const nav = await getNavInfo();
        let res = null;

        if (nav.mixinKey && window.BiliWbi) {
            try {
                const query = window.BiliWbi.signedQuery(q, nav.mixinKey);
                res = await fetch(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, {
                    credentials: 'include',
                    headers: { 'Referer': 'https://www.bilibili.com/' }
                }).then(r => r.json());
                if (!res || res.code !== 0) {
                    console.warn(`[bili-dl] wbi 接口返回 ${res && res.code} ${res && res.message}，改用旧接口`);
                    res = null;
                }
            } catch (e) {
                console.warn('[bili-dl] wbi 接口请求异常，改用旧接口：', e && e.message);
                res = null;
            }
        }

        if (!res) {
            const qs = Object.keys(q).sort().map(k =>
                encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
            const url = 'https://api.bilibili.com/x/player/playurl?' + qs;
            try {
                res = await fetch(url, {
                    credentials: 'include',
                    headers: { 'Referer': 'https://www.bilibili.com/' }
                }).then(r => r.json());
            } catch (e) {
                // 万一服务端没给 Access-Control-Allow-Credentials，退回匿名请求（画质会被限制，但至少能用）
                // If the server ever omits Access-Control-Allow-Credentials, retry anonymously (quality suffers, but it works)
                console.warn('[bili-dl] 带凭据请求被拒，退回匿名请求（画质将受限）：', e && e.message);
                res = await fetch(url, { headers: { 'Referer': 'https://www.bilibili.com/' } }).then(r => r.json());
            }
        }

        if (!res || res.code !== 0) {
            throw new Error('获取播放地址失败: ' + ((res && (res.message || res.code)) || '无响应'));
        }
        const dash = res.data && res.data.dash;
        if (!dash) throw new Error('该视频没有 DASH 流（可能是受限内容或需要更高权限）');
        return dash;
    }

    // --------------------------------------------------- Hi-Res 触发条件探测
    // --------------------------------------------------- Hi-Res trigger probe
    // 官方文档里 fnval 没有「无损音频」位（已知位是 1/16/64/128/256/512/1024/2048/16384，
    // The official docs have no "lossless audio" fnval bit (known bits are 1/16/64/128/256/512/1024/2048/16384,
    // 4096 与 8192 是空档），而 4K/HDR/8K 都要求「qn=对应档位」。
    // leaving 4096 and 8192 unused), while 4K/HDR/8K each demand "qn = that tier".
    // 实测：大会员账号下杜比全景声能拿到，但 flac.display=true 却 flac.audio=null。
    // Measured: on a premium account Dolby Atmos comes through, yet flac.display=true with flac.audio=null.
    // 所以这里用几组候选参数实测，哪组真能拿到无损音轨就记住哪组。
    // So we probe a few candidate parameter sets and remember whichever one actually returns the lossless track.
    // 注意：不改主请求的参数，避免为了音频反而压低视频档位；探测只取音轨。
    // Note: the main request keeps its parameters -- chasing audio must not lower the video tier; probes fetch audio only.
    const HIRES_ATTEMPTS = [
        { tag: 'qn=30251', params: { qn: 30251, fnval: PLAYURL_FNVAL, fnver: 0, fourk: 1 } },
        { tag: 'qn=30251&fnval|4096', params: { qn: 30251, fnval: PLAYURL_FNVAL | 4096, fnver: 0, fourk: 1 } },
        { tag: 'fnval|4096', params: { qn: 127, fnval: PLAYURL_FNVAL | 4096, fnver: 0, fourk: 1 } },
        { tag: 'qn=30251&fnval|8192', params: { qn: 30251, fnval: PLAYURL_FNVAL | 8192, fnver: 0, fourk: 1 } }
    ];
    // 已实测确认：网页端接口不下发 Hi-Res 音轨（详见 navCache 里的诊断说明），
    // Confirmed by measurement: the web API never serves the Hi-Res track (see the diagnosis in navCache),
    // 所以探测默认关闭，避免每条有无损音轨的视频白跑 5 次请求。
    // so the probe is off by default to spare 5 pointless requests on every lossless-capable video.
    // 若日后 B 站网页端开放了该音轨，把它改成 true 即可自动找出可用的参数组合。
    // If Bilibili ever opens it up on the web, flip this to true and the probe finds the working parameter set.
    const HIRES_PROBE = false;
    let hiresStrategy = '';          // 命中的参数组合 tag，命中后优先复用 / tag of the winning parameter set, reused first once found
    const hiresFailedVideos = {};    // 探测失败过的 bvid（按视频记，换个视频仍会再试一次） / bvids whose probe failed (per video, so other videos still get a try)

    const PLAYURL_KEY_PARAMS = ['qn', 'fnval', 'fnver', 'fourk', 'platform', 'otype',
        'session', 'high_quality', 'try_look', 'voice_balance'];

    // 网页播放器自己的取流请求就躺在性能记录里（含完整查询串），可以拿来对照：
    // The web player's own stream request sits in the performance timeline (full query string included),
    // 它带了什么参数、有没有我们没带的。这是判断「网页端到底能不能拿 Hi-Res」的关键依据。
    // showing exactly which parameters it sends. That is the key evidence for whether the web can get Hi-Res at all.
    function pagePlayerPlayUrlParams() {
        try {
            const entries = performance.getEntriesByType('resource')
                .filter(e => e.name.indexOf('playurl') >= 0);
            if (!entries.length) {
                console.log('[bili-dl] 未在性能记录里找到网页播放器的取流请求（可能已被缓冲区淘汰）');
                return null;
            }
            const last = entries[entries.length - 1];
            const u = new URL(last.name);
            const p = {};
            u.searchParams.forEach((v, k) => { p[k] = v; });

            console.log('[bili-dl] 网页播放器自己的取流请求：' + u.pathname);
            console.log('   ' + PLAYURL_KEY_PARAMS.filter(k => p[k] !== undefined)
                .map(k => k + '=' + p[k]).join('&'));
            const known = ['bvid', 'avid', 'cid', 'wts', 'w_rid'].concat(PLAYURL_KEY_PARAMS);
            const extra = Object.keys(p).filter(k => known.indexOf(k) < 0);
            if (extra.length) {
                console.log('[bili-dl] 播放器还带了这些参数（我们没带）：' +
                    extra.map(k => k + '=' + p[k]).join('&'));
            }
            return { params: p, url: last.name };
        } catch (e) {
            console.warn('[bili-dl] 读取播放器取流请求失败：', e && e.message);
            return null;
        }
    }

    function hasFlacAudio(dash) {
        return !!(dash && dash.flac && Array.isArray(dash.flac.audio) && dash.flac.audio.length);
    }

    async function probeHiRes(bvid, cid, dash) {
        if (!HIRES_PROBE) return;                                // 已确认网页接口拿不到，默认不做无用请求 / web API confirmed unable to serve it, so skip pointless requests
        if (!dash || !dash.flac || !dash.flac.display) return;   // 视频本身没有无损音轨 / this video has no lossless track
        if (hasFlacAudio(dash)) return;                          // 已经拿到了 / already obtained
        if (hiresFailedVideos[bvid]) return;                     // 这个视频已经试过，确实拿不到 / already probed for this video, genuinely unavailable

        // 命中过的组合排最前，避免每次重复试错
        // Put the previously winning combination first so we stop re-guessing every time
        const list = hiresStrategy
            ? HIRES_ATTEMPTS.filter(a => a.tag === hiresStrategy)
                .concat(HIRES_ATTEMPTS.filter(a => a.tag !== hiresStrategy))
            : HIRES_ATTEMPTS;

        // 先看网页播放器自己用的什么参数 —— 它要也要不到，就说明是端侧限制
        // First check what the player itself asks for -- if even that cannot get it, it is a client-side restriction
        console.log('[bili-dl] 视频有无损音轨但默认参数没返回，开始探测触发条件：' + list.map(a => a.tag).join(' / '));
        const player = pagePlayerPlayUrlParams();

        // 最直接的证据：把播放器那条请求原样重放一遍，看「网页端自己」到底拿到了什么
        // The most direct evidence: replay the player's own request verbatim to see what the web client really gets
        if (player && player.url) {
            try {
                const r = await fetch(player.url, {
                    credentials: 'include',
                    headers: { 'Referer': 'https://www.bilibili.com/' }
                }).then(r => r.json());
                const d = r && r.data && r.data.dash;
                if (d && hasFlacAudio(d)) {
                    // 播放器自己那条请求能拿到 → 直接沿用
                    // The player's own request did get it -> reuse that result
                    hiresStrategy = '重放播放器请求';
                    dash.flac = d.flac;
                    return;
                }
            } catch (e) {
                console.warn('[bili-dl] 重放播放器请求失败：', e && e.message);
            }
        }

        if (player && player.params) {
            const src = player.params;
            const copy = { qn: 127, fnval: PLAYURL_FNVAL, fnver: 0, fourk: 1 };
            if (src.qn !== undefined) copy.qn = Number(src.qn);
            if (src.fnval !== undefined) copy.fnval = Number(src.fnval);
            if (src.fnver !== undefined) copy.fnver = Number(src.fnver);
            if (src.fourk !== undefined) copy.fourk = Number(src.fourk);
            list.push({ tag: '照抄播放器参数', params: copy });
        }

        for (let i = 0; i < list.length; i++) {
            try {
                const d = await requestPlayUrl(bvid, cid, list[i].params);
                if (hasFlacAudio(d)) {
                    hiresStrategy = list[i].tag;
                    dash.flac = d.flac;   // 并回主结果，菜单里就能列出 Hi-Res / merge back into the main result so the menu can list Hi-Res
                    console.log(`[bili-dl] ✅ Hi-Res 探测成功：「${list[i].tag}」拿到 ${d.flac.audio.length} 条无损音轨（已记住这组参数）`);
                    return;
                }
            } catch (e) {
                console.warn(`[bili-dl] Hi-Res 探测「${list[i].tag}」请求失败：`, e && e.message);
            }
        }
        hiresFailedVideos[bvid] = true;
        console.warn('[bili-dl] Hi-Res 探测：' + list.map(a => a.tag).join(' / ') + ' 都没拿到无损音轨（网页端不下发该音轨）');
    }

    async function getDashPlayUrl(bvid, cid) {
        await getNavInfo();
        const dash = await requestPlayUrl(bvid, cid, { qn: 127, fnval: PLAYURL_FNVAL, fnver: 0, fourk: 1 });

        // 必须在填充菜单之前探测，否则菜单里会缺 Hi-Res 这一档
        // The probe must run before the menu is filled, otherwise the Hi-Res option is missing from it
        await probeHiRes(bvid, cid, dash);

        logAvailableStreams(dash);
        populateStreamMenu(bvid, cid, dash);

        // 画质上不去时，说清楚是账号权限问题而不是脚本问题
        // When quality is capped, make it clear it is an account entitlement issue rather than a script problem
        if (dash.video && dash.video.length) {
            const top = pickBest(dash.video, 'video');
            if (top.id < 80) {
                const account = navCache.account;
                console.warn(`[bili-dl] 当前账号能拿到的最高画质只有 ${qualityLabel(VIDEO_QUALITY_NAMES, top.id)}。` +
                    (account && account.isLogin
                        ? '已登录但非大会员，1080P 以上（4K/8K/HDR/杜比）需要大会员。'
                        : '未登录状态下 B 站最高只给 480P；登录后可达 1080P，大会员可达 4K/8K。'));
            }
        }
        return dash;
    }

    function getBestVideoStream(dash) {
        if (!dash.video || !dash.video.length) return null;
        let list = dash.video;
        if (EXCLUDE_DOLBY_VISION) {
            const filtered = list.filter(s => s.id !== 126);
            if (filtered.length) list = filtered;
        }
        const chosen = currentSelection('video');
        const best = pickByKey(list, chosen, 'video');
        if (best.id === 126 && chosen === 'auto') {
            console.warn('[bili-dl] 自动选中的是杜比视界流，普通播放器可能偏色；可以在菜单里手动选其他档位');
        }
        console.log(`[bili-dl] 选中视频：${qualityLabel(VIDEO_QUALITY_NAMES, best.id)} ` +
            `${best.width}x${best.height} ${(best.codecs || '').split('.')[0]} ${kbps(best.bandwidth)}` +
            `（备用地址 ${streamUrls(best).length - 1} 个）`);
        return {
            urls: streamUrls(best),
            url: best.baseUrl,
            quality: best.id,
            bandwidth: best.bandwidth,
            codecs: best.codecs,
            width: best.width,
            height: best.height
        };
    }

    function getBestAudioStream(dash) {
        // Hi-Res 在 dash.flac.audio、杜比在 dash.dolby.audio，必须归集后才能选到
        // Hi-Res lives in dash.flac.audio and Dolby in dash.dolby.audio; they must be collected before they can be picked
        const list = collectAudio(dash);
        if (!list.length) return null;
        const best = pickByKey(list, currentSelection('audio'), 'audio');
        console.log(`[bili-dl] 选中音频：${qualityLabel(AUDIO_QUALITY_NAMES, best.id)} ` +
            `${(best.codecs || '').split('.')[0]} ${kbps(best.bandwidth)}` +
            `（备用地址 ${streamUrls(best).length - 1} 个）`);
        return {
            urls: streamUrls(best),
            url: best.baseUrl,
            quality: best.id,
            bandwidth: best.bandwidth,
            codecs: best.codecs
        };
    }

    // ===================== Blob 下载核心逻辑 =====================
    // ===================== Blob download core =====================
    // 拿到流数据（不落盘）：页面直连下载 → 失败则交给后台 Service Worker 兜底 → 仍为空则报错
    // Fetch stream data (no disk write): direct page download -> fall back to the background SW -> error if still empty
    // 依次尝试主地址与各备用 CDN 地址。高码率（4K/8K）文件常有单个节点抽风的情况，
    // Try the primary URL and every backup CDN in turn. On high-bitrate 4K/8K files a single node often misbehaves,
    // 有了 backupUrl 兜底就不必重新点一次。
    // and the backupUrl safety net saves you from clicking download again.
    async function fetchStreamBlob(urlOrUrls, filename, onProgress) {
        const urls = (Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls]).filter(Boolean);
        if (!urls.length) throw new Error('没有可用的播放地址');

        let lastError = null;
        for (let i = 0; i < urls.length; i++) {
            try {
                if (i > 0) console.warn(`[bili-dl] 改用备用地址 ${i}/${urls.length - 1}`);
                return await fetchOneUrl(urls[i], filename, onProgress);
            } catch (e) {
                if (isCancelled(e)) throw e;   // 取消就不要再去试备用地址了 / on cancel, do not go on to the backup URLs
                lastError = e;
                console.warn(`[bili-dl] 地址 ${i + 1}/${urls.length} 下载失败：`, e && e.message);
            }
        }
        throw new Error('所有播放地址均失败：' + (lastError ? lastError.message : '未知原因'));
    }

    async function fetchOneUrl(url, filename, onProgress) {
        let directError = null;

        // 通道 1：页面内直接 fetch。
        // Channel 1: fetch straight from the page.
        // 浏览器会自动带上页面自己的 Referer / Origin（B站 CDN 校验的就是这两个），
        // The browser automatically sends the page's own Referer / Origin (exactly what the Bilibili CDN checks),
        // 和播放器自身拉流的方式一致，成功率最高。
        // identical to how the player pulls its own streams, so this succeeds most often.
        try {
            const direct = await fetchToBlob(url, filename, onProgress);
            if (direct && direct.size > 0) {
                console.log(`[bili-dl] 页面直连下载完成：${direct.size} 字节`);
                return direct;
            }
            directError = new Error('页面直连下载返回 0 字节');
        } catch (err) {
            if (isCancelled(err)) throw err;   // 用户主动取消，不要再换通道重试 / user cancelled, do not retry on another channel
            directError = err;
        }
        console.warn('[bili-dl] 页面直连下载失败，改用后台 Service Worker：', directError && directError.message);

        // 通道 2：后台 Service Worker（扩展上下文，靠 declarativeNetRequest 补 Referer）
        // Channel 2: the background Service Worker (extension context, Referer injected via declarativeNetRequest)
        const viaWorker = await fetchToBlobViaWorker(url, filename, onProgress);

        if (!viaWorker || viaWorker.size === 0) {
            throw new Error(
                `下载数据为空，已取消保存（多为 CDN 防盗链拦截）。\n` +
                `直连原因：${directError ? directError.message : '未知'}`
            );
        }
        console.log(`[bili-dl] 后台下载完成：${viaWorker.size} 字节`);
        return viaWorker;
    }

    // 拿到流数据并落盘
    // Fetch the stream data and write it to disk
    async function downloadFile(urlOrUrls, filename, onProgress) {
        const blob = await fetchStreamBlob(urlOrUrls, filename, onProgress);
        await saveBlob(blob, filename);
        return filename;
    }

    // 通道 1 实现：页面内流式读取
    // Channel 1 implementation: stream the response inside the page
    async function fetchToBlob(url, filename, onProgress) {
        dlControl.port = null;      // 走页面直连通道，控制靠 AbortController，不经过后台 / direct page channel; control goes through AbortController, not the background
        dlControl.native = false;

        const opts = { method: 'GET' };
        if (dlControl.signal) opts.signal = dlControl.signal;   // 让「取消」能中断这个请求 / lets "cancel" abort this very request
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error(`网络请求失败: 状态码 ${res.status}`);
        if (!res.body) throw new Error('响应无主体内容');

        const type = res.headers.get('content-type') || 'application/octet-stream';
        const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;
        let lastAt = 0;

        while (true) {
            await gateWhilePaused();   // 暂停点：暂停时卡在这里，取消时抛错 / pause point: parks here while paused, throws when cancelled
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            const now = Date.now();
            if (total && now - lastAt > 200) {
                lastAt = now;
                if (onProgress) onProgress(filename, Math.min(99, Math.round((loaded / total) * 100)));
            }
        }
        if (onProgress) onProgress(filename, 100);
        console.log(`[bili-dl] 直连响应 status=${res.status} content-type=${type} 实收=${loaded} 声明=${total}`);
        return new Blob(chunks, { type });
    }

    // 通道 2 实现：交给后台，分块回传后在页面拼 Blob
    // Channel 2 implementation: hand it to the background, reassemble the chunks into a Blob here
    function fetchToBlobViaWorker(url, filename, onProgress) {
        return new Promise((resolve, reject) => {
            if (!chrome.runtime || !chrome.runtime.id) {
                reject(new Error('扩展上下文已失效，请刷新页面后重试'));
                return;
            }

            const port = chrome.runtime.connect({ name: 'bili-dl' });
            const chunks = [];
            let settled = false;

            dlControl.port = port;      // 挂到控制层，「暂停 / 取消」会通过它下发 / registered with the control layer; pause/cancel are pushed through it
            dlControl.native = false;

            const finish = (err) => {
                if (settled) return;
                settled = true;
                try { port.disconnect(); } catch (e) { /* ignore */ }
                if (err) {
                    reject(err);
                    return;
                }
                resolve(new Blob(chunks, { type: 'application/octet-stream' }));
            };

            port.onMessage.addListener((msg) => {
                if (!msg) return;
                if (msg.type === 'progress') {
                    if (onProgress) onProgress(filename, msg.percent);
                } else if (msg.type === 'chunk') {
                    chunks.push(new Uint8Array(msg.buffer));
                } else if (msg.type === 'done') {
                    finish(null);
                } else if (msg.type === 'error') {
                    finish(msg.cancelled ? cancelledError() : new Error(msg.message || '后台下载失败'));
                }
            });

            port.onDisconnect.addListener(() => {
                const err = chrome.runtime && chrome.runtime.lastError;
                // 主动取消时断开也会触发这里，不要报成「通信中断」
                // A deliberate cancel also drops the port, so do not report it as "connection lost"
                finish(dlControl.cancelled
                    ? cancelledError()
                    : new Error(err && err.message ? err.message : '与后台通信中断'));
            });

            port.postMessage({ type: 'download', url, filename });
        });
    }

    // 保存：优先交给扩展的下载接口，页面沙箱拦不住它；扩展不可用时才退回页面内 <a download>
    // Save: prefer the extension download API, which a page sandbox cannot block; fall back to an
    // in-page <a download> only when the extension side is unavailable.
    // 为什么不能只用 <a download>：B 站有时把播放器塞进 sandbox iframe，此时浏览器会拒绝这次下载
    // （"Download is disallowed. The frame initiating ... is sandboxed, but the flag
    // 'allow-downloads' is not set"），文件根本落不了盘，但日志里却显示"已下载"。
    // Why <a download> alone is not enough: Bilibili sometimes puts the player in a sandboxed
    // iframe, and the browser then refuses the download ("Download is disallowed. The frame
    // initiating ... is sandboxed, but the flag 'allow-downloads' is not set"). The file never
    // lands on disk even though the log says it was downloaded.
    async function saveBlob(blob, filename) {
        if (!blob || blob.size === 0) throw new Error('下载数据为空，已取消保存');

        // 通道 1：扩展下载接口（data: URL 由扩展自己去取，不受页面沙箱约束）
        // Channel 1: the extension download API (the extension fetches the data: URL itself,
        // so the page sandbox does not apply)
        const viaExt = await saveViaExtension(blob, filename);
        if (viaExt) return;

        // 通道 2：页面内 <a download> 兜底（非沙箱页面走这里，行为和以前一致）
        // Channel 2: in-page <a download> as a fallback (non-sandboxed pages end up here, same as before)
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = filename;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
            try { document.body.removeChild(link); } catch (e) { /* ignore */ }
            URL.revokeObjectURL(objectUrl);
        }, 60000);
    }

    // 走扩展的 chrome.downloads 落盘。成功返回 true，扩展不可用或失败返回 false（由调用方兜底）
    // Save through the extension's chrome.downloads. Returns true on success, false when the
    // extension is unavailable or the call failed (the caller then falls back).
    function saveViaExtension(blob, filename) {
        return new Promise((resolve) => {
            if (!chrome.runtime || !chrome.runtime.id) { resolve(false); return; }

            // 用 FileReader 转成 data: URL 交给后台：blob: 地址在后台上下文里取不到内容，
            // 且 sendMessage 不能直接传 Blob，所以这里做一次 base64 编码。
            // Hand a data: URL to the background: a blob: URL is unreadable from the background
            // context and sendMessage cannot carry a Blob, so encode it as base64 once.
            const reader = new FileReader();
            const TIMEOUT_MS = 120000;   // 大文件编码 + 落盘都要时间 / big files need time to encode and save
            let settled = false;
            const done = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(ok);
            };
            const timer = setTimeout(() => {
                console.warn('[bili-dl] 扩展下载超时，改用页面内保存');
                done(false);
            }, TIMEOUT_MS);

            reader.onerror = () => done(false);
            reader.onload = () => {
                let dataUrl;
                try { dataUrl = String(reader.result || ''); } catch (e) { done(false); return; }
                if (!dataUrl) { done(false); return; }
                try {
                    chrome.runtime.sendMessage({ type: 'save-blob', dataUrl, filename }, (resp) => {
                        const err = chrome.runtime && chrome.runtime.lastError;
                        if (err) {
                            console.warn('[bili-dl] 扩展下载失败：' + err.message);
                            done(false);
                            return;
                        }
                        if (resp && resp.ok) {
                            console.log(`[bili-dl] 已通过扩展下载接口保存：${filename}`);
                            done(true);
                        } else {
                            console.warn('[bili-dl] 扩展下载失败：' + ((resp && resp.error) || '未知原因'));
                            done(false);
                        }
                    });
                } catch (e) {
                    done(false);
                }
            };
            try {
                reader.readAsDataURL(blob);
            } catch (e) {
                done(false);
            }
        });
    }

    // ===================== 清晰度 / 音质菜单 =====================
    // ===================== Quality / audio menu =====================
    // 菜单里的每个选项对应「档位 id + 编码」的组合：同一档位 B 站会同时给
    // Each menu option is a "tier id + codec" pair: Bilibili serves one tier in several codecs at once,
    // H.264 / HEVC / AV1 三种编码，码率差异很大，必须分开展示让用户自己挑。
    // H.264 / HEVC / AV1, whose bitrates differ hugely, so they are listed separately for the user to choose.
    const PREFS_KEY = 'bili-dl:quality-prefs';
    // 进页面 / 切分P 后自动拉一次可选档位；不想让它自动请求的话改成 false
    // Fetch the available tiers automatically on page load / part switch; set false to stop that request
    const AUTO_LOAD_MENU = true;
    let menuOwnerKey = '';   // 当前菜单对应的 分P，切P时才重建选项 / part this menu belongs to; options are rebuilt only when the part changes

    function loadPrefs() {
        try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
    }
    function savePrefs(vq, aq) {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify({ vq: vq, aq: aq })); } catch (e) { /* ignore */ }
    }

    function selectEl(kind) {
        return document.getElementById(kind === 'video' ? 'bili-dl-vq' : 'bili-dl-aq');
    }

    // 双保险：部分 Chrome 版本对 select 的 color-scheme 支持不完整，
    // Belt and braces: some Chrome versions handle color-scheme on <select> incompletely,
    // 再把每个 option 的前景/背景写死，避免出现白底白字
    // so every option gets hard-coded colours to avoid white-on-white text
    function styleOption(opt) {
        opt.style.backgroundColor = '#1c1c1e';
        opt.style.color = '#f0f0f0';
    }

    function fillSelect(kind, list, labelMap, fallbackKey) {
        const sel = selectEl(kind);
        if (!sel) return;
        const want = sel.value || fallbackKey || 'auto';

        sel.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = 'auto';
        auto.textContent = '最高（自动）';
        styleOption(auto);
        sel.appendChild(auto);

        sortStreams(list, kind).forEach(s => {
            const opt = document.createElement('option');
            opt.value = optionValue(s);
            opt.textContent = optionLabel(s, labelMap, kind);
            styleOption(opt);
            sel.appendChild(opt);
        });

        // 尽量沿用用户上次的选择；该选项在当前视频里不存在时退回「自动」
        // Keep the user's previous choice where possible; fall back to "auto" when this video lacks that option
        let restored = false;
        for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === want) { restored = true; break; }
        }
        sel.value = restored ? want : 'auto';
    }

    function populateStreamMenu(bvid, cid, dash) {
        const key = bvid + '/' + cid;
        if (menuOwnerKey === key) return;   // 同一个分P不重建，免得冲掉用户的选择 / same part, so keep the options and the user's choice
        menuOwnerKey = key;
        autoLoadedPage = pageKey();         // 标记该分P已读过，自动流程就不必再拉一次 / mark this part as read so auto-load need not fetch it again
        const prefs = loadPrefs();
        fillSelect('video', dash.video || [], VIDEO_QUALITY_NAMES, prefs.vq);
        fillSelect('audio', collectAudio(dash), AUDIO_QUALITY_NAMES, prefs.aq);
        console.log('[bili-dl] 清晰度菜单已更新：' +
            (selectEl('video') ? selectEl('video').value : '-') + ' / ' +
            (selectEl('audio') ? selectEl('audio').value : '-'));
    }

    function currentSelection(kind) {
        const sel = selectEl(kind);
        return sel ? sel.value : 'auto';
    }

    // 面板刚建好、下拉里还只有「最高（自动）」一项时，临时改文案提示正在读取
    // While the panel is fresh and the dropdown holds only "best (auto)", relabel it to show it is loading
    function setMenuStatus(text) {
        ['video', 'audio'].forEach(kind => {
            const sel = selectEl(kind);
            if (sel && sel.options.length === 1 && sel.options[0].value === 'auto') {
                sel.options[0].textContent = text;
            }
        });
    }

    // ---- 自动读取可选档位 ----
    // ---- Auto-load the available tiers ----
    let autoLoadedPage = '';   // 已经读过档位的分P（bvid/pN） / parts whose tiers were already fetched (bvid/pN)
    let autoLoading = false;

    function pageKey() {
        const { bvid, p } = getBvidAndPage();
        return bvid ? (bvid + '/p' + p) : '';
    }

    async function autoLoadStreamMenu(reason) {
        if (!AUTO_LOAD_MENU) return;
        if (autoLoading) return;

        const key = pageKey();
        if (!key || autoLoadedPage === key) return;   // 同一个分P只自动读一次 / auto-load once per part

        autoLoading = true;
        autoLoadedPage = key;   // 先占位，防止并发重复请求 / claim the slot first to block duplicate concurrent requests
        setMenuStatus('最高（读取中…）');
        try {
            const info = await getCurrentPageInfo();
            await getDashPlayUrl(info.bvid, info.cid);   // 内部会填充菜单 / this fills the menu internally
            console.log('[bili-dl] 已自动读取可选档位（' + (reason || '自动') + '）');
        } catch (err) {
            // 失败允许后续重试（点下载按钮时也会再拉一次）；
            // On failure allow a later retry (clicking download fetches it again anyway);
            // 但如果请求在途时用户已切到别的分P，就不能清掉新页面的标记
            // but if the user switched parts mid-flight, do not wipe the new page's marker
            if (pageKey() === key) autoLoadedPage = '';
            setMenuStatus('最高（自动）');
            console.warn('[bili-dl] 自动读取可选档位失败，可手动点「↻ 读取可选档位」重试：', err && err.message);
        } finally {
            autoLoading = false;
        }
    }

    async function refreshStreamMenu(btn) {
        if (btn) { btn.textContent = '刷新中…'; btn.disabled = true; }
        try {
            const info = await getCurrentPageInfo();
            menuOwnerKey = '';                       // 强制重建选项 / force a rebuild of the options
            const dash = await getDashPlayUrl(info.bvid, info.cid); // 内部会填充菜单 / this fills the menu internally
            console.log('[bili-dl] 清晰度列表已刷新');

            // 手动刷新时把 Hi-Res 的情况说清楚（自动读取时只在控制台留日志，不打扰）
            // On a manual refresh, spell out the Hi-Res situation (auto-load only logs quietly to the console)
            const hires = Q.describeHiRes(dash);
            const isVip = !!(navCache.account && navCache.account.vipStatus);
            if (hires.indexOf('当前账号拿不到') > 0) {
                notify(isVip
                    ? '提示：这个视频有无损（Hi-Res）音轨，但网页端拿不到。\n\n' +
                      '已实测确认：Hi-Res 属于 APP 端功能，网页接口不下发这条音轨' +
                      '（换参数、乃至照抄网页播放器自己的请求都拿不到）。\n\n' +
                      '网页端能拿到的最高音质：杜比全景声（若该视频有）或 192K AAC。'
                    : '提示：这个视频有无损（Hi-Res）音轨，但当前账号拿不到。\n' +
                      'Hi-Res 与杜比全景声都需要大会员。');
            } else if (hires.indexOf('该视频没有') === 0) {
                notify('提示：这个视频没有提供 Hi-Res 无损音轨。\n' +
                    'B 站只有部分投稿带无损音轨，标题里写「Hi-Res」多半是 UP 主的宣传词。');
            }
        } catch (err) {
            console.error('[bili-dl] 刷新清晰度列表失败：', err);
            notify('刷新清晰度列表失败: ' + err.message);
        } finally {
            if (btn) { btn.textContent = '↻ 读取可选档位'; btn.disabled = false; }
        }
    }

    // ===================== 原生 FFmpeg 合并（Native Messaging） =====================
    // ===================== Native FFmpeg merge (Native Messaging) =====================
    // 走本地宿主进程：按防盗链要求下载两条流 → ffmpeg -c copy 无损封装成单个 MP4。
    // Uses the local host process: download both streams with the right referer, then ffmpeg -c copy into one MP4.
    // 宿主没装时自动回退到「分离下载 + 提示手动合并」。
    // When the host is absent it falls back to separate downloads plus a manual merge hint.
    function nativeAvailable() {
        return new Promise((resolve) => {
            let port;
            try { port = chrome.runtime.connect({ name: 'bili-dl' }); }
            catch (e) { resolve({ ok: false, error: '扩展上下文已失效' }); return; }

            let settled = false;
            const done = (res) => {
                if (settled) return;
                settled = true;
                try { port.disconnect(); } catch (e) { /* ignore */ }
                resolve(res);
            };
            port.onMessage.addListener((msg) => {
                if (msg && msg.type === 'nativePingResult') done(msg);
            });
            port.onDisconnect.addListener(() => {
                const err = chrome.runtime && chrome.runtime.lastError;
                done({ ok: false, error: err && err.message ? err.message : '与后台通信中断' });
            });
            port.postMessage({ type: 'nativePing' });
            setTimeout(() => done({ ok: false, error: '探测超时' }), 9000);
        });
    }

    function nativeMergeFile(videoUrl, audioUrl, filename, onProgress) {
        return new Promise((resolve, reject) => {
            let port;
            try { port = chrome.runtime.connect({ name: 'bili-dl' }); }
            catch (e) { reject(new Error('扩展上下文已失效，请刷新页面')); return; }

            dlControl.port = port;      // 挂到控制层，取消时会给宿主发 cancel / registered with the control layer; cancel is forwarded to the host
            dlControl.native = true;

            let settled = false;
            const finish = (err, res) => {
                if (settled) return;
                settled = true;
                try { port.disconnect(); } catch (e) { /* ignore */ }
                if (err) reject(err); else resolve(res);
            };
            port.onMessage.addListener((msg) => {
                if (!msg) return;
                if (msg.type === 'nativeProgress') { if (onProgress) onProgress(msg); }
                else if (msg.type === 'nativeDone') {
                    if (msg.ok) finish(null, msg);
                    else {
                        const e = new Error(msg.error || 'FFmpeg 合并失败');
                        if (msg.cancelled) e.cancelled = true;
                        finish(e);
                    }
                }
            });
            port.onDisconnect.addListener(() => {
                const err = chrome.runtime && chrome.runtime.lastError;
                finish(dlControl.cancelled
                    ? cancelledError()
                    : new Error(err && err.message ? err.message : '原生宿主连接中断'));
            });
            port.postMessage({ type: 'nativeMerge', videoUrl, audioUrl, filename });
        });
    }

    // ===================== 下载控制：暂停 / 取消 =====================
    // ===================== Download control: pause / cancel =====================
    // 三条下载通道（页面直连 / 后台 Service Worker / 原生宿主）统一由这里控制：
    // One place drives all three channels (direct page / background SW / native host):
    //   · 页面直连：AbortController 直接中断 fetch
    //   . direct page: AbortController kills the fetch outright
    //   · 后台 SW  ：发控制消息，由 SW 那边 abort 并停掉读取循环
    //   . background SW: send a control message; the SW aborts and stops its read loop
    //   · 原生宿主 ：发控制消息给宿主，宿主那边中断下载 / 杀掉 ffmpeg
    //   . native host: send a control message; the host stops downloading / kills ffmpeg
    // 暂停则靠「每个数据块读取前过一道门」实现，恢复时统一放行。
    // Pausing gates every chunk read behind a check; resuming releases them all at once.
    const dlControl = {
        active: false,
        paused: false,
        cancelled: false,
        controller: null,
        signal: null,
        port: null,        // 当前通道的 port（后台 SW 或原生宿主） / port of the active channel (background SW or native host)
        native: false,     // 当前是否走原生宿主 / whether the native host is currently in use
        btn: null          // 正在跑的下载按钮，用于回显暂停状态 / the button of the running download, used to echo the paused state
    };
    let pauseWaiters = [];

    function cancelledError() {
        const e = new Error('已取消');
        e.cancelled = true;
        return e;
    }
    function isCancelled(err) {
        return !!(err && (err.cancelled || err.name === 'AbortError'));
    }

    function setDownloadButtonsDisabled(disabled) {
        ['bili-dl-audio', 'bili-dl-video', 'bili-dl-merge'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = disabled;
        });
    }

    function refreshControlButtons() {
        const pauseBtn = document.getElementById('bili-dl-pause');
        const cancelBtn = document.getElementById('bili-dl-cancel');
        if (pauseBtn) {
            pauseBtn.disabled = !dlControl.active;
            pauseBtn.textContent = dlControl.paused ? '▶ 继续' : '⏸ 暂停';
        }
        if (cancelBtn) cancelBtn.disabled = !dlControl.active;
    }

    function beginDownload(btn) {
        dlControl.active = true;
        dlControl.paused = false;
        dlControl.cancelled = false;
        dlControl.controller = new AbortController();
        dlControl.signal = dlControl.controller.signal;
        dlControl.port = null;
        dlControl.native = false;
        dlControl.btn = btn || null;
        pauseWaiters = [];
        setDownloadButtonsDisabled(true);   // 一次只跑一个，避免并发下载互相踩 / one download at a time so concurrent runs cannot stomp on each other
        refreshControlButtons();
    }

    function endDownload() {
        dlControl.active = false;
        dlControl.paused = false;
        dlControl.controller = null;
        dlControl.signal = null;
        dlControl.port = null;
        dlControl.native = false;
        dlControl.btn = null;
        pauseWaiters = [];
        setDownloadButtonsDisabled(false);
        refreshControlButtons();
    }

    // 每个数据块读取前都要过这道门；暂停时挂起，取消时直接抛错
    // Every chunk read passes this gate: it parks while paused and throws when cancelled
    async function gateWhilePaused() {
        if (dlControl.cancelled) throw cancelledError();
        if (!dlControl.paused) return;
        await new Promise((resolve, reject) => {
            pauseWaiters.push({ resolve: resolve, reject: reject });
        });
    }

    function releasePaused(asError) {
        const waiters = pauseWaiters;
        pauseWaiters = [];
        waiters.forEach(w => { asError ? w.reject(cancelledError()) : w.resolve(); });
    }

    function sendControl(type) {
        if (!dlControl.port) return;
        try { dlControl.port.postMessage({ type: type }); } catch (e) { /* 通道可能已断 */ }
    }

    function togglePause() {
        if (!dlControl.active) return;
        dlControl.paused = !dlControl.paused;

        if (dlControl.paused) {
            if (dlControl.btn && dlControl.btn.textContent.indexOf('已暂停') < 0) {
                dlControl.btn.textContent = '已暂停 · ' + dlControl.btn.textContent;
            }
            console.log('[bili-dl] 已暂停' + (dlControl.native ? '（原生宿主侧的暂停可能不即时）' : ''));
        } else {
            releasePaused(false);
            console.log('[bili-dl] 已继续');
        }
        sendControl(dlControl.paused ? 'pause' : 'resume');
        refreshControlButtons();
    }

    function cancelDownload() {
        if (!dlControl.active) return;
        dlControl.cancelled = true;
        dlControl.paused = false;
        releasePaused(true);                                        // 唤醒卡在暂停门的循环 / wake up whatever is parked at the pause gate
        if (dlControl.controller) { try { dlControl.controller.abort(); } catch (e) { } }

        const port = dlControl.port;
        if (port) {
            try { port.postMessage({ type: dlControl.native ? 'nativeCancel' : 'cancel' }); } catch (e) { }
            // 稍等一下再断开，确保控制消息已投递（断开本身也会让宿主进程被回收）
            // Disconnect a moment later so the control message lands (disconnecting also reaps the host process)
            setTimeout(() => { try { port.disconnect(); } catch (e) { } }, 150);
        }
        console.log('[bili-dl] 已取消当前下载');
        refreshControlButtons();
    }

    // ===================== 下载动作 =====================
    // 提示一律走 notify()：沙箱化的页面里 alert() 会被拦，直接报错 / all messages go through notify(); alert() throws inside a sandboxed page
    // ===================== Download actions =====================
    async function downloadAudio(btn) {
        btn.textContent = '解析中…'; btn.disabled = true;
        beginDownload(btn);
        try {
            const info = await getCurrentPageInfo();
            const dash = await getDashPlayUrl(info.bvid, info.cid);
            const audio = getBestAudioStream(dash);
            if (!audio) throw new Error('该视频没有独立的音频流');

            btn.textContent = '下载音频…';
            const filename = outputName(info, 'm4a');
            await downloadFile(audio.urls, filename, (name, pct) => { btn.textContent = `音频 ${pct}%`; });
            const aq = qualityLabel(AUDIO_QUALITY_NAMES, audio.quality);
            console.log(`✅ 已下载 P${info.p}/${info.total}: ${filename}`);
            notify(`✅ 音频下载完成！\n当前分P: P${info.p}/${info.total}\n音质: ${aq} ${codecFamily(audio.codecs)} ${kbps(audio.bandwidth)}`);
        } catch (err) {
            if (isCancelled(err)) { console.log('[bili-dl] 音频下载已取消'); return; }
            console.error(err);
            notify('音频下载失败: ' + err.message);
        } finally {
            btn.textContent = '🎵 音频'; btn.disabled = false;
            endDownload();
        }
    }

    async function downloadVideoOnly(btn) {
        btn.textContent = '解析中…'; btn.disabled = true;
        beginDownload(btn);
        try {
            const info = await getCurrentPageInfo();
            const dash = await getDashPlayUrl(info.bvid, info.cid);
            const video = getBestVideoStream(dash);
            if (!video) throw new Error('该视频没有视频流');

            btn.textContent = '下载视频…';
            const filename = outputName(info, 'mp4');
            await downloadFile(video.urls, filename, (name, pct) => { btn.textContent = `视频 ${pct}%`; });
            const vq = qualityLabel(VIDEO_QUALITY_NAMES, video.quality);
            console.log(`✅ 已下载 P${info.p}/${info.total}: ${filename}`);
            notify(`✅ 视频下载完成！\n当前分P: P${info.p}/${info.total}\n画质: ${vq} ${video.width}x${video.height} ${codecFamily(video.codecs)} ${kbps(video.bandwidth)}`);
        } catch (err) {
            if (isCancelled(err)) { console.log('[bili-dl] 视频下载已取消'); return; }
            console.error(err);
            notify('视频下载失败: ' + err.message);
        } finally {
            btn.textContent = '🎬 仅视频'; btn.disabled = false;
            endDownload();
        }
    }

    async function downloadVideoWithAudio(btn) {
        btn.textContent = '解析中…'; btn.disabled = true;
        beginDownload(btn);
        try {
            const info = await getCurrentPageInfo();
            const dash = await getDashPlayUrl(info.bvid, info.cid);
            const video = getBestVideoStream(dash);
            const audio = getBestAudioStream(dash);
            if (!video) throw new Error('该视频没有视频流');

            if (audio) {
                // ---------- 通道 A：原生宿主 + FFmpeg（装了 native-host 才有，质量最好）----------
                // ---------- Channel A: native host + FFmpeg (only with native-host installed; best quality) ----------
                const probe = await nativeAvailable();
                if (probe && probe.ok) {
                    try {
                        btn.textContent = 'FFmpeg 合并中…';
                        const mergedName = outputName(info, 'mp4');
                        const res = await nativeMergeFile(video.url, audio.url, mergedName, (m) => {
                            if (m.phase === 'merge') btn.textContent = 'FFmpeg 封装中…';
                            else btn.textContent = `${m.label || '下载'} ${m.percent}%`;
                        });
                        const mb = res.size ? (res.size / 1048576).toFixed(1) + ' MB' : '';
                        console.log(`✅ FFmpeg 已合并 P${info.p}/${info.total}: ${res.output}`);
                        notify(`✅ 已自动合并完成（原生 FFmpeg）！\n当前分P: P${info.p}/${info.total}\n大小: ${mb}\n规格: ${qualitySummary(video, audio)}\n\n文件：${res.output}`);
                        return;
                    } catch (e) {
                        if (isCancelled(e)) throw e;
                        console.warn('[bili-dl] 原生合并失败，改用浏览器内合并：', e);
                    }
                } else {
                    console.log('[bili-dl] 未检测到原生宿主，使用浏览器内重封装：' + (probe && probe.error ? probe.error : ''));
                }

                // ---------- 通道 B：浏览器内纯 JS 重封装（不装任何东西，无转码）----------
                // ---------- Channel B: pure-JS remux inside the browser (nothing to install, no re-encode) ----------
                if (window.BiliMux) {
                    try {
                        btn.textContent = '下载视频…';
                        const vBlob = await fetchStreamBlob(video.urls, outputName(info, 'mp4'), (n, pct) => {
                            btn.textContent = `视频 ${pct}%`;
                        });
                        btn.textContent = '下载音频…';
                        const aBlob = await fetchStreamBlob(audio.urls, outputName(info, 'm4a'), (n, pct) => {
                            btn.textContent = `音频 ${pct}%`;
                        });

                        btn.textContent = '合并中…';
                        const merged = await window.BiliMux.merge(vBlob, aBlob, (phase, pct) => {
                            btn.textContent = `${phase} ${pct}%`;
                        });

                        const filename = outputName(info, 'mp4');
                        await saveBlob(merged, filename);
                        console.log(`✅ 浏览器内重封装完成 P${info.p}/${info.total}: ${filename}（${merged.size} 字节）`);
                        notify(`✅ 已自动合并完成（浏览器内重封装，无转码）！\n当前分P: P${info.p}/${info.total}\n大小: ${(merged.size / 1048576).toFixed(1)} MB\n规格: ${qualitySummary(video, audio)}\n\n文件：${filename}`);
                        return;
                    } catch (e) {
                        if (isCancelled(e)) throw e;
                        console.warn('[bili-dl] 浏览器内合并失败，回退到分离下载：', e);
                    }
                }
            }

            // ---------- 通道 C：兜底 —— 分开下载，人工合并 ----------
            // ---------- Channel C: last resort -- download separately, merge by hand ----------
            btn.textContent = '下载视频…';
            const videoFile = outputName(info, 'mp4');
            await downloadFile(video.urls, videoFile, (name, pct) => { btn.textContent = `视频 ${pct}%`; });

            let audioFile = '';
            if (audio) {
                btn.textContent = '下载音频…';
                audioFile = outputName(info, 'm4a');
                await downloadFile(audio.urls, audioFile, (name, pct) => { btn.textContent = `音频 ${pct}%`; });
            }

            const outputFile = outputName(info, 'mp4', ' 完整版');
            console.log(`✅ 已下载 P${info.p}/${info.total}`);
            notify(`✅ 下载完成！\n当前分P: P${info.p}/${info.total}\n\n请用 FFmpeg 合并：\nffmpeg -i "${videoFile}" ${audio ? `-i "${audioFile}" -c:v copy -c:a copy` : '-c:v copy'} "${outputFile}"\n\n──────\n自动合并这次没成功（原因见控制台 [bili-dl] 开头的中文日志）。\n装了 native-host 的话会自动改用原生 FFmpeg 合并。`);
        } catch (err) {
            if (isCancelled(err)) { console.log('[bili-dl] 合并下载已取消'); return; }
            console.error(err);
            notify('下载失败: ' + err.message);
        } finally {
            btn.textContent = '🎬🎵 视频+音频'; btn.disabled = false;
            endDownload();
        }
    }

    // ===================== UI 按钮组 =====================
    // ===================== UI button group =====================
    let collapsed = false;
    function createButtonGroup() {
        if (document.getElementById('bili-dl-btn-group')) return;
        const container = document.createElement('div');
        container.id = 'bili-dl-btn-group';
        Object.assign(container.style, {
            position: 'fixed', bottom: '16px', right: '16px', zIndex: '99999',
            display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '4px',
            backgroundColor: 'rgba(0,0,0,0.65)', padding: '5px', borderRadius: '10px',
            backdropFilter: 'blur(10px)', boxShadow: '0 4px 20px rgba(0,0,0,0.45)'
        });

        const btnWrap = document.createElement('div');
        Object.assign(btnWrap.style, {
            display: 'flex', flexDirection: 'column', gap: '3px', overflow: 'hidden',
            transition: 'max-height .35s ease, opacity .3s ease, margin .3s ease',
            maxHeight: '340px', opacity: '1', marginBottom: '2px'
        });

        // ---- 清晰度 / 音质选择菜单 ----
        // ---- Quality / audio selectors ----
        const menu = document.createElement('div');
        Object.assign(menu.style, {
            display: 'flex', flexDirection: 'column', gap: '2px',
            marginBottom: '5px', paddingBottom: '5px',
            borderBottom: '1px solid rgba(255,255,255,.14)'
        });

        // 关键：不声明 color-scheme 的话，下拉弹层会按系统浅色渲染成白底，
        // Critical: without color-scheme the dropdown popup renders on the system's light background,
        // 而我们为了让文字在深色面板上可见设了 color:#fff → 白底白字看不见。
        // while we set color:#fff for the dark panel -> invisible white-on-white text.
        const selectStyle = {
            width: '172px', backgroundColor: 'rgba(28,28,30,.92)', color: '#f0f0f0',
            border: '1px solid rgba(255,255,255,.22)', borderRadius: '5px',
            padding: '3px 4px', fontSize: '10px', cursor: 'pointer', outline: 'none',
            colorScheme: 'dark'
        };

        [{ id: 'bili-dl-vq', kind: 'video', text: '画质' },
        { id: 'bili-dl-aq', kind: 'audio', text: '音质' }].forEach(({ id, kind, text }) => {
            const label = document.createElement('div');
            label.textContent = text;
            Object.assign(label.style, {
                fontSize: '9px', color: 'rgba(255,255,255,.6)', fontWeight: '600', letterSpacing: '.3px'
            });

            const sel = document.createElement('select');
            sel.id = id;
            Object.assign(sel.style, selectStyle);

            const auto = document.createElement('option');
            auto.value = 'auto';
            auto.textContent = '最高（自动）';
            styleOption(auto);
            sel.appendChild(auto);
            sel.value = 'auto';

            sel.onchange = () => {
                savePrefs(currentSelection('video'), currentSelection('audio'));
                const shown = sel.options[sel.selectedIndex];
                console.log(`[bili-dl] ${text}已选：` + (shown ? shown.textContent : sel.value));
            };

            menu.appendChild(label);
            menu.appendChild(sel);
        });

        const refreshBtn = document.createElement('button');
        refreshBtn.id = 'bili-dl-refresh';
        refreshBtn.textContent = '↻ 读取可选档位';
        Object.assign(refreshBtn.style, {
            backgroundColor: 'rgba(102,204,255,.20)', color: '#fff',
            border: '1px solid rgba(102,204,255,.35)', borderRadius: '5px',
            padding: '3px 8px', cursor: 'pointer', fontSize: '9.5px', fontWeight: '600',
            marginTop: '3px', width: '100%'
        });
        refreshBtn.onclick = () => refreshStreamMenu(refreshBtn);
        menu.appendChild(refreshBtn);

        btnWrap.appendChild(menu);

        const buttons = [
            { id: 'bili-dl-audio', text: '🎵 音频', color: '#66ccff', hover: '#44aadd', action: downloadAudio },
            { id: 'bili-dl-video', text: '🎬 仅视频', color: '#EE0000', hover: '#cc0000', action: downloadVideoOnly },
            { id: 'bili-dl-merge', text: '🎬🎵 视频+音频', color: '#ff6600', hover: '#dd5500', action: downloadVideoWithAudio }
        ];

        buttons.forEach(({ id, text, color, hover, action }) => {
            const btn = document.createElement('button');
            btn.id = id; btn.textContent = text;
            Object.assign(btn.style, {
                backgroundColor: color, color: '#fff', border: 'none', borderRadius: '5px',
                padding: '5px 12px', cursor: 'pointer', fontSize: '11px', fontWeight: '600',
                whiteSpace: 'nowrap', transition: 'background .2s, transform .15s',
                boxShadow: '0 2px 4px rgba(0,0,0,.3)', width: '100%', minWidth: '92px', textAlign: 'center'
            });
            btn.onmouseenter = () => { btn.style.backgroundColor = hover; btn.style.transform = 'scale(1.03)'; };
            btn.onmouseleave = () => { btn.style.backgroundColor = color; btn.style.transform = 'scale(1)'; };
            btn.onclick = () => action(btn);
            btnWrap.appendChild(btn);
        });

        // ---- 暂停 / 取消 ----
        // ---- Pause / cancel ----
        const ctrlRow = document.createElement('div');
        Object.assign(ctrlRow.style, {
            display: 'flex', gap: '3px', marginTop: '5px', paddingTop: '5px',
            borderTop: '1px solid rgba(255,255,255,.14)'
        });

        const ctrlBtnStyle = {
            flex: '1', border: 'none', borderRadius: '5px', padding: '4px 6px',
            cursor: 'pointer', fontSize: '10px', fontWeight: '600', color: '#fff',
            whiteSpace: 'nowrap', transition: 'background .2s'
        };

        const pauseBtn = document.createElement('button');
        pauseBtn.id = 'bili-dl-pause';
        pauseBtn.textContent = '⏸ 暂停';
        Object.assign(pauseBtn.style, ctrlBtnStyle);
        pauseBtn.style.backgroundColor = 'rgba(255,255,255,.18)';
        pauseBtn.onmouseenter = () => { if (!pauseBtn.disabled) pauseBtn.style.backgroundColor = 'rgba(255,255,255,.30)'; };
        pauseBtn.onmouseleave = () => { pauseBtn.style.backgroundColor = 'rgba(255,255,255,.18)'; };
        pauseBtn.onclick = () => togglePause();

        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'bili-dl-cancel';
        cancelBtn.textContent = '✕ 取消';
        Object.assign(cancelBtn.style, ctrlBtnStyle);
        cancelBtn.style.backgroundColor = 'rgba(255,80,80,.55)';
        cancelBtn.onmouseenter = () => { if (!cancelBtn.disabled) cancelBtn.style.backgroundColor = 'rgba(255,80,80,.75)'; };
        cancelBtn.onmouseleave = () => { cancelBtn.style.backgroundColor = 'rgba(255,80,80,.55)'; };
        cancelBtn.onclick = () => cancelDownload();

        ctrlRow.appendChild(pauseBtn);
        ctrlRow.appendChild(cancelBtn);
        btnWrap.appendChild(ctrlRow);

        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = '▲';
        Object.assign(toggleBtn.style, {
            backgroundColor: 'rgba(102,204,255,0.28)', color: '#fff', border: 'none', borderRadius: '5px',
            padding: '2px 10px', cursor: 'pointer', fontSize: '9px', fontWeight: '700', alignSelf: 'center'
        });
        toggleBtn.onclick = () => {
            collapsed = !collapsed;
            btnWrap.style.maxHeight = collapsed ? '0px' : '340px';
            btnWrap.style.opacity = collapsed ? '0' : '1';
            toggleBtn.style.transform = collapsed ? 'rotate(180deg)' : 'rotate(0deg)';
        };

        container.appendChild(btnWrap);
        container.appendChild(toggleBtn);
        document.body.appendChild(container);

        refreshControlButtons();   // 无下载在跑时，「暂停 / 取消」先置灰 / grey out pause/cancel while nothing is downloading

        // 面板建好后顺手把可选档位拉回来，用户不必手动点 ↻
        // Once the panel exists, pull the available tiers in so nobody has to click the refresh button
        // （延后一点，避开刚进页面时播放器自己那一波请求）
        //   (delayed slightly to dodge the burst of requests the player fires on page load)
        setTimeout(() => autoLoadStreamMenu('页面加载'), 1800);
    }

    function ensureButtonGroupExists() {
        if (!document.getElementById('bili-dl-btn-group')) createButtonGroup();
    }

    if (document.readyState === 'complete') ensureButtonGroupExists();
    else window.addEventListener('load', ensureButtonGroupExists);

    const observer = new MutationObserver(ensureButtonGroupExists);
    observer.observe(document.body, { childList: true, subtree: true });

    let lastPath = location.pathname + location.search;
    setInterval(() => {
        const current = location.pathname + location.search;
        if (current !== lastPath) {
            lastPath = current;
            setTimeout(ensureButtonGroupExists, 1500);
            // B 站是单页应用，切分P只改 URL 不刷新 → 这里补一次自动读取
            // Bilibili is a SPA: switching parts only changes the URL, so trigger another auto-load here
            setTimeout(() => autoLoadStreamMenu('切换分P'), 2600);
        }
    }, 800);
})();
