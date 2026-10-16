# B站视频/音频下载器（Firefox 版）· Bilibili Video & Audio Downloader

> Firefox 扩展（Manifest V3）· 在视频页提供下载面板，可选任意画质与音质档位，音视频自动合并为单个 MP4。
>
> A Firefox extension (Manifest V3). Adds a download panel to Bilibili video pages: pick any quality and audio tier, and get a single merged MP4.
>
> **本目录是仓库里的火狐版（兄弟项目之一）；与 [Chrome / Edge 版](../chrome/) 功能对齐、各自适配、共同维护、共用同一个版本号，不互为新旧版本。**
>
> **中文在前，English below.** · [跳到 English](#english)
>
> 作者 / Author: **fish**

---

# 中文

## 这是什么

在 B 站视频页右下角注入一个下载面板：把这个视频**真实可用的画质与音质档位**列出来，由你自己挑，然后下载、自动合并成单个 MP4。

（本目录是仓库里的**火狐版**：功能与 [Chrome / Edge 版](../chrome/) 完全对齐，
代码同源、平台差异单独适配；两版独立演进、共同维护、**共用同一个版本号**。）

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

这是 **Firefox 版**（Manifest V3，要求 **Firefox 140 及以上**，即 2025 年后的版本；
当前 ESR / 正式版均满足）。Chrome / Edge 用户请用本仓库的
[Chrome / Edge 版](../chrome/)。

从本仓库的 **Releases** 下载 `Bilibili-Video-Downloader-Firefox-vX.Y.Z.xpi`
（发布版已通过 addons.mozilla.org 的 **unlisted / 自主分发签名**），两种装法任选：

### 方式一：直接安装（推荐，重启浏览器后仍保留）

1. 打开 `about:addons`（或菜单 →「扩展和主题」）
2. 点右上角的**齿轮 ⚙** →「**从文件安装附加组件…**」
3. 选中刚下载的 `.xpi`

也可以直接把 `.xpi` 拖进 Firefox 窗口完成安装。因为已带 Mozilla 签名，正式版 Firefox 可直接安装。

### 方式二：临时载入（开发 / 调试，重启浏览器后失效）

1. 地址栏输入 `about:debugging#/runtime/this-firefox` 回车
2. 点「临时载入附加组件…」，选中 **`.xpi` 文件**（或本文件夹里的 `manifest.json`）
3. 打开任意 B 站视频页，右下角出现下载面板即安装成功

> 临时载入的扩展在**浏览器重启后失效**，重启后重新载入一次即可；改代码后在这里点「重新载入」。

### 自己构建 / 自己签名（开发者）

- 源码临时载入：选本文件夹里的 `manifest.json` 即可
- 生成签名的 xpi：装好 Node 后运行

  ```bat
  npx web-ext sign --source-dir . --channel unlisted --api-key <AMO Key> --api-secret <AMO Secret>
  ```

  API 密钥在 [addons.mozilla.org](https://addons.mozilla.org/developers/) 开发者中心生成（免费）。
  在**仓库根目录**执行；仓库自带 `.web-ext-config.mjs`，会自动排除宿主二进制
  （`native-host\bin\`）、宿主源码与测试样本 —— 保证打出的 xpi 只含扩展本体
  （即使在本地跑过宿主编译/安装也一样）。
- 未签名的 `.xpi` 只能在 **Developer Edition / Nightly** 里永久安装
  （`about:config` 把 `xpinstall.signatures.required` 设为 `false`；正式版会忽略这个开关）

**两个注意点**：

- 用「临时载入 + 源码」方式开发时，**不要移动或删除**这个文件夹，否则扩展会失效（必要时重新载入即可）
- 改了代码后：回到 `about:debugging` 点该扩展的「重新载入」，再刷新 B 站页面

### 可选：原生 FFmpeg（合并 / 转码加速）

装了之后合并走本机 FFmpeg（输出带 faststart、可边下边播），mp3 转码也快得多；
不装也能用（走浏览器内重封装 / 内置编码器）。

宿主是**独立的一次性安装**，和「装扩展」是两件事 —— 扩展包里不含它（Chrome 版也一样）：

1. 到本仓库 **Releases** 下载 `bili-dl-native-host-firefox-vX.Y.Z.zip`（宿主源码包），
   解压到一个**固定文件夹**（别放桌面随手清理的位置）
2. 在解压出来的 `native-host` 里依次运行：

```bat
build-host.cmd     :: 编译出 host.exe 与 find-ffmpeg.exe（Windows 自带 csc，无需装 SDK）
install.cmd        :: 注册宿主（Mozilla 键）+ 找 FFmpeg
```

`install.cmd` 找不到 FFmpeg 时会问你要 [D] 下载一份（约 90MB）还是 [F] **在本机找**（推荐）；
选 F 后它会**自动调用 `find-ffmpeg.exe`** 搜索本机现成可用的 FFmpeg 并复制进 `bin\` ——
**你不需要手动运行它**（也没有 `find-ffmpeg.cmd` 这种文件；只有编译出来的 `find-ffmpeg.exe`，
愿意的话可以单独双击使用）。

装好后怎么确认：合并时按钮显示「**FFmpeg 合并中…**」= 走原生宿主（显示「合并中…」= 浏览器内重封装）。
注意：宿主注册表指向解压出来的这个文件夹，**别移动 / 删除**；要换位置，重跑一次 `install.cmd` 即可。

Firefox 版注册的是 **Mozilla 键**（`HKCU\Software\Mozilla\NativeMessagingHosts`），
与 Chrome 版的注册互不影响 —— 两个版本可以并存，各注册各的。

**它是怎么工作的（几点补充）**：

| 点 | 说明 |
|---|---|
| **判断方式** | 不是扩展自己读注册表 —— 扩展只是调用 `connectNative` 向浏览器「要」宿主；真正读注册表、启动宿主的是**浏览器**，扩展以「能不能 ping 通」来判断宿主是否可用 |
| **注册一次即可** | 注册后长期有效；但注册表和清单里写的是**绝对路径**，宿主文件夹一旦移动 / 改名就断了链：移回去，或在新位置重跑一次 `install.cmd` |
| **装好后马上能用** | 探测只缓存成功结果、失败不缓存 —— 装好宿主后**不用刷新页面**，下一次点下载就会重新探测并直接用上 |
| **两版互不干扰** | Firefox 读 Mozilla 键，Chrome / Edge 读各自厂商键；每份清单只允许自己版本的那个扩展 ID，并存毫无冲突 |
| **为什么必须单独装** | 浏览器不允许扩展自己运行 exe / 读写磁盘 —— Native Messaging 是唯一的「扩展 → 本地程序」通道，这就是宿主存在的全部原因 |

详细步骤与排错见宿主包内的 `native-host/INSTRUCTION.txt`。

## 使用

1. 打开视频页，等右下角档位列表自动填好（约 2 秒；没读到就点「↻ 读取可选档位」）
2. （可选）在画质 / 音质下拉里选档位，不选就按「最高（自动）」
3. （可选）在**音频格式**下拉里选 `m4a` 或 `mp3`；选 mp3 会在音频下完后自动转码
4. 点「🎬🎵 视频+音频」，等它下载、合并，右下角浮层告诉你文件在哪（点一下可关）
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

> **This folder is the Firefox edition of this repository.** Its sibling is the
> [Chrome / Edge edition](../chrome/): same feature set, adapted per browser, maintained side by
> side under one shared version number -- neither is an old/new generation of the other.

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

This is the **Firefox edition** (Manifest V3, requires **Firefox 140 or newer** -- i.e. any
2025-or-later build; current ESR and release both qualify). Chrome / Edge users want this
repository's sibling [Chrome / Edge edition](../chrome/).

Grab `Bilibili-Video-Downloader-Firefox-vX.Y.Z.xpi` from this repository's **Releases**
(the release build carries a Mozilla **unlisted / self-distribution signature**), then pick either way:

### Way 1: direct install (recommended; survives restarts)

1. Open `about:addons` (or menu → "Add-ons and themes")
2. Click the **gear ⚙** in the top-right → "**Install Add-on From File…**"
3. Select the downloaded `.xpi`

Dragging the `.xpi` onto a Firefox window works too. Because it carries a Mozilla signature,
release Firefox installs it directly.

### Way 2: temporary load (development / debugging; gone after a restart)

1. Type `about:debugging#/runtime/this-firefox` in the address bar
2. Click **Load Temporary Add-on…** and select the **`.xpi` file** (or the `manifest.json` in this folder)
3. Open any Bilibili video page — the panel appearing bottom-right means it worked

> A temporary add-on **disappears when the browser restarts**; just load it again. After editing
> code, click **Reload** there and refresh the Bilibili page.

### Building / signing it yourself (developers)

- Temporary-load the sources: pick this folder's `manifest.json`
- Produce a signed xpi (needs Node):

  ```bat
  npx web-ext sign --source-dir . --channel unlisted --api-key <AMO Key> --api-secret <AMO Secret>
  ```

  Generate API keys for free in the [addons.mozilla.org](https://addons.mozilla.org/developers/) developer hub.
  Run it from the **repository root**; the repo ships `.web-ext-config.mjs`, which excludes the host
  binaries (`native-host\bin\`), the host sources and the test samples -- so the xpi contains only
  the extension itself, even after you have built or installed the host locally.
- An unsigned `.xpi` can only be installed permanently in **Developer Edition / Nightly**
  (`about:config`: set `xpinstall.signatures.required` to `false`; release Firefox ignores it)

**Two things to watch out for:**

- When developing from sources with a temporary load, do not move or delete this folder afterwards,
  or the extension stops working
- After editing code: click **Reload** in `about:debugging`, then refresh the Bilibili page

### Optional: native FFmpeg (faster merging / transcoding)

With it, merging runs through your local FFmpeg (faststart output, seekable while downloading) and
mp3 transcoding gets much faster. Without it everything still works (in-browser remux / built-in encoder).

The host is a **separate one-time install** -- it is not inside the extension package (same is true
for the Chrome edition):

1. Download `bili-dl-native-host-firefox-vX.Y.Z.zip` (host sources) from this repository's **Releases**
   and unzip it to a **fixed folder** (not somewhere you will clean up)
2. Inside the extracted `native-host`, run in order:

```bat
build-host.cmd     :: builds host.exe and find-ffmpeg.exe (csc from Windows; no SDK needed)
install.cmd        :: registers the host (Mozilla key) and locates FFmpeg
```

When install.cmd cannot find FFmpeg it asks: [D] download one (~90MB) or [F] **search this machine**
(recommended); option F **runs find-ffmpeg.exe automatically** to locate a working FFmpeg and copy it
into `bin\` -- you never run it by hand (and there is no `find-ffmpeg.cmd`; only the compiled
`find-ffmpeg.exe`, which you may run standalone if you wish).

To confirm it works: the merge button shows "**FFmpeg merging…**" when the native host is used
("merging…" means the in-browser remux ran instead). The registry points at the extracted folder, so
**do not move or delete it**; to relocate, just run install.cmd again from the new place.

The Firefox edition registers the **Mozilla key** (`HKCU\Software\Mozilla\NativeMessagingHosts`),
which never collides with the Chrome edition's keys -- the two editions coexist, each registering
its own host.

**How it works (a few clarifications)**:

| Point | Explanation |
|---|---|
| **How it is detected** | The extension does not read the registry itself -- it calls `connectNative` to ask the browser for the host; the **browser** reads the registry and starts the host, and the extension treats "ping works" as "host available" |
| **Register once** | The registration lasts; but the registry and the manifest store **absolute paths**, so moving or renaming the host folder breaks the chain: move it back, or re-run `install.cmd` from the new location |
| **Works right after install** | The probe caches successes only, never failures -- after installing the host **no page reload is needed**; the next download click re-probes and uses it right away |
| **No collisions between editions** | Firefox reads the Mozilla key; Chrome / Edge read their own vendor keys, and each manifest whitelists only its own edition's extension ID |
| **Why a separate install** | Browsers do not let extensions run .exe files or write to disk -- Native Messaging is the only "extension -> local program" channel, which is the whole reason the host exists |

See the `native-host/INSTRUCTION.txt` inside the host package for details and troubleshooting.

## Usage

1. Open a video page and wait ~2s for the tier list (click **↻** if it does not show up)
2. Optionally pick a quality / audio tier — the default is "best (auto)"
3. Optionally pick an **audio format** (`m4a` or `mp3`); with mp3 the file is transcoded after downloading
4. Click **video + audio** and wait for the merge; a bottom-right notice shows where the file went
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
