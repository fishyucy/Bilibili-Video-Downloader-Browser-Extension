// ===========================================================================
// wbi.js —— B 站 WBI 签名
// wbi.js -- Bilibili WBI signature
//
// B 站的 /x/player/wbi/playurl 等接口要求带 w_rid 签名，否则会被风控挡下
// Endpoints such as /x/player/wbi/playurl require a w_rid signature;
// （高画质档位尤其容易拿不到）。签名规则：
// without it the risk-control layer tends to withhold the higher tiers. How it works:
//
//   1. 取 nav 接口返回的 wbi_img.img_url / sub_url，各自去掉路径与扩展名得到
//   1. Take wbi_img.img_url / sub_url from the nav endpoint, strip the path and
//      img_key、sub_key（各 32 位十六进制）
//      the extension to get img_key / sub_key (32 hex chars each)
//   2. raw = img_key + sub_key（64 位），按固定的 MIXIN_KEY_ENC_TAB 重排后
//   2. raw = img_key + sub_key (64 chars); reorder it through the fixed
//      取前 32 位，得到 mixinKey
//      MIXIN_KEY_ENC_TAB and keep the first 32 chars as mixinKey
//   3. 参数里加上 wts（当前 Unix 秒），值中剔除 !'()* 四个字符，
//   3. Add wts (current Unix seconds), strip the four characters !'()* from values,
//      按 key 的 ASCII 升序排列拼成查询串 q
//      sort the keys by ASCII ascending and join them into the query string q
//   4. w_rid = md5(q + mixinKey)，拼到查询串末尾
//   4. w_rid = md5(q + mixinKey), appended to the end of the query string
//
// WebCrypto 不提供 MD5（只有 SHA 系列），所以这里自带一份实现。
// WebCrypto offers no MD5 (only the SHA family), so we ship our own implementation.
// ===========================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.BiliWbi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // B 站官方的重排表（改动会导致签名全部失效）
    // Bilibili's official permutation table (any change invalidates every signature)
    var MIXIN_KEY_ENC_TAB = [
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
        33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
        26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
        20, 34, 44, 52
    ];

    // ------------------------------------------------------------------ MD5
    // K[i] = floor(abs(sin(i+1)) * 2^32)，按标准定义在加载时算出来
    // K[i] = floor(abs(sin(i+1)) * 2^32), derived at load time exactly as the spec defines
    var MD5_K = (function () {
        var k = [];
        for (var i = 0; i < 64; i++) k.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
        return k;
    })();
    var MD5_S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];

    function utf8Bytes(str) {
        var out = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) {
                out.push(c);
            } else if (c < 0x800) {
                out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
            } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
                var c2 = str.charCodeAt(i + 1);
                if (c2 >= 0xdc00 && c2 <= 0xdfff) {
                    var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
                    out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                        0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
                    i++;
                } else {
                    out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
                }
            } else {
                out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            }
        }
        return out;
    }

    function toHexLE(x) {
        var s = '';
        for (var i = 0; i < 4; i++) {
            var b = (x >>> (i * 8)) & 0xff;
            s += (b < 16 ? '0' : '') + b.toString(16);
        }
        return s;
    }

    function md5(str) {
        var bytes = utf8Bytes(String(str));
        var bitLen = bytes.length * 8;
        var msg = bytes.slice();
        msg.push(0x80);
        while (msg.length % 64 !== 56) msg.push(0);
        // 追加 64 位小端长度
        // append the 64-bit little-endian bit length
        var lo = bitLen >>> 0;
        var hi = Math.floor(bitLen / 4294967296);
        for (var p = 0; p < 4; p++) msg.push((lo >>> (p * 8)) & 0xff);
        for (var q = 0; q < 4; q++) msg.push((hi >>> (q * 8)) & 0xff);

        var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
        var M = new Array(16);

        for (var off = 0; off < msg.length; off += 64) {
            for (var k = 0; k < 16; k++) {
                M[k] = (msg[off + k * 4] | (msg[off + k * 4 + 1] << 8) |
                    (msg[off + k * 4 + 2] << 16) | (msg[off + k * 4 + 3] << 24)) | 0;
            }
            var A = a0, B = b0, C = c0, D = d0;
            for (var i = 0; i < 64; i++) {
                var F, g;
                if (i < 16) { F = (B & C) | (~B & D); g = i; }
                else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
                else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
                else { F = C ^ (B | ~D); g = (7 * i) % 16; }

                F = (F + A + MD5_K[i] + M[g]) | 0;
                A = D; D = C; C = B;
                var s = MD5_S[i];
                B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
            }
            a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
        }
        return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
    }

    // ------------------------------------------------------------------ WBI
    function fileNameKey(url) {
        var name = String(url || '').split('/').pop().split('?')[0];
        return name.split('.')[0];
    }

    function getMixinKey(imgKey, subKey) {
        var raw = String(imgKey || '') + String(subKey || '');
        if (raw.length < 64) return '';
        var out = '';
        for (var i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) out += raw.charAt(MIXIN_KEY_ENC_TAB[i]);
        return out.slice(0, 32);
    }

    function mixinKeyFromUrls(imgUrl, subUrl) {
        return getMixinKey(fileNameKey(imgUrl), fileNameKey(subUrl));
    }

    // 生成 "k=v&k=v&...&w_rid=xxx"（参数按 key 升序，值剔除 !'()*，UTF-8 百分号编码）
    // Build "k=v&k=v&...&w_rid=xxx" (keys ascending, !'()* stripped, percent-encoded UTF-8)
    function signedQuery(params, mixinKey, wts) {
        var clean = {};
        var filter = /[!'()*]/g;
        for (var key in params) {
            if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
            clean[key] = String(params[key]).replace(filter, '');
        }
        clean.wts = String(wts || Math.round(Date.now() / 1000));

        var query = Object.keys(clean).sort().map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(clean[k]);
        }).join('&');

        return query + '&w_rid=' + md5(query + mixinKey);
    }

    return {
        md5: md5,
        getMixinKey: getMixinKey,
        mixinKeyFromUrls: mixinKeyFromUrls,
        signedQuery: signedQuery,
        MIXIN_KEY_ENC_TAB: MIXIN_KEY_ENC_TAB
    };
});
