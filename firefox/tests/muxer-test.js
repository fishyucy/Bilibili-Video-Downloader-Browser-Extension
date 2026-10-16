// ===========================================================================
// muxer.js 回归测试
// muxer.js regression tests
//
//   node tests/muxer-test.js
//
// 首次运行会自动去 B 站拉一对真实的 DASH 音视频流（约 8MB）存到 tests/samples/，
// On first run it pulls a real pair of DASH streams (~8MB) from Bilibili into tests/samples/,
// 之后离线复用。样本可由 --refresh 强制重新拉取（直链约 10 分钟过期）。
// then reuses them offline. Pass --refresh to force a re-download (direct URLs expire after ~10 minutes).
//
// 覆盖两条路径：
// Covers two paths:
//   A. 真实原样（B 站实际形态：视频轨 1 / 音频轨 2，无需改编号，全零拷贝）
//   A. As-is (how Bilibili really ships it: video track 1 / audio track 2, no renumbering, all zero-copy)
//   B. 人为把音频轨编号改成 1，验证 track_ID 改写路径
//   B. Audio track forced to 1, to exercise the track_ID rewrite path
// ===========================================================================
const fs = require('fs');
const path = require('path');
const BiliMux = require(path.join(__dirname, '..', 'muxer.js'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'Referer': 'https://www.bilibili.com/', 'User-Agent': UA, 'Origin': 'https://www.bilibili.com' };
const SAMPLES = path.join(__dirname, 'samples');
const DROP = { sidx: 1, mfra: 1, free: 1, skip: 1, wide: 1 };
const checks = [];
const logLines = [];
const log = (s) => { logLines.push(s); console.log(s); };
// 同时落一份日志，方便在无法看终端输出时排查（如由脚本调用）
// Also writes a log file, handy when terminal output is unavailable (e.g. when run by a script)
function flushLog() { try { fs.writeFileSync(path.join(__dirname, 'last-run.txt'), logLines.join('\n'), 'utf8'); } catch (e) { } }
const check = (name, cond, extra) => checks.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));

// ------------------------------------------------------------------ 盒子工具
// ------------------------------------------------------------------ Box helpers
function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
function u64(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
function t(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
function readBox(buf, pos, end) {
    if (pos + 8 > end) return null;
    let size = u32(buf, pos); const type = t(buf, pos + 4); let hs = 8;
    if (size === 1) { size = u64(buf, pos + 8); hs = 16; } else if (size === 0) size = end - pos;
    if (size < hs || pos + size > end) return null;
    return { type, start: pos, size, hs, end: pos + size };
}
function topBoxes(buf) { const r = []; let p = 0; while (p < buf.length) { const h = readBox(buf, p, buf.length); if (!h) break; r.push(h); p = h.end; } return r; }
function kids(buf, box) { const r = []; let p = box.start + box.hs; while (p < box.end) { const h = readBox(buf, p, box.end); if (!h) break; r.push(h); p = h.end; } return r; }
function trakIds(buf) {
    const moov = topBoxes(buf).find(x => x.type === 'moov');
    return kids(buf, moov).filter(x => x.type === 'trak').map(tr => {
        const tkhd = kids(buf, tr).find(x => x.type === 'tkhd');
        return u32(buf, tkhd.start + 12 + (buf[tkhd.start + 8] === 1 ? 16 : 8));
    });
}
function trexIds(buf) {
    const moov = topBoxes(buf).find(x => x.type === 'moov');
    const mvex = kids(buf, moov).find(x => x.type === 'mvex');
    return kids(buf, mvex).filter(x => x.type === 'trex').map(x => u32(buf, x.start + 12));
}
function moofIds(buf) {
    const ids = [];
    for (const b of topBoxes(buf)) {
        if (b.type !== 'moof') continue;
        const tr = kids(buf, b).find(x => x.type === 'traf');
        const tf = kids(buf, tr).find(x => x.type === 'tfhd');
        ids.push(u32(buf, tf.start + 12));
    }
    return ids;
}
function keptFragmentBytes(src) {
    const moov = topBoxes(src).find(x => x.type === 'moov');
    let sum = 0;
    for (const b of topBoxes(src)) if (b.start >= moov.end && !DROP[b.type]) sum += b.size;
    return sum;
}

// ------------------------------------------------------------------ 拉样本
// ------------------------------------------------------------------ Fetch samples
async function fetchSamples(force) {
    fs.mkdirSync(SAMPLES, { recursive: true });
    const vPath = path.join(SAMPLES, 'video.m4s');
    const aPath = path.join(SAMPLES, 'audio.m4s');
    if (!force && fs.existsSync(vPath) && fs.existsSync(aPath)) return;

    log('正在从 B 站拉取测试样本…');
    const bvid = 'BV1GJ411x7h7';
    const view = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: HEADERS })).json();
    if (view.code !== 0) throw new Error('获取视频信息失败: ' + view.message);
    const pu = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${view.data.cid}&qn=64&fnval=16&fnver=0&fourk=1`, { headers: HEADERS })).json();
    if (pu.code !== 0) throw new Error('获取播放地址失败: ' + pu.message);
    const dash = pu.data.dash;
    log('  画质: video id=' + dash.video[0].id + ' ' + dash.video[0].codecs + ' / audio id=' + dash.audio[0].id + ' ' + dash.audio[0].codecs);

    // CDN 偶发中断（本仓库真实遇到过 terminated），所以主地址失败就换备用地址、再重试
    // CDNs drop connections occasionally (this repo really hit "terminated"), so fall back to the backup URL and retry
    // dash 流本身自带 baseUrl + backupUrl，扩展端也是同一套兜底逻辑
    // Every dash stream ships baseUrl + backupUrl; the extension uses the same fallback logic
    async function download(urls, file) {
        let lastErr = null;
        for (let round = 0; round < 2; round++) {
            for (const url of urls.filter(Boolean)) {
                try {
                    const r = await fetch(url, { headers: HEADERS });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    const buf = Buffer.from(await r.arrayBuffer());
                    fs.writeFileSync(file, buf);
                    log('  ' + path.basename(file) + ' -> ' + buf.length + ' 字节');
                    return;
                } catch (e) {
                    lastErr = e;
                    log('  下载 ' + path.basename(file) + ' 失败（第 ' + (round + 1) + ' 轮）：' + e.message);
                }
            }
        }
        throw new Error('样本下载失败: ' + (lastErr && lastErr.message));
    }
    await download([dash.video[0].baseUrl].concat(dash.video[0].backupUrl || []), vPath);
    await download([dash.audio[0].baseUrl].concat(dash.audio[0].backupUrl || []), aPath);
}

function patchAudioIdsTo1(buf) {
    const moov = topBoxes(buf).find(x => x.type === 'moov');
    const trak = kids(buf, moov).find(x => x.type === 'trak');
    const tkhd = kids(buf, trak).find(x => x.type === 'tkhd');
    buf.writeUInt32BE(1, tkhd.start + 12 + (buf[tkhd.start + 8] === 1 ? 16 : 8));
    const mvex = kids(buf, moov).find(x => x.type === 'mvex');
    kids(buf, mvex).filter(x => x.type === 'trex').forEach(x => buf.writeUInt32BE(1, x.start + 12));
    for (const b of topBoxes(buf)) {
        if (b.type !== 'moof') continue;
        const tr = kids(buf, b).find(x => x.type === 'traf');
        const tf = kids(buf, tr).find(x => x.type === 'tfhd');
        buf.writeUInt32BE(1, tf.start + 12);
    }
    return buf;
}

function validate(buf, tag, srcV, srcA) {
    const top = topBoxes(buf);
    const seq = top.map(x => x.type);
    const moov = top.find(x => x.type === 'moov');

    check(tag + ' | 无 sidx 残留', seq.indexOf('sidx') < 0);
    check(tag + ' | 无 mfra 残留', seq.indexOf('mfra') < 0);
    check(tag + ' | 首个盒子 ftyp', seq[0] === 'ftyp');
    check(tag + ' | moov 在第二位', seq[1] === 'moov');
    check(tag + ' | trak_ID = 1,2', trakIds(buf).slice().sort().join(',') === '1,2', trakIds(buf).join(','));
    check(tag + ' | trex_ID = 1,2', trexIds(buf).slice().sort().join(',') === '1,2', trexIds(buf).join(','));
    const mvhd = kids(buf, moov).find(x => x.type === 'mvhd');
    check(tag + ' | mvhd.next_track_ID = 3', u32(buf, mvhd.start + mvhd.size - 4) === 3);

    const mids = moofIds(buf);
    check(tag + ' | moof 的 track_ID ⊂ {1,2}', mids.every(x => x === 1 || x === 2), Array.from(new Set(mids)).join(','));
    check(tag + ' | 视频 moof 数一致', mids.filter(x => x === 1).length === srcV.moofCount, mids.filter(x => x === 1).length);
    check(tag + ' | 音频 moof 数一致', mids.filter(x => x === 2).length === srcA.moofCount, mids.filter(x => x === 2).length);
    check(tag + ' | moof 交错排列', mids.slice(0, 8).join(',') === '1,2,1,2,1,2,1,2', mids.slice(0, 8).join(','));

    let bad = 0;
    for (let i = 0; i < top.length - 1; i++) if (top[i].type === 'moof' && top[i + 1].type !== 'mdat') bad++;
    check(tag + ' | 每个 moof 紧跟 mdat', bad === 0);

    const expect = keptFragmentBytes(srcV.buf) + keptFragmentBytes(srcA.buf);
    const got = buf.length - moov.end;
    check(tag + ' | 保留盒子字节守恒', got === expect, got + ' vs ' + expect);

    const sm = kids(srcV.buf, topBoxes(srcV.buf).find(x => x.type === 'moov')).find(x => x.type === 'mvhd');
    const sOff = sm.start + 12 + (srcV.buf[sm.start + 8] === 1 ? 16 : 8);
    const mOff = mvhd.start + 12 + (buf[mvhd.start + 8] === 1 ? 16 : 8);
    check(tag + ' | mvhd 时长保留', u32(buf, mOff) === u32(srcV.buf, sOff) && u32(buf, mOff + 4) === u32(srcV.buf, sOff + 4));
    return mids;
}

(async () => {
    await fetchSamples(process.argv.indexOf('--refresh') > 0);

    const vBuf = fs.readFileSync(path.join(SAMPLES, 'video.m4s'));
    const aBuf = fs.readFileSync(path.join(SAMPLES, 'audio.m4s'));
    const srcV = { buf: vBuf, moofCount: moofIds(vBuf).length };
    const srcA = { buf: aBuf, moofCount: moofIds(aBuf).length };
    log('视频 ' + vBuf.length + 'B / ' + srcV.moofCount + ' 段；音频 ' + aBuf.length + 'B / ' + srcA.moofCount + ' 段');

    log('\n--- 用例 A：真实原样 ---');
    const t0 = Date.now();
    const bA = Buffer.from(await (await BiliMux.merge(new Blob([vBuf]), new Blob([aBuf]))).arrayBuffer());
    log('输出 ' + bA.length + 'B，耗时 ' + (Date.now() - t0) + 'ms');
    validate(bA, 'A', srcV, srcA);

    const vMoof0 = topBoxes(vBuf).filter(x => x.type === 'moof')[0];
    const outMoof0 = topBoxes(bA).filter(x => x.type === 'moof')[0];
    check('A | 首个视频 moof 逐字节一致',
        Buffer.compare(bA.slice(outMoof0.start, outMoof0.end), vBuf.slice(vMoof0.start, vMoof0.end)) === 0);

    log('\n--- 用例 B：音频轨编号改成 1（走改写路径）---');
    const aPatched = patchAudioIdsTo1(Buffer.from(aBuf));
    const bB = Buffer.from(await (await BiliMux.merge(new Blob([vBuf]), new Blob([aPatched]))).arrayBuffer());
    log('输出 ' + bB.length + 'B');
    const idsB = validate(bB, 'B', srcV, srcA);
    check('B | 改写后与 A 等长', bB.length === bA.length);
    check('B | 音频分片全部为 2', idsB.filter((_, i) => i % 2 === 1).every(x => x === 2));
    check('B | 视频分片仍为 1', idsB.filter((_, i) => i % 2 === 0).every(x => x === 1));

    log('\n===== 结果 =====');
    checks.forEach(c => log(c));
    const fails = checks.filter(c => c.indexOf('FAIL') === 0).length;
    log('\n共 ' + checks.length + ' 项，FAIL ' + fails + ' 项');
    flushLog();
    process.exit(fails ? 1 : 0);
})().catch(e => {
    log('测试异常: ' + (e && e.stack ? e.stack : e));
    flushLog();
    process.exit(1);
});
