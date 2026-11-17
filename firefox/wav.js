// ===========================================================================
// wav.js —— PCM WAV 编码（纯逻辑，可在 Node 里直接单测）
// wav.js -- PCM WAV encoder (pure logic, unit-testable straight from Node)
//
// 输入是 Web Audio 解码后的 AudioBuffer（Float32 PCM），输出 16-bit PCM 的
// .wav Blob。不依赖第三方库，也不联网。
// Input is the Float32 PCM AudioBuffer produced by Web Audio decode; output is a
// 16-bit PCM .wav Blob. No third-party library, no network.
//
// 注意：这里只做「解码后的 PCM 直存」，不会再压缩；WAV 文件因此比 m4a 大很多。
// Note: this stores decoded PCM as-is and does not compress again, so the WAV file
// is much larger than the m4a source.
// ===========================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.BiliWav = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var HEADER_SIZE = 44;
    var BYTES_PER_SAMPLE = 2;
    // 每块约 1M 帧（立体声约 4MB），避免一次分配整段输出
    // ~1M frames per chunk (~4MB stereo) so the whole output is never allocated at once
    var CHUNK_FRAMES = 1 << 20;

    function writeString(view, offset, text) {
        for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }

    // 44 字节 RIFF/WAVE 头：PCM，16-bit
    // 44-byte RIFF/WAVE header: PCM, 16-bit
    function header(dataSize, channels, sampleRate) {
        var blockAlign = channels * BYTES_PER_SAMPLE;
        var buf = new ArrayBuffer(HEADER_SIZE);
        var v = new DataView(buf);
        writeString(v, 0, 'RIFF');
        v.setUint32(4, 36 + dataSize, true);
        writeString(v, 8, 'WAVE');
        writeString(v, 12, 'fmt ');
        v.setUint32(16, 16, true);                 // fmt 块大小 / fmt chunk size
        v.setUint16(20, 1, true);                  // PCM / linear PCM
        v.setUint16(22, channels, true);
        v.setUint32(24, sampleRate, true);
        v.setUint32(28, sampleRate * blockAlign, true); // byte rate
        v.setUint16(32, blockAlign, true);
        v.setUint16(34, 16, true);                 // bits per sample
        writeString(v, 36, 'data');
        v.setUint32(40, dataSize, true);
        return buf;
    }

    // -1..1 的浮点样本转 16-bit 整数，越界削顶
    // Float sample in -1..1 to 16-bit integer, clipped
    function floatToPcm16(value) {
        var s = Math.max(-1, Math.min(1, value));
        return s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // audioBuffer 只需具备 numberOfChannels / sampleRate / length / getChannelData()
    // audioBuffer only needs numberOfChannels / sampleRate / length / getChannelData()
    async function encode(audioBuffer, onProgress, isCancelled) {
        if (!audioBuffer || !audioBuffer.length) throw new Error('没有可编码的音频数据');

        var channels = Math.min(audioBuffer.numberOfChannels || 1, 2);
        var sampleRate = audioBuffer.sampleRate;
        var frames = audioBuffer.length;
        var blockAlign = channels * BYTES_PER_SAMPLE;
        var dataSize = frames * blockAlign;

        // RIFF 的块长度是 32 位；超过 4GB 的 WAV 本身也无法被常规播放器接受
        // RIFF chunk sizes are 32-bit; a >4GB WAV is not accepted by normal players either
        if (dataSize > 0xFFFFFFFF - 36) {
            throw new Error('音频太长，超出 WAV 4GB 上限；请改用 m4a 或 mp3');
        }

        var left = audioBuffer.getChannelData(0);
        var right = channels > 1 ? audioBuffer.getChannelData(1) : null;
        var parts = [new Uint8Array(header(dataSize, channels, sampleRate))];

        for (var offset = 0; offset < frames; offset += CHUNK_FRAMES) {
            if (isCancelled && isCancelled()) {
                var err = new Error('已取消');
                err.cancelled = true;
                throw err;
            }

            var len = Math.min(CHUNK_FRAMES, frames - offset);
            var out = new Uint8Array(len * blockAlign);
            var p = 0;
            for (var i = 0; i < len; i++) {
                var l = floatToPcm16(left[offset + i]) | 0;
                out[p++] = l & 255;
                out[p++] = (l >> 8) & 255;
                if (right) {
                    var r = floatToPcm16(right[offset + i]) | 0;
                    out[p++] = r & 255;
                    out[p++] = (r >> 8) & 255;
                }
            }
            parts.push(out);

            if (onProgress) onProgress(Math.min(99, Math.round((offset + len) / frames * 100)));
            // 让出主线程，长音频转码时页面不卡死 / yield so the page stays responsive on long tracks
            await new Promise(function (resolve) { setTimeout(resolve, 0); });
        }

        if (onProgress) onProgress(100);
        return new Blob(parts, { type: 'audio/wav' });
    }

    return {
        encode: encode,
        header: header,
        _internal: {
            floatToPcm16: floatToPcm16,
            CHUNK_FRAMES: CHUNK_FRAMES
        }
    };
});
