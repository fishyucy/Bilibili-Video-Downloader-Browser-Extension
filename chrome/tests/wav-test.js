// ===========================================================================
// wav.js 测试（纯逻辑，不需要联网）
// wav.js tests (pure logic, no network needed)
//   node tests/wav-test.js
// ===========================================================================
const fs = require('fs');
const path = require('path');
const Wav = require(path.join(__dirname, '..', 'wav.js'));

const lines = [];
const checks = [];
const log = (s) => lines.push(s);
const check = (name, cond, extra) => checks.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));

function fakeBuffer(channels, sampleRate, data) {
    return {
        numberOfChannels: channels,
        sampleRate: sampleRate,
        length: data[0].length,
        getChannelData: (i) => data[i]
    };
}

(async () => {
    // ------------------------------------------------------------ 头部
    // ------------------------------------------------------------ Header
    log('===== 1. WAV 头 =====');
    const h = Buffer.from(Wav.header(8, 1, 8000));
    check('RIFF/WAVE 标识', h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WAVE');
    check('fmt 块为 PCM 16-bit 单声道 8kHz',
        h.readUInt32LE(16) === 16 && h.readUInt16LE(20) === 1 && h.readUInt16LE(22) === 1 &&
        h.readUInt32LE(24) === 8000 && h.readUInt16LE(34) === 16);
    check('字节率 / 块对齐', h.readUInt32LE(28) === 16000 && h.readUInt16LE(32) === 2);
    check('RIFF 长度 = 36 + data', h.readUInt32LE(4) === 44 && h.readUInt32LE(40) === 8);

    // ------------------------------------------------------------ 单声道
    // ------------------------------------------------------------ Mono
    log('\n===== 2. 单声道 PCM =====');
    const mono = fakeBuffer(1, 8000, [Float32Array.from([0, 1, -1, 0.5])]);
    const monoBlob = await Wav.encode(mono);
    const mb = Buffer.from(await monoBlob.arrayBuffer());
    check('Blob 类型为 audio/wav', monoBlob.type === 'audio/wav', monoBlob.type);
    check('总长度 = 44 + 8', mb.length === 52, mb.length);
    check('PCM 样本（0 / 1 / -1 / 0.5）',
        mb.readInt16LE(44) === 0 && mb.readInt16LE(46) === 32767 &&
        mb.readInt16LE(48) === -32768 && mb.readInt16LE(50) === 16383,
        [mb.readInt16LE(44), mb.readInt16LE(46), mb.readInt16LE(48), mb.readInt16LE(50)].join(','));

    // ------------------------------------------------------------ 立体声
    // ------------------------------------------------------------ Stereo
    log('\n===== 3. 立体声交错 =====');
    const stereo = fakeBuffer(2, 44100, [
        Float32Array.from([0.25, -0.25]),
        Float32Array.from([1, -1])
    ]);
    const st = Buffer.from(await (await Wav.encode(stereo)).arrayBuffer());
    check('立体声块对齐 4 / 字节率 176400', st.readUInt16LE(32) === 4 && st.readUInt32LE(28) === 176400);
    check('左右声道交错写入',
        st.readInt16LE(44) === 8191 && st.readInt16LE(46) === 32767 &&
        st.readInt16LE(48) === -8192 && st.readInt16LE(50) === -32768,
        [st.readInt16LE(44), st.readInt16LE(46), st.readInt16LE(48), st.readInt16LE(50)].join(','));

    // ------------------------------------------------------------ 越界与取消
    // ------------------------------------------------------------ Clipping and cancel
    log('\n===== 4. 边界 =====');
    const clip = Buffer.from(await (await Wav.encode(fakeBuffer(1, 8000, [Float32Array.from([2, -2])]))).arrayBuffer());
    check('超过 ±1 的样本被削顶', clip.readInt16LE(44) === 32767 && clip.readInt16LE(46) === -32768);

    let cancelled = false;
    try {
        await Wav.encode(mono, null, () => true);
    } catch (e) {
        cancelled = !!(e && e.cancelled);
    }
    check('取消时抛出 cancelled 错误', cancelled);

    let lastProgress = 0;
    await Wav.encode(mono, (p) => { lastProgress = p; });
    check('进度最终到 100', lastProgress === 100, lastProgress);

    let emptyError = '';
    try { await Wav.encode(fakeBuffer(1, 8000, [new Float32Array(0)])); }
    catch (e) { emptyError = e.message; }
    check('空音频给出明确错误', emptyError.indexOf('没有可编码') >= 0, emptyError);

    log('\n===== 结果 =====');
    checks.forEach(c => log(c));
    const fails = checks.filter(c => c.indexOf('FAIL') === 0).length;
    log('\n共 ' + checks.length + ' 项，FAIL ' + fails + ' 项');
    lines.forEach(l => console.log(l));
    fs.writeFileSync(path.join(__dirname, 'wav-last-run.txt'), lines.join('\n'), 'utf8');
    process.exit(fails ? 1 : 0);
})().catch((e) => {
    console.error('测试异常:', e && e.stack ? e.stack : e);
    process.exit(1);
});
