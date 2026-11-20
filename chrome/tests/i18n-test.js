// ===========================================================================
// i18n.js 测试（纯逻辑，不需要联网）
// i18n.js tests (pure logic, no network needed)
//   node tests/i18n-test.js
// ===========================================================================
const fs = require('fs');
const path = require('path');
const I = require(path.join(__dirname, '..', 'i18n.js'));

const lines = [];
const checks = [];
const log = (s) => lines.push(s);
const check = (name, cond, extra) => checks.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));

const zhKeys = Object.keys(I.dict.zh).sort();
const enKeys = Object.keys(I.dict.en).sort();

log('===== 1. 词典完整性 =====');
check('中文 / 英文键完全一致', JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    'zh=' + zhKeys.length + ' en=' + enKeys.length);
const empty = zhKeys.filter(k => !String(I.dict.zh[k] || '').trim() || !String(I.dict.en[k] || '').trim());
check('没有空文案', empty.length === 0, empty.join(','));
check('langLabel 存在', !!I.dict.zh.langLabel && !!I.dict.en.langLabel);
check('设置按钮词条存在', !!I.dict.zh.settings && !!I.dict.en.settings && !!I.dict.zh.settingsHide && !!I.dict.en.settingsHide);
check('设置/语言标签为双语', I.dict.zh.settings.indexOf('Settings') >= 0 && I.dict.en.settings.indexOf('设置') >= 0 && I.dict.zh.langLabel.indexOf('Language') >= 0 && I.dict.en.langLabel.indexOf('语言') >= 0);
check('词条数量正常', zhKeys.length >= 50, zhKeys.length);

log('\n===== 2. 取值 / 占位符 =====');
check('英文档位标签', I.t('en', 'quality') === 'Quality', I.t('en', 'quality'));
check('中文档位标签', I.t('zh', 'quality') === '画质', I.t('zh', 'quality'));
check('未知语言退回中文', I.t('fr', 'quality') === '画质', I.t('fr', 'quality'));
check('未知键原样返回', I.t('en', 'no-such-key') === 'no-such-key');
check('占位符替换', I.t('en', 'updateTitle', { v: '1.2.3' }) === 'New version v1.2.3',
    I.t('en', 'updateTitle', { v: '1.2.3' }));
check('多个占位符替换', I.t('zh', 'updateDownloadBtn', { browser: 'Edge' }) === '下载 Edge 版',
    I.t('zh', 'updateDownloadBtn', { browser: 'Edge' }));
check('normalize 只认 en', I.normalize('en') === 'en' && I.normalize('EN') === 'zh' && I.normalize('fr') === 'zh');

log('\n===== 3. 浏览器语言自动检测 =====');
check('zh-CN → 中文', I.detect('zh-CN') === 'zh', I.detect('zh-CN'));
check('zh-TW → 中文', I.detect('zh-TW') === 'zh', I.detect('zh-TW'));
check('zh-Hans → 中文', I.detect('zh-Hans-CN') === 'zh', I.detect('zh-Hans-CN'));
check('zh → 中文', I.detect('zh') === 'zh');
check('en-US → 英文', I.detect('en-US') === 'en', I.detect('en-US'));
check('en → 英文', I.detect('en') === 'en');
check('其它语言 → 英文', I.detect('ja-JP') === 'en', I.detect('ja-JP'));

log('\n===== 3b. 浏览器语言变化时自动跟随 =====');
// 旧数据：手动存了 zh、但没记基线，浏览器现在是 en → 应跟随 en 并写回
let r = I.resolveLang('en', 'zh', undefined);
check('旧偏好无基线且语言不同 → 跟随浏览器', r.lang === 'en' && r.patch && r.patch.browserLang === 'en', JSON.stringify(r));
// 浏览器语言变化：基线 zh、现在 en → 跟随 en 并写回
r = I.resolveLang('en', 'zh', 'zh');
check('浏览器语言变化 → 跟随浏览器', r.lang === 'en' && r.patch && r.patch.lang === 'en' && r.patch.browserLang === 'en', JSON.stringify(r));
// 浏览器语言没变、用户手动选了别的 → 尊重手动
r = I.resolveLang('en', 'zh', 'en');
check('浏览器语言未变 → 尊重手动选择', r.lang === 'zh' && r.patch === null, JSON.stringify(r));
// 没有手动偏好 → 跟随浏览器并写基线
r = I.resolveLang('zh', undefined, undefined);
check('无偏好 → 跟随浏览器并记基线', r.lang === 'zh' && r.patch && r.patch.browserLang === 'zh', JSON.stringify(r));
// 浏览器语言没变、无手动偏好、已有基线 → 不写回
r = I.resolveLang('en', undefined, 'en');
check('稳定状态不重复写回', r.lang === 'en' && r.patch === null, JSON.stringify(r));

log('\n===== 4. 控制台日志双语 =====');
check('logPhrases 存在', !!I.logPhrases && Object.keys(I.logPhrases).length > 30,
    I.logPhrases ? Object.keys(I.logPhrases).length : 0);
// 与 content.js 相同的替换算法：长短语优先 + 占位符，避免短词拆散长词
function bilingual(s) {
    const phrases = I.logPhrases;
    const keys = Object.keys(phrases).filter(k => phrases[k]).sort((a, b) => b.length - a.length);
    const M = String.fromCharCode(1);
    let out = s;
    const hits = [];
    keys.forEach((k, i) => {
        if (out.indexOf(k) >= 0) { out = out.split(k).join(M + i + M); hits.push(i); }
    });
    hits.forEach(i => { out = out.split(M + i + M).join(keys[i] + ' / ' + phrases[keys[i]]); });
    return out;
}
check('启动日志双语', bilingual('[bili-dl] 内容脚本已加载 v1.27.0') ===
    '[bili-dl] 内容脚本已加载 / Content script loaded v1.27.0',
    bilingual('[bili-dl] 内容脚本已加载 v1.27.0'));
check('长短语优先不被短词拆散', bilingual('[bili-dl] 更新检查：当前 v1.27.0，最新 v1.26.0（页面加载）').indexOf('更新检查 / Update check') >= 0,
    bilingual('[bili-dl] 更新检查：当前 v1.27.0，最新 v1.26.0（页面加载）'));
check('动态值保持原样', bilingual('[bili-dl] 页面直连下载完成：12345 字节').indexOf('12345 字节 / bytes') >= 0,
    bilingual('[bili-dl] 页面直连下载完成：12345 字节'));
check('已跳过不再出现于更新日志', '[bili-dl] 更新检查：当前 v1.27.0，最新 v1.26.0（页面加载）'.indexOf('已跳过') < 0);

log('\n===== 结果 =====');
checks.forEach(c => log(c));
const fails = checks.filter(c => c.indexOf('FAIL') === 0).length;
log('\n共 ' + checks.length + ' 项，FAIL ' + fails + ' 项');
lines.forEach(l => console.log(l));
fs.writeFileSync(path.join(__dirname, 'i18n-last-run.txt'), lines.join('\n'), 'utf8');
process.exit(fails ? 1 : 0);
