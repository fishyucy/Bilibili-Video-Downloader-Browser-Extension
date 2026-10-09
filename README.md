# B站视频/音频下载器 · Bilibili Video & Audio Downloader

> Chrome / Edge 扩展（Manifest V3）· 在视频页提供下载面板，可选任意画质与音质档位，音视频自动合并为单个 MP4。
>
> A Chrome / Edge extension (Manifest V3). Adds a download panel to Bilibili video pages: pick any quality and audio tier, and get a single merged MP4.
>
> **中文在前，English below.** · [跳到 English](#english)
>
> 作者 / Author: **fish**

---

# 中文

## 这是什么

在 B 站视频页右下角注入一个下载面板：把这个视频**真实可用的画质与音质档位**列出来，由你自己挑，然后下载、自动合并成单个 MP4。

和"嗅探最高清晰度"的做法不同，它不猜——**接口返回了什么就列什么**，包括同一档位下的各种编码：

```
画质  [1080P · H.264 · 1.9M]  [1080P · HEVC · 1.4M]  [1080P · AV1 · 1.1M]  ...
音质  [192K · AAC]  [杜比全景声 · 杜比 · 1025kbps]  ...
```

## 特性

- **档位菜单**：按「档位 + 编码」分开列出，兼容性优先选 H.264，省流量选 HEVC / AV1
- **三种下载**：仅音频（`.m4a` / `.mp3`）、仅视频（`.mp4`）、视频+音频（自动合并成单个 MP4）
- **音频格式可选**：仅音频支持 `m4a`（原声直存，最快）或 `mp3`（192kbps 转码）。
  **本机装了 FFmpeg 就自动交给它**（快得多、不占页面内存）；没装则在浏览器里用内置编码器转，
  **不需要安装任何东西、也不联网**
- **自动合并**：搬运 MP4 盒子 + 改写 4 字节 track_ID，**不转码**，画质音质零损失
- **暂停 / 继续 / 取消**：三条下载通道都支持，取消不会触发重试
- **多分P**：自动识别当前播放的分P，切P自动重新读取档位
- **三条通道自动回退**：页面直连 → 后台 Service Worker → 分片下载，主地址失败自动换备用 CDN
- **零依赖、无构建**：纯原生 JavaScript，改完直接在浏览器重载即生效

## 安装

这是 Chromium 内核扩展（Manifest V3），Chromium 系浏览器都用「加载已解压的扩展程序」这种方式安装。

> 用 release 里的压缩包的话：**先解压**，再选解压出来的那个文件夹。

### 各浏览器加载步骤

| 浏览器 | 扩展管理页 | 备注 |
|---|---|---|
| **Chrome** | `chrome://extensions` | 右上角先打开「开发者模式」 |
| **Edge** | `edge://extensions` | 左侧先打开「开发人员模式」 |
| **Brave** | `brave://extensions` | 同 Chrome |
| **Vivaldi** | `vivaldi://extensions` | 同 Chrome |
| **Opera** | `opera://extensions` | 需先开启「开发者模式」 |
| **360 / QQ / 搜狗 等国产浏览器** | 通常也是 `chrome://extensions` | 部分版本要先在设置里打开「开发者选项」；需切到「极速模式」 |
| **Firefox** | — | **不支持**：本扩展用的是 Chrome 的 MV3 写法（service worker 后台 + declarativeNetRequest），Firefox 的 manifest 结构不同，无法直接加载 |

**通用四步**（Chrome 为例）：

1. 地址栏输入 `chrome://extensions` 回车
2. 打开页面右上角的「开发者模式」
3. 点「加载已解压的扩展程序」，**选中本文件夹**（选文件夹，不是选单个文件）
4. 打开任意 B 站视频页，右下角出现下载面板即安装成功

**三个注意点**：

- 选的是**文件夹**，不是 `.zip` 压缩包 —— Chrome 不接受 zip，必须先解压
- 加载后**不要移动或删除**这个文件夹，否则扩展会失效（必要时重新加载一次即可）
- 改了代码后：回到扩展管理页点该扩展卡片上的「重新加载」，再刷新 B 站页面

### 可选：原生 FFmpeg（合并更好）

装了之后合并走本机 FFmpeg，输出带 faststart、可边下边播；不装也能用（走浏览器内重封装）。

```bat
cd native-host
build-host.cmd     :: 编译宿主（Windows 自带 csc，无需装 SDK）
install.cmd        :: 注册宿主 + 按需下载 FFmpeg
```

详细步骤与排错见 [`native-host/INSTRUCTION.txt`](native-host/INSTRUCTION.txt)。

## 使用

1. 打开视频页，等右下角档位列表自动填好（约 2 秒；没读到就点「↻ 读取可选档位」）
2. （可选）在画质 / 音质下拉里选档位，不选就按「最高（自动）」
3. （可选）在**音频格式**下拉里选 `m4a` 或 `mp3`；选 mp3 会在音频下完后自动转码
4. 点「🎬🎵 视频+音频」，等它下载、合并、弹窗告诉你文件在哪
5. 中途可随时暂停或取消

完整说明（面板图解、档位对照表、常见问题、权限说明）见 **[`INSTRUCTION.txt`](INSTRUCTION.txt)**。

## 三条下载通道

合并下载按顺序自动尝试，前一个失败才换下一个：

| 通道 | 说明 |
|---|---|
| A. 原生宿主 + FFmpeg | 需要装 `native-host`。输出带 faststart，可边下边播 |
| B. 浏览器内重封装 | 纯 JS 搬运 MP4 盒子，毫秒级，无转码，不装任何东西 |
| C. 兜底 | 分别下载视频与音频，并给出 FFmpeg 命令让你自己合 |

## 目录结构

```
manifest.json      扩展清单
content.js         页面脚本：面板 UI + 解析 + 下载与合并流程
background.js      后台 Service Worker：兜底下载通道（改写请求头 + 分块回传）
quality.js         画质 / 音质选择逻辑（档位排序、编码识别）
wbi.js             B 站 WBI 签名
muxer.js           分片 MP4（fMP4）双轨重封装
vendor/            第三方库：lamejs（mp3 编码，LGPL-3.0）+ 其许可证与来源说明
INSTRUCTION.txt    完整使用说明书
LICENSE            GPL-3.0 许可全文
native-host/       可选：原生 FFmpeg 合并宿主（含单独说明）
tests/             Node 测试脚本（选流逻辑 / WBI 签名 / 重封装）
```

## 常见问题

**画质只有 480P？** 未登录。B 站对未登录账号最高只给 480P；登录后 1080P，大会员才有 4K / 8K / HDR。

**检测不到 Hi-Res 无损音质？** 不是插件问题。**已实测确认：Hi-Res 属于 APP 端功能，网页接口不下发该音轨** —— 换参数、甚至照抄网页播放器自己发的那条请求，拿到的 `flac.audio` 都是 `null`（`flac.display` 才是 `true`）。网页端能拿到的最高音质是杜比全景声或 192K AAC。

**下载出来 0 字节？** CDN 防盗链。扩展会自动改用后台通道重试，并换备用 CDN 地址。

**合并出的 MP4 播放器打不开？** 多半是选了 AV1 / HEVC 而播放器不支持。在同一位置改选 H.264 重下即可（Windows 自带播放器支持有限，推荐 VLC / mpv / PotPlayer）。

更多问题见 [`INSTRUCTION.txt`](INSTRUCTION.txt) 第八节。

## 日志与排错

- **页面控制台**（F12）：所有日志以 `[bili-dl]` 开头，含账号状态、接口返回的完整档位清单、每个通道的结果
- **原生宿主日志**：`%TEMP%\bilidl_host.log`

## 已知限制

- 只匹配 `https://www.bilibili.com/video/*`，不支持番剧 / 直播 / 付费课程
- 不做批量下载、不做收藏夹 / 播放列表
- 高画质与杜比音轨需要对应账号权限（登录 / 大会员），这是 B 站的限制
- mp3 是**本地转码**（Web Audio 解码 + lamejs 编码），依赖浏览器的 AAC 解码器。
  长音频转码需要几秒到几十秒并占用一定内存；只想要原声或追求速度，就保持 `m4a`

## 许可

本项目采用 **GNU General Public License v3.0**，全文见 [`LICENSE`](LICENSE)。

你可以自由使用、修改、分发，但**衍生作品必须同样以 GPL-3.0 开源**。

### 第三方组件

- **[lamejs](https://github.com/shijinyu/lamejs)**（`vendor/lamejs.iife.js`）—— mp3 编码器，
  版本 `@breezystack/lamejs` 1.2.7，以 **LGPL-3.0** 发布；许可证全文见
  [`vendor/lamejs-LICENSE.txt`](vendor/lamejs-LICENSE.txt)。仅在音频格式选 mp3 时用到，
  该文件是官方构建产物，未做任何修改

## 参考

WBI 签名方案与画质 / 音质档位编号的对照关系，参考了社区文档
[bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)。

---

# English

## What it is

A download panel for Bilibili video pages. It lists the **quality and audio tiers the API actually returns** for the current video — including every codec available at each tier — so you pick what you want:

```
Quality  [1080P · H.264 · 1.9M]  [1080P · HEVC · 1.4M]  [1080P · AV1 · 1.1M]  ...
Audio    [192K · AAC]  [Dolby Atmos · EC-3 · 1025kbps]  ...
```

Unlike "sniff the highest quality" tools it does not guess: whatever the API hands back is what you see.

## Features

- **Tier menu** — one entry per "tier + codec"; pick H.264 for compatibility or HEVC / AV1 to save bandwidth
- **Three download modes** — audio only (`.m4a` / `.mp3`), video only (`.mp4`), or video + audio merged into a single MP4
- **Selectable audio format** — audio-only downloads can be `m4a` (saved as-is, fastest) or `mp3`
  (192kbps). **A local FFmpeg is used automatically when present** (much faster, no page memory);
  otherwise it transcodes in the browser with a built-in encoder: **nothing to install, no network**
- **Lossless merge** — moves MP4 boxes and rewrites a 4-byte track_ID; **no re-encoding**, nothing is lost
- **Pause / resume / cancel** — supported across all three download channels, and cancelling never retries
- **Multi-part support** — detects the part you are watching and refreshes the tier list when you switch
- **Three fallback channels** — direct page fetch → background Service Worker → split downloads, with automatic backup-CDN retries
- **Zero dependencies, no build step** — plain modern JavaScript; edit and reload the extension

## Install

This is a Chromium extension (Manifest V3), so every Chromium-based browser installs it the same way: **Load unpacked**.

> Using the ZIP from Releases? **Unzip it first**, then select the unzipped folder.

### Loading it in each browser

| Browser | Extensions page | Notes |
|---|---|---|
| **Chrome** | `chrome://extensions` | Turn on **Developer mode** (top-right) |
| **Edge** | `edge://extensions` | Turn on **Developer mode** (left rail) |
| **Brave** | `brave://extensions` | Same as Chrome |
| **Vivaldi** | `vivaldi://extensions` | Same as Chrome |
| **Opera** | `opera://extensions` | Enable **Developer mode** first |
| **360 / QQ / Sogou (Chinese Chromium builds)** | usually `chrome://extensions` | Some versions need "Developer options" enabled in settings; must be in "Speed/Blink mode" |
| **Firefox** | — | **Not supported**: this extension uses Chrome's MV3 model (service-worker background + declarativeNetRequest); Firefox's manifest differs, so it cannot be loaded as-is |

**Four steps** (Chrome shown):

1. Type `chrome://extensions` in the address bar
2. Turn on **Developer mode** in the top-right corner
3. Click **Load unpacked** and **select this folder** (the folder, not a single file)
4. Open any Bilibili video page — the panel appearing bottom-right means it worked

**Three things to watch out for:**

- Select the **folder**, not the `.zip` — Chrome cannot load a zip, so unzip first
- Do not move or delete the folder afterwards, or the extension stops working (just load it again if you must)
- After editing code: click **Reload** on the extension card, then refresh the Bilibili page

### Optional: native FFmpeg

With it, merging runs through your local FFmpeg, so the output is faststart-enabled (seekable while downloading). Without it everything still works via the in-browser remux.

```bat
cd native-host
build-host.cmd     :: build the host (uses the csc bundled with Windows; no SDK needed)
install.cmd        :: register the host, download FFmpeg on demand
```

See [`native-host/INSTRUCTION.txt`](native-host/INSTRUCTION.txt) for details and troubleshooting.

## Usage

1. Open a video page and wait ~2s for the tier list (click **↻** if it does not show up)
2. Optionally pick a quality / audio tier — the default is "best (auto)"
3. Optionally pick an **audio format** (`m4a` or `mp3`); with mp3 the file is transcoded after downloading
4. Click **video + audio** and wait for the merge; a dialog shows where the file went
5. Pause or cancel at any time

The full manual (panel diagram, tier reference table, FAQ, permissions) lives in **[`INSTRUCTION.txt`](INSTRUCTION.txt)**.

## Download channels

Merged downloads try these in order:

| Channel | Notes |
|---|---|
| A. Native host + FFmpeg | Requires `native-host`. Produces a faststart MP4 |
| B. In-browser remux | Pure JS box-shuffling, milliseconds, no re-encode, nothing to install |
| C. Last resort | Downloads video and audio separately, then hands you an FFmpeg command |

## Layout

```
manifest.json      Extension manifest
content.js         Page script: panel UI, parsing, download & merge flow
background.js      Background Service Worker: fallback channel (header rewriting + chunk relay)
quality.js         Tier selection logic (ordering, codec detection)
wbi.js             Bilibili WBI signature
muxer.js           Fragmented-MP4 (fMP4) two-track remux
vendor/            Third-party: lamejs (mp3 encoder, LGPL-3.0) plus its licence and provenance notes
INSTRUCTION.txt    Full manual
LICENSE            Full text of the GPL-3.0
native-host/       Optional native FFmpeg host (own manual inside)
tests/             Node test scripts (tier logic / WBI / remux)
```

## FAQ

**Only 480P?** You are not logged in. Bilibili caps anonymous accounts at 480P; logged in you get 1080P, and 4K / 8K / HDR require a premium membership.

**No Hi-Res lossless audio?** Not an extension bug. **Measured: Hi-Res is an app-only feature — the web API never serves that track.** Changing parameters, or even replaying the web player's own request verbatim, still returns `flac.audio = null` (while `flac.display` is `true`). The best the web gives you is Dolby Atmos or 192K AAC.

**Zero bytes downloaded?** CDN hotlink protection. The extension automatically retries through the background channel and switches to a backup CDN.

**The merged MP4 will not play?** You probably picked AV1 / HEVC and your player does not support it. Re-download the same tier with H.264 (Windows' built-in player is limited; VLC / mpv / PotPlayer work fine).

More in section 8 of [`INSTRUCTION.txt`](INSTRUCTION.txt).

## Logs

- **Page console** (F12): every line is prefixed `[bili-dl]` — account state, the full tier list from the API, per-channel results
- **Native host log**: `%TEMP%\bilidl_host.log`

## Known limitations

- Only matches `https://www.bilibili.com/video/*`; no bangumi, live streams or paid courses
- No batch / playlist / favourites downloading
- High tiers and Dolby audio depend on your account entitlement (login / premium) — that is Bilibili's rule, not ours
- mp3 is **transcoded locally** (Web Audio decode + lamejs encode) and relies on the browser's AAC
  decoder. Long tracks take seconds to tens of seconds and hold some memory; keep `m4a` if you
  want the untouched original or maximum speed

## License

Released under the **GNU General Public License v3.0** — see [`LICENSE`](LICENSE) for the full text.

You are free to use, modify and redistribute it, but **derivative projects must also be released under GPL-3.0**.

### Third-party components

- **[lamejs](https://github.com/shijinyu/lamejs)** (`vendor/lamejs.iife.js`) — the mp3 encoder,
  version `@breezystack/lamejs` 1.2.7, released under **LGPL-3.0**; full licence text in
  [`vendor/lamejs-LICENSE.txt`](vendor/lamejs-LICENSE.txt). Used only when the audio format is
  set to mp3. The file is the untouched official build

## References

The WBI signature scheme and the quality / audio tier-id reference came from the community docs
[bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect).
