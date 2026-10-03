// ===========================================================================
// muxer.js —— 纯 JS 的分片 MP4（fMP4）双轨重封装
// muxer.js -- pure-JS remux of two-track fragmented MP4 (fMP4)
//
// B 站的 DASH 音视频是两条独立的 fMP4 流（.m4s），各自结构为：
// Bilibili DASH serves video and audio as two independent fMP4 streams (.m4s), each shaped like:
//     ftyp + moov(含 1 个 trak + mvex/trex) + [sidx] + moof + mdat + moof + mdat ...
//     ftyp + moov(1 trak + mvex/trex) + [sidx] + moof + mdat + moof + mdat ...
// 因为每个 moof 自描述且自带解码时间（tfdt），所以把两条流合成一个合法 MP4 只需要：
// Every moof is self-describing and carries its own decode time (tfdt), so merging the two into one legal MP4 needs only:
//     1. 把两个 moov 的 trak 合进一个 moov（音频轨 track_ID 改成 2，补上对应的 trex）
//     1. fold both moov traks into a single moov (audio track_ID becomes 2, with its matching trex)
//     2. 音频分片里 tfhd.track_ID 从 1 改成 2
//     2. rewrite tfhd.track_ID from 1 to 2 inside the audio fragments
//     3. 丢掉 sidx / mfra（它们记的是绝对字节偏移，重排后必然失效）
//     3. drop sidx / mfra (they store absolute byte offsets, which break the moment we reorder)
//     4. 按分片顺序交错排列，得到常规的 interleaved 布局
//     4. interleave the fragments in order to get a conventional interleaved layout
//
// 全程只搬运盒子和改写 4 字节字段，不解码、不重新编码 → 与编码格式无关
// Nothing but boxes are moved and 4-byte fields rewritten -- no decode, no re-encode, so the codec is irrelevant
// （H.264 / HEVC / AV1 + AAC 都适用），速度是毫秒级，画质无损。
// (H.264 / HEVC / AV1 + AAC all work), it takes milliseconds and loses nothing.
// ===========================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.BiliMux = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ------------------------------------------------------------ 字节小工具
    // ------------------------------------------------------------ Byte helpers
    function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
    function u64at(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
    function typeAt(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
    function writeU32(b, o, v) {
        b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255;
        b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
    }

    // 头部区域到哪里结束（这些盒子标志分片区开始）
    // Where the header region ends (these boxes mark the start of the fragment region)
    var HEADER_STOP = { moof: 1, mdat: 1, mfra: 1, emsg: 1, prft: 1 };
    // 重排后必须丢弃的盒子：sidx/mfra 记录绝对偏移；mehd 会给出错误的整体时长
    // Boxes that must go once reordered: sidx/mfra store absolute offsets; mehd would report a bogus total duration
    var DROP = { sidx: 1, mfra: 1, mehd: 1, free: 1, skip: 1, wide: 1 };
    // moov 内已单独处理，不再重复搬的盒子
    // Boxes already handled individually inside moov, so they must not be copied twice
    var MOOV_HANDLED = { mvhd: 1, trak: 1, mvex: 1, mehd: 1 };

    // ------------------------------------------------------------ 盒子解析
    // ------------------------------------------------------------ Box parsing
    function readBoxAt(bytes, pos, end) {
        if (pos + 8 > end) return null;
        var size = u32(bytes, pos);
        var type = typeAt(bytes, pos + 4);
        var headerSize = 8;
        if (size === 1) {
            if (pos + 16 > end) return null;
            size = u64at(bytes, pos + 8);
            headerSize = 16;
        } else if (size === 0) {
            size = end - pos;
        }
        if (size < headerSize || pos + size > end) return null;
        return { type: type, start: pos, size: size, headerSize: headerSize, end: pos + size };
    }

    function parseBoxes(bytes, from, end) {
        var out = [];
        var pos = from;
        while (pos < end) {
            var h = readBoxAt(bytes, pos, end);
            if (!h) break;
            out.push(h);
            pos = h.end;
        }
        return out;
    }

    function bytesOf(buf, box) { return buf.slice(box.start, box.end); }

    function makeBox(type, payloadParts) {
        var total = 8;
        for (var i = 0; i < payloadParts.length; i++) total += payloadParts[i].length;
        var out = new Uint8Array(total);
        writeU32(out, 0, total);
        out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
        out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
        var off = 8;
        for (var j = 0; j < payloadParts.length; j++) { out.set(payloadParts[j], off); off += payloadParts[j].length; }
        return out;
    }

    function fallbackFtyp() {
        // 最小可用的 ftyp：iso5 + 常见兼容品牌
        // Smallest usable ftyp: iso5 plus the usual compatible brands
        var brands = ['iso5', 'iso6', 'mp41', 'mp42', 'dash', 'avc1', 'hev1'];
        var out = new Uint8Array(8 + 8 + brands.length * 4);
        writeU32(out, 0, out.length);
        out[4] = 0x66; out[5] = 0x74; out[6] = 0x79; out[7] = 0x70; // 'ftyp'
        out[8] = 0x69; out[9] = 0x73; out[10] = 0x6f; out[11] = 0x35; // 'iso5'
        writeU32(out, 12, 0x200); // minor version
        for (var i = 0; i < brands.length; i++) {
            for (var k = 0; k < 4; k++) out[16 + i * 4 + k] = brands[i].charCodeAt(k);
        }
        return out;
    }

    // ------------------------------------------------------------ 头部区域
    // ------------------------------------------------------------ Header region
    async function readHeaderRegion(blob) {
        var window = 1 << 20;
        var cap = 64 << 20;
        for (;;) {
            var end = Math.min(window, blob.size);
            var bytes = new Uint8Array(await blob.slice(0, end).arrayBuffer());
            var boxes = [];
            var pos = 0;
            var headerEnd = -1;
            var needMore = false;

            while (pos + 8 <= bytes.length) {
                var h = readBoxAt(bytes, pos, bytes.length);
                if (!h) { needMore = true; break; }
                if (HEADER_STOP[h.type]) { headerEnd = h.start; break; }
                boxes.push(h);
                pos = h.end;
            }
            if (headerEnd < 0) headerEnd = pos;

            if (!needMore || end >= blob.size || window >= cap) {
                return { boxes: boxes, headerEnd: headerEnd, bytes: bytes };
            }
            window = Math.min(window * 4, cap);
        }
    }

    function findBox(boxes, type) {
        for (var i = 0; i < boxes.length; i++) if (boxes[i].type === type) return boxes[i];
        return null;
    }

    // ------------------------------------------------------- track_ID 读写
    // ------------------------------------------------------- track_ID read/write
    // tkhd 是 full box：8 字节头 + 4 字节 version/flags，之后
    // tkhd is a full box: 8-byte header + 4-byte version/flags, after which
    //   version 0: creation(4) modification(4) → track_ID 在 +20
    //   version 0: creation(4) modification(4) -> track_ID at +20
    //   version 1: creation(8) modification(8) → track_ID 在 +28
    //   version 1: creation(8) modification(8) -> track_ID at +28
    function tkhdIdOffset(buf, tkhd) {
        var version = buf[tkhd.start + 8];
        return tkhd.start + 12 + (version === 1 ? 16 : 8);
    }

    function readTrakId(buf, trak) {
        var children = parseBoxes(buf, trak.start + trak.headerSize, trak.end);
        var tkhd = findBox(children, 'tkhd');
        if (!tkhd) return 0;
        return u32(buf, tkhdIdOffset(buf, tkhd));
    }

    function patchTrakId(buf, trak, newId) {
        var children = parseBoxes(buf, trak.start + trak.headerSize, trak.end);
        var tkhd = findBox(children, 'tkhd');
        if (!tkhd) throw new Error('trak 里没有 tkhd');
        writeU32(buf, tkhdIdOffset(buf, tkhd), newId);
    }

    // trex 是 full box：8 字节头 + 4 字节 version/flags → track_ID 在 +12
    // trex is a full box: 8-byte header + 4-byte version/flags -> track_ID at +12
    function patchTrexId(buf, newId) { writeU32(buf, 12, newId); }

    // mvhd 的 next_track_ID 是最后一个字段（v0/v1 都在末尾）
    // mvhd.next_track_ID is the last field (true for both v0 and v1)
    function patchMvhdNextTrackId(buf, nextId) { writeU32(buf, buf.length - 4, nextId); }

    function patchMoofTrackId(buf, oldId, newId) {
        var children = parseBoxes(buf, 8, buf.length);
        for (var i = 0; i < children.length; i++) {
            if (children[i].type !== 'traf') continue;
            var trafKids = parseBoxes(buf, children[i].start + children[i].headerSize, children[i].end);
            for (var j = 0; j < trafKids.length; j++) {
                if (trafKids[j].type !== 'tfhd') continue;
                var off = trafKids[j].start + 12; // 8 头 + 4 version/flags → track_ID / 8-byte header + 4-byte version/flags -> track_ID
                if (off + 4 <= buf.length && u32(buf, off) === oldId) writeU32(buf, off, newId);
            }
        }
    }

    // ------------------------------------------------------- 分片区扫描
    // ------------------------------------------------------- Fragment region scan
    // 只读盒子头（不能复用 readBoxAt：那里要求整个盒子都在缓冲区里，
    // Read box headers only (readBoxAt cannot be reused: it expects the whole box to be buffered,
    // 而这里只取了 16 字节，mdat 这类大盒子必然判为越界）
    //   while here we hold just 16 bytes, so a big box like mdat would always look out of range)
    async function readBoxHeaderAt(blob, offset) {
        var end = Math.min(offset + 16, blob.size);
        var buf = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
        if (buf.length < 8) return null;

        var size = u32(buf, 0);
        var type = typeAt(buf, 4);
        var headerSize = 8;
        if (size === 1) {
            if (buf.length < 16) return null;
            size = u64at(buf, 8);
            headerSize = 16;
        } else if (size === 0) {
            size = blob.size - offset;
        }
        if (size < headerSize || offset + size > blob.size) return null;
        return { type: type, start: offset, size: size, headerSize: headerSize, end: offset + size };
    }

    // 把分片区切成「一个 moof + 随后的 mdat」为一组，便于两轨交错
    // Cut the fragment region into groups of "one moof + the mdat right after it" so the tracks can interleave
    async function buildGroups(blob, from, onStatus, phaseStart, phaseSpan, totalBoxesHint) {
        var groups = [];
        var current = null;
        var pending = [];
        var offset = from;
        var scanned = 0;

        while (offset + 8 <= blob.size) {
            var h = await readBoxHeaderAt(blob, offset);
            if (!h) break;
            var item = { type: h.type, start: offset, end: offset + h.size };

            if (!DROP[h.type]) {
                if (h.type === 'moof') {
                    current = pending.concat([item]);
                    pending = [];
                    groups.push(current);
                } else if (h.type === 'mdat') {
                    if (current) current.push(item);
                    else { current = [item]; groups.push(current); }
                } else {
                    pending.push(item);
                }
            }
            offset += h.size;
            scanned++;

            if (scanned % 200 === 0 && onStatus) {
                var ratio = blob.size ? Math.min(1, offset / blob.size) : 0;
                onStatus('合并', Math.round(phaseStart + ratio * phaseSpan));
            }
        }
        if (pending.length) groups.push(pending);
        return groups;
    }

    async function pushGroup(parts, blob, group, needPatch, oldId, newId) {
        for (var i = 0; i < group.length; i++) {
            var item = group[i];
            if (item.type === 'moof' && needPatch) {
                var buf = new Uint8Array(await blob.slice(item.start, item.end).arrayBuffer());
                patchMoofTrackId(buf, oldId, newId);
                parts.push(buf);
            } else {
                parts.push(blob.slice(item.start, item.end));
            }
        }
    }

    // ------------------------------------------------------------ 主流程
    // ------------------------------------------------------------ Main flow
    async function merge(videoBlob, audioBlob, onStatus) {
        function report(phase, pct) { if (onStatus) { try { onStatus(phase, pct); } catch (e) { } } }

        if (!videoBlob || !audioBlob) throw new Error('缺少音视频流');
        if (!videoBlob.size || !audioBlob.size) throw new Error('音视频流为空');

        report('解析', 2);
        var vHead = await readHeaderRegion(videoBlob);
        var aHead = await readHeaderRegion(audioBlob);
        var vMoov = findBox(vHead.boxes, 'moov');
        var aMoov = findBox(aHead.boxes, 'moov');
        if (!vMoov || !aMoov) throw new Error('输入不是分片 MP4（缺少 moov），无法重封装');

        var vMoovBytes = new Uint8Array(await videoBlob.slice(vMoov.start, vMoov.end).arrayBuffer());
        var aMoovBytes = new Uint8Array(await audioBlob.slice(aMoov.start, aMoov.end).arrayBuffer());

        var vChildren = parseBoxes(vMoovBytes, vMoov.headerSize, vMoovBytes.length);
        var aChildren = parseBoxes(aMoovBytes, aMoov.headerSize, aMoovBytes.length);

        var vTrak = findBox(vChildren, 'trak');
        var aTrak = findBox(aChildren, 'trak');
        var vMvex = findBox(vChildren, 'mvex');
        var aMvex = findBox(aChildren, 'mvex');
        if (!vTrak || !aTrak) throw new Error('moov 中缺少 trak');
        if (!vMvex || !aMvex) throw new Error('缺少 mvex/trex，输入不是分片 MP4');

        var vTrex = findBox(parseBoxes(vMoovBytes, vMvex.start + vMvex.headerSize, vMvex.end), 'trex');
        var aTrex = findBox(parseBoxes(aMoovBytes, aMvex.start + aMvex.headerSize, aMvex.end), 'trex');
        if (!vTrex || !aTrex) throw new Error('缺少 trex');

        var vId = readTrakId(vMoovBytes, vTrak);
        var aId = readTrakId(aMoovBytes, aTrak);
        if (!vId || !aId) throw new Error('读取 track_ID 失败');
        // 两条流编号相同也没关系：各自独立重编号（视频→1、音频→2）即可，
        // Identical track ids on both streams are fine: renumber each independently (video -> 1, audio -> 2),
        // 因为哪条是视频、哪条是音频是由调用方区分好的。
        //   because the caller has already told us which stream is which.

        var NEW_V = 1;
        var NEW_A = 2;

        report('合并', 12);

        // 视频轨：编号归一到 1
        // Video track: normalise its id to 1
        var vTrakBytes = bytesOf(vMoovBytes, vTrak);
        if (vId !== NEW_V) {
            patchTrakId(vTrakBytes, { start: 0, headerSize: vTrak.headerSize, end: vTrakBytes.length }, NEW_V);
        }
        var vTrexBytes = bytesOf(vMoovBytes, vTrex);
        patchTrexId(vTrexBytes, NEW_V);

        // 音频轨：编号改成 2
        // Audio track: renumber to 2
        var aTrakBytes = bytesOf(aMoovBytes, aTrak);
        if (aId !== NEW_A) {
            patchTrakId(aTrakBytes, { start: 0, headerSize: aTrak.headerSize, end: aTrakBytes.length }, NEW_A);
        }
        var aTrexBytes = bytesOf(aMoovBytes, aTrex);
        patchTrexId(aTrexBytes, NEW_A);

        // mvhd：next_track_ID 指向 3
        // mvhd: point next_track_ID at 3
        var vMvhd = findBox(vChildren, 'mvhd');
        if (!vMvhd) throw new Error('moov 中缺少 mvhd');
        var mvhdBytes = bytesOf(vMoovBytes, vMvhd);
        patchMvhdNextTrackId(mvhdBytes, 3);

        // 组装新 moov
        // Assemble the new moov
        var moovPayload = [mvhdBytes, vTrakBytes, aTrakBytes, makeBox('mvex', [vTrexBytes, aTrexBytes])];
        for (var i = 0; i < vChildren.length; i++) {
            if (!MOOV_HANDLED[vChildren[i].type]) moovPayload.push(bytesOf(vMoovBytes, vChildren[i]));
        }
        var newMoov = makeBox('moov', moovPayload);

        // 分片区：逐盒扫描 → 分组 → 交错
        // Fragment region: scan box by box -> group -> interleave
        var vGroups = await buildGroups(videoBlob, vHead.headerEnd, onStatus, 15, 30);
        var aGroups = await buildGroups(audioBlob, aHead.headerEnd, onStatus, 45, 25);
        if (!vGroups.length || !aGroups.length) throw new Error('分片区为空，无法合并');

        var parts = [];
        var vFtyp = findBox(vHead.boxes, 'ftyp');
        parts.push(vFtyp ? videoBlob.slice(vFtyp.start, vFtyp.end) : new Blob([fallbackFtyp()]));
        parts.push(new Blob([newMoov]));

        var needVPatch = vId !== NEW_V;
        var needAPatch = aId !== NEW_A;
        var max = Math.max(vGroups.length, aGroups.length);

        for (var g = 0; g < max; g++) {
            if (g < vGroups.length) await pushGroup(parts, videoBlob, vGroups[g], needVPatch, vId, NEW_V);
            if (g < aGroups.length) await pushGroup(parts, audioBlob, aGroups[g], needAPatch, aId, NEW_A);
            if (g % 20 === 0) report('合并', Math.round(72 + (g / max) * 25));
        }

        report('合并', 98);
        var out = new Blob(parts, { type: 'video/mp4' });
        if (!out.size) throw new Error('合并结果为空');
        return out;
    }

    return {
        merge: merge,
        // 暴露给测试用
        // Exposed for tests
        _internal: {
            readBoxAt: readBoxAt, parseBoxes: parseBoxes, readHeaderRegion: readHeaderRegion,
            readTrakId: readTrakId, patchMoofTrackId: patchMoofTrackId, findBox: findBox,
            u32: u32, typeAt: typeAt
        }
    };
});
