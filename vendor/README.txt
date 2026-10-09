lamejs —— mp3 编码器（第三方库）
lamejs -- the mp3 encoder (third-party library)

这个文件夹里放的是本扩展用到的第三方库，不是本项目的代码。
This folder holds third-party libraries used by this extension. Nothing here is
original project code.

──────────────────────────────────────────────────────────────

【lamejs.iife.js】

  用途：把解码后的 PCM 编码成 mp3（「音频格式」选 mp3 时用到）。
  版本：@breezystack/lamejs 1.2.7（lamejs 的社区维护版，原版多年未更新）
  构建：官方 dist/lamejs.iife.js —— IIFE 形式，加载后暴露全局变量 lamejs，
        因此可以直接被内容脚本以 <content_scripts> 顺序加载，无需打包器。
  来源：https://www.npmjs.com/package/@breezystack/lamejs
        https://github.com/shijinyu/lamejs
  许可：LGPL-3.0（见同目录 lamejs-LICENSE.txt）

  本项目整体以 GPL-3.0 发布；LGPL-3.0 的库可以与 GPL-3.0 项目一同分发，
  前提是保留其版权声明与许可证原文 —— 也就是这个目录里的两个文件。
  「lamejs.iife.js」保持官方构建产物原样，未做任何修改。

──────────────────────────────────────────────────────────────

[lamejs.iife.js]

  Purpose: encode decoded PCM into mp3 (used when "Audio format" is set to mp3).
  Version: @breezystack/lamejs 1.2.7 (a community-maintained fork; the original
           lamejs has not been updated in years)
  Build:   the official dist/lamejs.iife.js -- an IIFE that exposes a global named
           "lamejs", so the content script can simply load it in order without a bundler.
  Source:  https://www.npmjs.com/package/@breezystack/lamejs
           https://github.com/shijinyu/lamejs
  License: LGPL-3.0 (full text in lamejs-LICENSE.txt next to this file)

  This project as a whole is released under GPL-3.0. An LGPL-3.0 library may be
  distributed alongside a GPL-3.0 project as long as its copyright notice and license
  text are kept -- that is exactly what the two files in this folder are for.
  "lamejs.iife.js" is the untouched official build.

