// ===========================================================================
// wbi.js 测试
// wbi.js tests
//   node tests/wbi-test.js
//
//   1. MD5 与 Node 自带 crypto 逐一对拍
//   1. Cross-check MD5 against Node's built-in crypto
//   2. mixinKey 与 B 站官方文档给出的示例值对拍
//   2. Cross-check mixinKey against the example in Bilibili's docs
//   3. 真调 /x/player/wbi/playurl，确认签名被服务端接受（返回 code=0 且有 dash）
//   3. Really call /x/player/wbi/playurl to confirm the server accepts the signature (code=0 with dash)
// ===========================================================================
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Wbi = require(path.join(__dirname, '..', 'wbi.js'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'Referer': 'https://www.bilibili.com/', 'User-Agent': UA, 'Origin': 'https://www.bilibili.com' };
const lines = [];
const checks = [];
const log = (s) => lines.push(s);
const check = (name, cond, extra) => checks.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));

// ---------------------------------------------------------------- 1. MD5
log('===== 1. MD5 对拍 =====');
const md5Cases = [
    '',
    'a',
    'abc',
    'message digest',
    'abcdefghijklmnopqrstuvwxyz',
    '1234567890'.repeat(8),
    'a'.repeat(55),   // 边界：padding 刚好 / boundary: padding fits exactly
    'a'.repeat(56),   // 边界：需要多一个块 / boundary: needs one extra block
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    'a'.repeat(1000),
    'bilibili 哔哩哔哩 中文签名测试',
    'wts=1702204169&foo=114&bar=514'
];
let md5Fail = 0;
for (const c of md5Cases) {
    const mine = Wbi.md5(c);
    const std = crypto.createHash('md5').update(c, 'utf8').digest('hex');
    const ok = mine === std;
    if (!ok) { md5Fail++; log('  FAIL ' + JSON.stringify(c.slice(0, 24)) + ' -> ' + mine + ' != ' + std); }
}
check('MD5 与 crypto 完全一致（' + md5Cases.length + ' 个用例）', md5Fail === 0, '失败 ' + md5Fail);
log('  对拍 ' + md5Cases.length + ' 个用例，失败 ' + md5Fail);
log('  示例 md5("abc") = ' + Wbi.md5('abc') + '（标准值 900150983cd24fb0d6963f7d28e17f72）');

// ---------------------------------------------------------------- 2. mixinKey
log('\n===== 2. mixinKey 重排 =====');
const imgKey = '7cd084941338484aae1ad9425b84077c';
const subKey = '4932caff0ff746eab6f01bf08b70ac45';
const EXPECT_MIXIN = 'ea1db124af3c7062474693fa704f4ff8';
const mixin = Wbi.getMixinKey(imgKey, subKey);
check('mixinKey 与官方示例一致', mixin === EXPECT_MIXIN, mixin + ' vs ' + EXPECT_MIXIN);
log('  计算值 ' + mixin);
log('  文档值 ' + EXPECT_MIXIN);
const fromUrls = Wbi.mixinKeyFromUrls(
    'https://i0.hdslb.com/bfs/wbi/' + imgKey + '.png',
    'https://i0.hdslb.com/bfs/wbi/' + subKey + '.png');
check('从 img_url/sub_url 提取结果一致', fromUrls === EXPECT_MIXIN);

// ------------------------------------------------------- 3. 真调 wbi 接口
// ------------------------------------------------------- 3. Hit the real wbi endpoint
(async () => {
    log('\n===== 3. 真实调用 /x/player/wbi/playurl =====');
    try {
        const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: HEADERS })).json();
        const wbi = nav.data && nav.data.wbi_img;
        log('  nav.code=' + nav.code + '  isLogin=' + (nav.data && nav.data.isLogin) + '  有 wbi_img=' + !!wbi);
        if (!wbi) throw new Error('nav 未返回 wbi_img');
        log('  img_url=' + wbi.img_url);
        log('  sub_url=' + wbi.sub_url);
        const mk = Wbi.mixinKeyFromUrls(wbi.img_url, wbi.sub_url);
        log('  mixinKey=' + mk);
        check('mixinKey 长度 32', mk.length === 32, mk.length);

        const bvid = 'BV1GJ411x7h7';
        const view = await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { headers: HEADERS })).json();
        const cid = view.data.cid;

        const params = { bvid: bvid, cid: cid, qn: 127, fnval: 4048, fnver: 0, fourk: 1 };
        const wts = Math.round(Date.now() / 1000);
        const query = Wbi.signedQuery(params, mk, wts);
        log('  签名查询串: ' + query);

        const signed = await (await fetch('https://api.bilibili.com/x/player/wbi/playurl?' + query, { headers: HEADERS })).json();
        log('  带签名 HTTP 结果: code=' + signed.code + ' message=' + signed.message);
        check('wbi 接口接受签名（code=0）', signed.code === 0, 'code=' + signed.code + ' ' + signed.message);
        const dash = signed.data && signed.data.dash;
        check('返回了 dash 流', !!dash);
        if (dash) {
            log('  视频档位: ' + (dash.video || []).map(s => s.id + '/' + s.width + 'x' + s.height + '/' + (s.codecs || '').split('.')[0]).join(' '));
            log('  音频档位: ' + (dash.audio || []).map(s => s.id + '/' + (s.codecs || '').split('.')[0]).join(' '));
        }

        // 对比不带签名的旧接口（签名错误时服务端会返回非 0）
        // Compare against the unsigned legacy endpoint (a bad signature makes the server return non-zero)
        // 反证：故意用错 mixinKey。
        // Counter-test: deliberately use a wrong mixinKey.
        // 实测结论：该接口在匿名请求下并不强制校验签名（错误签名同样 code=0），
        // Measured: for anonymous requests this endpoint does not enforce the signature (a wrong one still returns code=0),
        // 所以这里不做通过/失败判定，仅记录现象 —— 解锁高画质靠的是登录态，不是签名。
        // so this is recorded rather than asserted -- high quality is unlocked by being logged in, not by the signature.
        const bad = await (await fetch('https://api.bilibili.com/x/player/wbi/playurl' + '?' + Wbi.signedQuery(params, '0'.repeat(32), wts), { headers: HEADERS })).json();
        log('  故意用错误 mixinKey 签名 -> code=' + bad.code + ' message=' + bad.message +
            '（说明该接口匿名下不强制校验签名；但 wbi 是现行接口，仍作为首选）');

        const plain = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=127&fnval=4048&fnver=0&fourk=1`, { headers: HEADERS })).json();
        const pd = plain.data && plain.data.dash;
        log('  旧接口(无签名) code=' + plain.code + ' 视频档位: ' + (pd ? (pd.video || []).map(s => s.id).join(',') : '-'));
    } catch (e) {
        log('  异常: ' + (e && e.stack ? e.stack : e));
        check('真实调用未抛异常', false, e && e.message);
    }

    log('\n===== 结果 =====');
    checks.forEach(c => log(c));
    const fails = checks.filter(c => c.indexOf('FAIL') === 0).length;
    log('\n共 ' + checks.length + ' 项，FAIL ' + fails + ' 项');
    log('');
    lines.forEach(l => console.log(l));
    fs.writeFileSync(path.join(__dirname, 'wbi-last-run.txt'), lines.join('\n'), 'utf8');
    process.exit(fails ? 1 : 0);
})();
