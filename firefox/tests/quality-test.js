// ===========================================================================
// quality.js 测试（纯逻辑，不需要联网）
// quality.js tests (pure logic, no network needed)
//   node tests/quality-test.js
// ===========================================================================
const fs = require('fs');
const path = require('path');
const Q = require(path.join(__dirname, '..', 'quality.js'));

const lines = [];
const checks = [];
const log = (s) => lines.push(s);
const check = (name, cond, extra) => checks.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
const V = (list, key) => Q.resolve(list, key, 'video');
const A = (list, key) => Q.resolve(list, key, 'audio');

// 真实的匿名 dash 数据（实测抓取：同一档位含 hev1 / avc1 / av01 三种编码）
// Real anonymous dash data, captured live: one tier ships hev1 / avc1 / av01 all at once
const REAL_ANON = [
    { id: 32, baseUrl: 'https://cdn/v32-hev', backupUrl: ['https://b1/v32-hev', 'https://b2/v32-hev'], bandwidth: 600000, codecs: 'hev1.1.6.L120.90', width: 852, height: 480 },
    { id: 32, baseUrl: 'https://cdn/v32-avc', backupUrl: [], bandwidth: 800000, codecs: 'avc1.640033', width: 852, height: 480 },
    { id: 32, baseUrl: 'https://cdn/v32-av1', backupUrl: [], bandwidth: 300000, codecs: 'av01.0.05M.08', width: 852, height: 480 },
    { id: 16, baseUrl: 'https://cdn/v16-hev', bandwidth: 300000, codecs: 'hev1.1.6.L120.90', width: 640, height: 360 },
    { id: 16, baseUrl: 'https://cdn/v16-avc', bandwidth: 400000, codecs: 'avc1.64001e', width: 640, height: 360 },
    { id: 16, baseUrl: 'https://cdn/v16-av1', bandwidth: 200000, codecs: 'av01.0.04M.08', width: 640, height: 360 }
];
const REAL_AUDIO = [
    { id: 30232, baseUrl: 'https://cdn/a132', bandwidth: 132000, codecs: 'mp4a.40.2' },
    { id: 30216, baseUrl: 'https://cdn/a64', bandwidth: 64000, codecs: 'mp4a.40.2' },
    { id: 30280, baseUrl: 'https://cdn/a192', bandwidth: 192000, codecs: 'mp4a.40.2' }
];

// 大会员场景的合成数据：8K / 4K / HDR / 杜比视界 + 无损、杜比音轨
// Synthetic premium-account data: 8K / 4K / HDR / Dolby Vision plus lossless and Dolby audio
const VIP_VIDEO = [
    { id: 80, baseUrl: 'https://cdn/v80', bandwidth: 2500000, codecs: 'avc1.640032', width: 1920, height: 1080 },
    { id: 80, baseUrl: 'https://cdn/v80h', bandwidth: 1800000, codecs: 'hev1.1.6.L120.90', width: 1920, height: 1080 },
    { id: 116, baseUrl: 'https://cdn/v116', bandwidth: 6000000, codecs: 'avc1.640032', width: 1920, height: 1080 },
    { id: 120, baseUrl: 'https://cdn/v120', bandwidth: 16000000, codecs: 'hev1.1.6.L150.90', width: 3840, height: 2160 },
    { id: 125, baseUrl: 'https://cdn/v125', bandwidth: 20000000, codecs: 'hev1.1.6.L150.90', width: 3840, height: 2160 },
    { id: 126, baseUrl: 'https://cdn/v126', bandwidth: 28000000, codecs: 'dvh1.08.07', width: 3840, height: 2160 },
    { id: 127, baseUrl: 'https://cdn/v127', bandwidth: 40000000, codecs: 'hev1.1.6.L186.90', width: 7680, height: 4320 }
];
const VIP_AUDIO = [
    { id: 30280, baseUrl: 'https://cdn/a192', bandwidth: 192000, codecs: 'mp4a.40.2' },
    { id: 30250, baseUrl: 'https://cdn/aec3', bandwidth: 448000, codecs: 'ec-3' },
    { id: 30251, baseUrl: 'https://cdn/aflac', bandwidth: 1000000, codecs: 'fLaC' }
];

// ------------------------------------------------------------ 编码识别
// ------------------------------------------------------------ Codec detection
log('===== 1. 编码家族识别 =====');
const codecCases = [
    ['hev1.1.6.L120.90', 'HEVC'],
    ['hvc1.1.6.L120.90', 'HEVC'],
    ['avc1.640033', 'H.264'],
    ['av01.0.05M.08', 'AV1'],
    ['mp4a.40.2', 'AAC'],
    ['ec-3', '杜比'],
    ['fLaC', 'FLAC'],
    ['dvh1.08.07', '杜比视界'],
    ['', '未知']
];
let codecFail = 0;
codecCases.forEach(([input, expect]) => {
    const got = Q.codecFamily(input);
    if (got !== expect) { codecFail++; log('  FAIL ' + JSON.stringify(input) + ' -> ' + got + ' 期望 ' + expect); }
});
check('编码识别（' + codecCases.length + ' 例，含 fLaC 大小写与 dvh1）', codecFail === 0, '失败 ' + codecFail);

// ------------------------------------------------------------ 自动选最高
// ------------------------------------------------------------ Auto-pick the best
log('\n===== 2. 自动模式（菜单选「最高（自动）」）=====');
const autoV = V(REAL_ANON, 'auto');
check('匿名视频：选到 480P 而非 360P', autoV.quality === 32, 'id=' + autoV.quality);
check('匿名视频：同档位内选码率最高的 H.264(800k) 而非 AV1(300k)', autoV.codecs === 'avc1.640033', autoV.codecs);
const autoA = A(REAL_AUDIO, 'auto');
check('匿名音频：选到 192K', autoA.quality === 30280, 'id=' + autoA.quality);
log('  匿名自动：视频 ' + autoV.quality + ' ' + Q.codecFamily(autoV.codecs) +
    '，音频 ' + autoA.quality + ' ' + Q.codecFamily(autoA.codecs));

const vipV = V(VIP_VIDEO, 'auto');
check('大会员视频：自动选到 8K(127)', vipV.quality === 127, 'id=' + vipV.quality);
const vipA = A(VIP_AUDIO, 'auto');
// 回归点：音频 id 30280(192K AAC) 数字上比 30251(无损) 大，若按 id 排会选错
// Regression: audio id 30280 (192K AAC) is numerically greater than 30251 (lossless), so id-sorting picks wrong
check('大会员音频：自动选 Hi-Res 无损(30251) 而不是 192K AAC(30280)', vipA.quality === 30251, 'id=' + vipA.quality);
check('大会员音频：选到码率最高的那条', vipA.bandwidth === 1000000, vipA.bandwidth);
log('  大会员自动：视频 ' + vipV.quality + ' ' + Q.codecFamily(vipV.codecs) +
    '，音频 ' + vipA.quality + ' ' + Q.codecFamily(vipA.codecs));

// 音频 id 顺序陷阱：给出全部 5 档音质，必须选无损
// The audio-id ordering trap: given all five audio tiers, lossless must win
const ALL_AUDIO = [
    { id: 30216, bandwidth: 64000, codecs: 'mp4a.40.2' },
    { id: 30232, bandwidth: 132000, codecs: 'mp4a.40.2' },
    { id: 30280, bandwidth: 192000, codecs: 'mp4a.40.2' },
    { id: 30250, bandwidth: 448000, codecs: 'ec-3' },
    { id: 30251, bandwidth: 1000000, codecs: 'fLaC' }
];
const seq = Q.sortStreams(ALL_AUDIO, 'audio').map(s => s.id);
check('音频排序与 id 数字顺序无关（30251 在 30280 之前）', seq.join(',') === '30251,30250,30280,30232,30216', seq.join(','));
const seqV = Q.sortStreams(VIP_VIDEO, 'video').map(s => s.id);
check('视频排序按档位 id 降序', seqV.join(',') === '127,126,125,120,116,80,80', seqV.join(','));

// ------------------------------------------------------------ 手动指定
// ------------------------------------------------------------ Manual selection
log('\n===== 3. 菜单手动指定 =====');
const pick480hev = V(REAL_ANON, '32|HEVC');
check('指定 480P·HEVC 命中正确编码变体', pick480hev.codecs === 'hev1.1.6.L120.90', pick480hev.codecs);
const pick360av1 = V(REAL_ANON, '16|AV1');
check('指定 360P·AV1（最低档最低码率）', pick360av1.quality === 16 && pick360av1.codecs === 'av01.0.04M.08', pick360av1.codecs);
const pick4k = V(VIP_VIDEO, '120|HEVC');
check('指定 4K，不会被 HDR/DV/8K 覆盖', pick4k.quality === 120, 'id=' + pick4k.quality);
const pickDv = V(VIP_VIDEO, '126|杜比视界');
check('指定杜比视界', pickDv.quality === 126, 'id=' + pickDv.quality);
const pickFlac = A(VIP_AUDIO, '30251|FLAC');
check('指定 Hi-Res 无损音轨', pickFlac.quality === 30251, 'id=' + pickFlac.quality);
const pickA192 = A(VIP_AUDIO, '30280|AAC');
check('指定 192K·AAC', pickA192.quality === 30280, 'id=' + pickA192.quality);

// 边界：档位不存在 / 编码不存在 / 空列表
// Edge cases: missing tier / missing codec / empty list
check('选了当前视频没有的档位 → 安全退回最高档', V(REAL_ANON, '120|HEVC').quality === 32);
check('档位存在但编码不存在 → 退回该档位内码率最高者', V(REAL_ANON, '32|FLAC').codecs === 'avc1.640033');
check('空列表返回 null 而不抛错', V([], 'auto') === null && A([], 'auto') === null);
check('null/undefined 列表也不抛错', Q.resolve(null, 'auto', 'video') === null);

// ------------------------------------------------------------ 备用地址
// ------------------------------------------------------------ Backup URLs
log('\n===== 4. 备用 CDN 地址 =====');
check('baseUrl + 2 个 backupUrl 全部收集', Q.streamUrls(REAL_ANON[0]).length === 3);
const dedup = Q.streamUrls({ baseUrl: 'https://a', backupUrl: ['https://a', 'https://b'] });
check('重复地址去重', dedup.length === 2, dedup.join(','));
check('resolve 结果里带上备用地址', V(REAL_ANON, '32|HEVC').urls.length === 3);

// ------------------------------------------------------------ 展示文本
// ------------------------------------------------------------ Display text
log('\n===== 5. 菜单文案 =====');
const vLabel = Q.optionLabel(VIP_VIDEO[3], Q.VIDEO_QUALITY_NAMES, 'video');
const dvLabel = Q.optionLabel(VIP_VIDEO[5], Q.VIDEO_QUALITY_NAMES, 'video');
const aLabel = Q.optionLabel(VIP_AUDIO[2], Q.AUDIO_QUALITY_NAMES, 'audio');
log('  视频选项: ' + vLabel);
log('  视频选项: ' + dvLabel);
log('  音频选项: ' + aLabel);
check('视频文案：档位 · 编码 · 码率', vLabel === '4K · HEVC · 16.0M', vLabel);
check('杜比视界文案可读（不显示裸 dvh1）', dvLabel === '杜比视界 · 杜比视界 · 28.0M', dvLabel);
check('音频文案含 FLAC', aLabel === 'Hi-Res 无损 · FLAC · 1.0M', aLabel);
// 面板里 select 宽 172px，扣掉内边距与下拉箭头，文字可用宽度约 150px。
// The panel select is 172px wide; minus padding and the dropdown arrow, text gets about 150px.
// 中文在 10px 字号下约 10px 宽，拉丁字母约 5.5px，按这个估算比数字符数靠谱。
// At 10px a CJK glyph is ~10px wide and a Latin letter ~5.5px; estimating that beats counting characters.
function estWidth(s) {
    let w = 0;
    for (const ch of s) w += /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 10 : 5.5;
    return w;
}
check('文案宽度适配窄面板（≤150px 不截断）',
    estWidth(vLabel) <= 150 && estWidth(aLabel) <= 150 && estWidth(dvLabel) <= 150,
    '视频 ' + Math.round(estWidth(vLabel)) + 'px / 音频 ' + Math.round(estWidth(aLabel)) + 'px / 杜比 ' + Math.round(estWidth(dvLabel)) + 'px');
check('选项值格式为 id|编码', Q.optionValue(VIP_VIDEO[3]) === '120|HEVC', Q.optionValue(VIP_VIDEO[3]));
check('杜比视界选项值可用于回选', Q.optionValue(VIP_VIDEO[5]) === '126|杜比视界', Q.optionValue(VIP_VIDEO[5]));
check('列表按档位降序（8K 在最前）', Q.describeList(VIP_VIDEO, Q.VIDEO_QUALITY_NAMES, 'video')[0].indexOf('8K') === 0);

const sum = Q.summarize(V(VIP_VIDEO, 'auto'), A(VIP_AUDIO, 'auto'));
log('  弹窗规格文案: ' + sum);
check('规格摘要含画面与声音', sum.indexOf('画面 8K') === 0 && sum.indexOf('声音 Hi-Res 无损') > 0, sum);

// ------------------------------------------------------------ 音轨归集
// ------------------------------------------------------------ Audio collection
log('\n===== 6. 音轨归集（Hi-Res / 杜比 不在 dash.audio 里）=====');
const FLAC_STREAM = { id: 30251, baseUrl: 'https://cdn/aflac', bandwidth: 1400000, codecs: 'fLaC' };
const DOLBY_STREAM = { id: 30250, baseUrl: 'https://cdn/aec3', bandwidth: 448000, codecs: 'ec-3' };

const DASH_WITH_HIGH = {
    video: VIP_VIDEO,
    audio: REAL_AUDIO,
    flac: { display: true, audio: [FLAC_STREAM] },
    dolby: { type: 1, audio: [DOLBY_STREAM] }
};
const collected = Q.collectAudio(DASH_WITH_HIGH);
check('归集到 3 条普通 + 1 条杜比 + 1 条 Hi-Res', collected.length === 5,
    collected.map(s => s.id).join(','));
check('Hi-Res 确实被收集进来', collected.some(s => s.id === 30251));
check('杜比全景声确实被收集进来', collected.some(s => s.id === 30250));

// 实测的匿名响应：flac=null，dolby={type:0,audio:null}
// Measured anonymous response: flac=null, dolby={type:0,audio:null}
const DASH_ANON = { video: REAL_ANON, audio: REAL_AUDIO, dolby: { type: 0, audio: null }, flac: null };
check('flac=null / dolby.audio=null 时不报错且只有普通音轨',
    Q.collectAudio(DASH_ANON).length === 3, Q.collectAudio(DASH_ANON).length);
check('dash 完全为空时返回空数组', Q.collectAudio({}).length === 0 && Q.collectAudio(null).length === 0);

// 归集后自动选流必须选中 Hi-Res
// After collection, auto-pick must land on Hi-Res
const bestAudio = A(Q.collectAudio(DASH_WITH_HIGH), 'auto');
check('归集后自动选到 Hi-Res 无损', bestAudio.quality === 30251, 'id=' + bestAudio.quality);
const bestAac = A(Q.collectAudio(DASH_WITH_HIGH), '30280|AAC');
check('归集后仍可手动选回 192K AAC', bestAac.quality === 30280, 'id=' + bestAac.quality);

// 去重：同一 id+编码 出现在两处只保留一条
// Dedup: the same id+codec appearing twice is kept once
const DUP = { audio: [FLAC_STREAM], flac: { audio: [FLAC_STREAM] } };
check('重复音轨去重', Q.collectAudio(DUP).length === 1, Q.collectAudio(DUP).length);

// 诊断文案
// Diagnostic text
const diagFull = Q.describeAudioSources(DASH_WITH_HIGH);
const diagAnon = Q.describeAudioSources(DASH_ANON);
log('  诊断(有 Hi-Res): ' + diagFull);
log('  诊断(匿名实测): ' + diagAnon);
check('诊断文案标出 Hi-Res 条数', diagFull.indexOf('Hi-Res 1') > 0, diagFull);
check('诊断文案在无高阶音轨时显示「无」', diagAnon.indexOf('杜比 无') > 0 && diagAnon.indexOf('Hi-Res 无') > 0, diagAnon);

// 菜单文案
// Menu labels
check('Hi-Res 选项文案可读', Q.optionLabel(FLAC_STREAM, Q.AUDIO_QUALITY_NAMES, 'audio') === 'Hi-Res 无损 · FLAC · 1.4M',
    Q.optionLabel(FLAC_STREAM, Q.AUDIO_QUALITY_NAMES, 'audio'));

// ------------------------------------------------- Hi-Res 拿不到的原因判定
// ------------------------------------------------- Why Hi-Res is unavailable
log('\n===== 7. Hi-Res 诊断（区分「视频没有」与「账号没权限」）=====');
// 实测原文：BV1tB4y1E7oT 匿名请求返回 flac = {display:true, audio:null}
// Verbatim measurement: an anonymous request on BV1tB4y1E7oT returns flac = {display:true, audio:null}
const REAL_ANON_FLAC = { video: [], audio: REAL_AUDIO, flac: { display: true, audio: null }, dolby: { type: 0, audio: null } };
const NO_FLAC = { video: [], audio: REAL_AUDIO, flac: null, dolby: { type: 0, audio: null } };
const HAS_FLAC = { video: [], audio: REAL_AUDIO, flac: { display: true, audio: [FLAC_STREAM] }, dolby: { type: 1, audio: [DOLBY_STREAM] } };

const d1 = Q.describeHiRes(REAL_ANON_FLAC);
const d2 = Q.describeHiRes(NO_FLAC);
const d3 = Q.describeHiRes(HAS_FLAC);
log('  flac={display:true,audio:null} → ' + d1);
log('  flac=null                    → ' + d2);
log('  flac={display:true,audio:[…]} → ' + d3);
check('display=true + audio=null → 判定为「账号拿不到」', d1.indexOf('当前账号拿不到') > 0, d1);
check('flac 缺失 → 判定为「视频没有」', d2.indexOf('该视频没有') === 0, d2);
check('audio 非空 → 判定为「可下载」', d3.indexOf('可下载') === 0, d3);

const dol1 = Q.describeDolby(REAL_ANON_FLAC);
const dol2 = Q.describeDolby(HAS_FLAC);
log('  dolby={type:0,audio:null}    → ' + dol1);
log('  dolby={type:1,audio:[…]}     → ' + dol2);
check('杜比拿不到时给出原因', dol1.indexOf('拿不到') === 0 && dol1.indexOf('type=0') > 0, dol1);
check('杜比可取时判定为可下载', dol2.indexOf('可下载') === 0, dol2);
check('dash 为空时诊断不抛错', Q.describeHiRes(null).length > 0 && Q.describeDolby({}).length > 0);

// 关键回归：display=true 但 audio=null 时，菜单里绝不能凭 display 造出一条假音轨
// Key regression: with display=true but audio=null the menu must never invent a phantom track from display
check('display=true 但 audio=null 不会伪造音轨', Q.collectAudio(REAL_ANON_FLAC).length === 3,
    Q.collectAudio(REAL_ANON_FLAC).length);

log('\n===== 结果 =====');
checks.forEach(c => log(c));
const fails = checks.filter(c => c.indexOf('FAIL') === 0).length;
log('\n共 ' + checks.length + ' 项，FAIL ' + fails + ' 项');
lines.forEach(l => console.log(l));
fs.writeFileSync(path.join(__dirname, 'quality-last-run.txt'), lines.join('\n'), 'utf8');
process.exit(fails ? 1 : 0);
