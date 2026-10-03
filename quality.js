// ===========================================================================
// quality.js —— 画质 / 音质的纯逻辑（不碰 DOM，可在 Node 里直接单测）
// quality.js -- pure quality/tier logic (no DOM, unit-testable straight from Node)
//
// B 站 DASH 的两个坑：
// Two traps in Bilibili's DASH response:
//
// 坑一：同一个画质档位会同时提供多种编码（H.264 / HEVC / AV1），码率相差很大，
// Trap 1: one tier ships several codecs at once (H.264 / HEVC / AV1) whose bitrates
//       所以不能只按码率排 —— 480P 的 H.264 码率可能高过 1080P 的 AV1。
//   differ wildly, so bitrate alone is not enough: 480P H.264 can outrank 1080P AV1.
//       视频：先按档位 id 降序（id 代表分辨率等级），同档再按码率降序。
//   Video: tier id descending first (the id encodes the resolution class), then bitrate.
//
// 坑二：音频的 id 不按音质递增！30280(192K AAC) 的数字比 30251(Hi-Res 无损) 大，
// Trap 2: audio ids are NOT ordered by quality -- 30280 (192K AAC) is numerically
//       按 id 排会把无损音轨排到最后。所以音频只按码率降序。
//   greater than 30251 (Hi-Res lossless), so sorting by id buries the lossless track. Audio: bitrate only.
//
// 用户从菜单指定了「档位+编码」就按它挑，挑不到再退回最高档。
// If the user picked a "tier+codec" in the menu we honour it, otherwise we fall back to the best tier.
// ===========================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.BiliQuality = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var VIDEO_QUALITY_NAMES = {
        6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60',
        80: '1080P', 112: '1080P+', 116: '1080P60', 120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K'
    };
    var AUDIO_QUALITY_NAMES = {
        30216: '64K', 30232: '132K', 30280: '192K', 30250: '杜比全景声', 30251: 'Hi-Res 无损'
    };

    function qualityLabel(map, id) { return map[id] || ('id' + id); }
    function kbps(bandwidth) { return Math.round((bandwidth || 0) / 1000) + 'kbps'; }
    // 菜单里用紧凑写法，避免窄面板被截断
    // Compact notation for the menu, otherwise the narrow panel truncates it
    function mbps(bandwidth) { return ((bandwidth || 0) / 1000000).toFixed(1) + 'M'; }

    // codecs 形如 "hev1.1.6.L120.90" / "avc1.640028" / "av01.0.08M.08" / "mp4a.40.2" / "fLaC" / "ec-3" / "dvh1.08.07"
    // codecs look like "hev1.1.6.L120.90" / "avc1.640028" / "av01.0.08M.08" / "mp4a.40.2" / "fLaC" / "ec-3" / "dvh1.08.07"
    function codecFamily(codecs) {
        var c = String(codecs || '').toLowerCase();
        if (c.indexOf('avc') === 0) return 'H.264';
        if (c.indexOf('hev') === 0 || c.indexOf('hvc') === 0) return 'HEVC';
        if (c.indexOf('av01') === 0) return 'AV1';
        if (c.indexOf('dvh') === 0 || c.indexOf('dva') === 0) return '杜比视界';
        if (c.indexOf('ec-3') === 0) return '杜比';
        if (c.indexOf('flac') === 0) return 'FLAC';
        if (c.indexOf('mp4a') === 0) return 'AAC';
        return String(codecs || '').split('.')[0] || '未知';
    }

    function optionValue(stream) { return stream.id + '|' + codecFamily(stream.codecs); }

    // 档位名（1080P / 4K / Hi-Res 无损）本身已含分辨率信息，这里不再重复写 1920x1080，
    // The tier name (1080P / 4K / Hi-Res lossless) already implies the resolution, so we do
    // 只保留「档位 · 编码 · 码率」，否则窄面板显示不全
    // not repeat 1920x1080 -- only "tier / codec / bitrate" is kept so the narrow panel fits.
    function optionLabel(stream, labelMap) {
        return qualityLabel(labelMap, stream.id) + ' · ' + codecFamily(stream.codecs) + ' · ' + mbps(stream.bandwidth);
    }

    // 排序规则见文件头注释：视频按档位 id，音频只按码率
    // Sorting rules, see the file header: video by tier id, audio by bitrate only
    function sortStreams(list, kind) {
        var audio = kind === 'audio';
        return (list || []).slice().sort(function (a, b) {
            if (audio) return (b.bandwidth || 0) - (a.bandwidth || 0);
            return ((b.id || 0) - (a.id || 0)) || ((b.bandwidth || 0) - (a.bandwidth || 0));
        });
    }

    function pickBest(list, kind) {
        var sorted = sortStreams(list, kind);
        return sorted.length ? sorted[0] : null;
    }

    // key 形如 "80|HEVC"；'auto' / 空 / 找不到 都退回最高档
    // key looks like "80|HEVC"; 'auto' / empty / no match all fall back to the best tier
    function pickByKey(list, key, kind) {
        if (!list || !list.length) return null;
        if (!key || key === 'auto') return pickBest(list, kind);
        var parts = String(key).split('|');
        var id = parseInt(parts[0], 10);
        var fam = parts[1] || '';
        var matched = list.filter(function (s) {
            return s.id === id && (!fam || codecFamily(s.codecs) === fam);
        });
        return matched.length ? pickBest(matched, kind) : pickBest(list, kind);
    }

    // ======================= 音轨归集 =======================
    // ======================= Audio track collection =======================
    // 坑三：Hi-Res 无损挂在 dash.flac.audio，杜比全景声挂在 dash.dolby.audio，
    // Trap 3: Hi-Res lossless lives in dash.flac.audio and Dolby Atmos in dash.dolby.audio;
    //       两个都不在 dash.audio 里（实测 dash 字段为 duration/minBufferTime/
    //   neither is inside dash.audio (the real dash fields are duration/minBufferTime/
    //       min_buffer_time/video/audio/dolby/flac）。只读 dash.audio 的话这两档
    //   min_buffer_time/video/audio/dolby/flac). Reading dash.audio alone means those two
    //       永远不会出现在菜单里，哪怕账号有权限。
    //   tiers never appear in the menu, even for an entitled account.
    function collectAudio(dash) {
        if (!dash) return [];
        var out = [];
        var seen = {};

        function push(list) {
            if (!Array.isArray(list)) return;
            for (var i = 0; i < list.length; i++) {
                var s = list[i];
                if (!s || !s.baseUrl) continue;
                var key = s.id + '|' + (s.codecs || '');
                if (seen[key]) continue;
                seen[key] = 1;
                out.push(s);
            }
        }

        push(dash.audio);
        push(dash.flac && dash.flac.audio);
        push(dash.dolby && dash.dolby.audio);
        return out;
    }

    // 诊断 Hi-Res 拿不到的真正原因。实测（BV1tB4y1E7oT，标题即带 Hi-Res）匿名请求返回：
    // Diagnose why Hi-Res is missing. Measured with an anonymous request on BV1tB4y1E7oT
    //     flac = { display: true, audio: null }
    // 即：display=true 表示「这个视频确实有无损音轨」，audio=null 表示「当前账号拿不到」。
    // (a video whose title advertises Hi-Res), which returned flac = { display: true, audio: null }:
    // 换 qn / fnval 组合结果完全一致，所以参数不是瓶颈，只看账号权限。
    // display=true means the video DOES have a lossless track, audio=null means this account cannot get it.
    function describeHiRes(dash) {
        var f = dash && dash.flac;
        if (!f) return '该视频没有 Hi-Res 音轨';
        if (Array.isArray(f.audio) && f.audio.length) return '可下载（' + f.audio.length + ' 条）';
        if (f.display) return '视频有无损音轨，但当前账号拿不到（需登录且开通大会员）';
        return '该视频没有提供 Hi-Res 音轨';
    }

    function describeDolby(dash) {
        var d = (dash && dash.dolby) || null;
        if (!d) return '无该字段';
        if (Array.isArray(d.audio) && d.audio.length) return '可下载（' + d.audio.length + ' 条）';
        return '拿不到（type=' + d.type + '，需大会员，或该视频没有杜比音轨）';
    }

    // 诊断用：说清高阶音轨是「接口没返回」还是「本来就没有」
    // Diagnostic text: distinguishes "the API did not return it" from "it does not exist"
    function describeAudioSources(dash) {
        var d = dash || {};
        function count(node) {
            if (!node) return 0;
            if (Array.isArray(node)) return node.length;
            return Array.isArray(node.audio) ? node.audio.length : 0;
        }
        var normal = count(d.audio);
        var dolby = d.dolby ? count(d.dolby.audio) : 0;
        var flac = d.flac ? count(d.flac.audio) : 0;
        return '普通 ' + normal + ' 条 / 杜比 ' + (dolby || '无') + ' / Hi-Res ' + (flac || '无');
    }

    // dash 流都带 baseUrl + backupUrl（备用 CDN），逐个尝试能显著提高大文件成功率
    // Every dash stream carries baseUrl + backupUrl (spare CDNs); trying them in turn helps a lot on big files
    function streamUrls(stream) {
        var urls = [];
        if (stream.baseUrl) urls.push(stream.baseUrl);
        if (Array.isArray(stream.backupUrl)) {
            for (var i = 0; i < stream.backupUrl.length; i++) {
                if (stream.backupUrl[i] && urls.indexOf(stream.backupUrl[i]) < 0) urls.push(stream.backupUrl[i]);
            }
        }
        return urls;
    }

    function toStream(stream) {
        return {
            urls: streamUrls(stream),
            url: stream.baseUrl,
            quality: stream.id,
            bandwidth: stream.bandwidth,
            codecs: stream.codecs,
            width: stream.width,
            height: stream.height
        };
    }

    // 把流整理成下载流程用的结构；key 为菜单选中值，kind 为 'video' / 'audio'
    // Shape a stream for the download flow; key is the menu selection, kind is 'video' / 'audio'
    function resolve(list, key, kind) {
        if (!list || !list.length) return null;
        var picked = pickByKey(list, key, kind);
        return picked ? toStream(picked) : null;
    }

    function summarize(video, audio) {
        var parts = [];
        if (video) {
            parts.push('画面 ' + qualityLabel(VIDEO_QUALITY_NAMES, video.quality) +
                ' ' + video.width + 'x' + video.height + ' ' + codecFamily(video.codecs));
        }
        if (audio) {
            parts.push('声音 ' + qualityLabel(AUDIO_QUALITY_NAMES, audio.quality) + ' ' + codecFamily(audio.codecs));
        }
        return parts.join(' / ');
    }

    // 列表展示用（日志 / 调试 / 菜单选项），顺序与选流规则一致
    // For display (log / debug / menu options), ordered exactly like the selection rules
    function describeList(list, labelMap, kind) {
        return sortStreams(list, kind).map(function (s) { return optionLabel(s, labelMap, kind); });
    }

    return {
        VIDEO_QUALITY_NAMES: VIDEO_QUALITY_NAMES,
        AUDIO_QUALITY_NAMES: AUDIO_QUALITY_NAMES,
        qualityLabel: qualityLabel,
        kbps: kbps,
        mbps: mbps,
        codecFamily: codecFamily,
        optionValue: optionValue,
        optionLabel: optionLabel,
        sortStreams: sortStreams,
        pickBest: pickBest,
        pickByKey: pickByKey,
        streamUrls: streamUrls,
        collectAudio: collectAudio,
        describeAudioSources: describeAudioSources,
        describeHiRes: describeHiRes,
        describeDolby: describeDolby,
        resolve: resolve,
        summarize: summarize,
        describeList: describeList
    };
});
