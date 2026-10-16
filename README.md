# B站视频/音频下载器 · Bilibili Video & Audio Downloader

> 本仓库同时包含两个版本：**Chrome / Edge 版**（[`chrome/`](chrome/)）与**火狐版**（[`firefox/`](firefox/)）。
>
> This repository hosts two editions: the **Chrome / Edge edition** ([`chrome/`](chrome/)) and the **Firefox edition** ([`firefox/`](firefox/)).

**两个版本是兄弟项目**（不是新旧版本）：功能对齐、各自适配、共同维护，**共用同一个版本号、同步发布**；两版代码彼此独立（各自完整），不共享代码文件。

**The two editions are siblings** (not generations): aligned features, adapted per browser and maintained side by side, **sharing one version number and released together**; their codebases stay independent and complete on their own.

---

## 目录结构 · Layout

| 目录 | 版本 | 快速入口 |
|---|---|---|
| [`chrome/`](chrome/) | Chrome / Edge / Opera / Brave / Vivaldi 等 Chromium 系浏览器 | [README](chrome/README.md) · [完整说明书](chrome/INSTRUCTION.txt) |
| [`firefox/`](firefox/) | Firefox 140+（火狐；发布带 Mozilla 签名 xpi） | [README](firefox/README.md) · [完整说明书](firefox/INSTRUCTION.txt) |

## 下载与安装 · Download & Install

到本仓库的 [Releases](https://github.com/fishyucy/Bilibili-Video-Downloader-Browser-Extension/releases) 下载（两个版本同版本号发布）：

- **Chrome / Edge 版**：`Bilibili-Video-Downloader-Browser-Extension-vX.Y.Z.zip`
  → 解压后到 `chrome://extensions`，用「加载已解压的扩展程序」选中解压出来的文件夹
- **火狐版**：`Bilibili-Video-Downloader-Firefox-vX.Y.Z.xpi`（已由 Mozilla 签名）
  → `about:addons` → 齿轮 ⚙ →「从文件安装附加组件…」；或 `about:debugging` 临时载入
- **可选：原生 FFmpeg 宿主**（Windows，合并 / 转码加速）：
  `bili-dl-native-host-vX.Y.Z.zip`（Chrome 版） · `bili-dl-native-host-firefox-vX.Y.Z.zip`（火狐版）

详细用法见各版本目录内的 README 与 INSTRUCTION 说明书。

- **Chrome / Edge edition**: `Bilibili-Video-Downloader-Browser-Extension-vX.Y.Z.zip` → unzip, then
  "Load unpacked" on `chrome://extensions`
- **Firefox edition**: `Bilibili-Video-Downloader-Firefox-vX.Y.Z.xpi` (Mozilla-signed) → `about:addons`
  → gear ⚙ → "Install Add-on From File…", or load temporarily from `about:debugging`
- **Optional native FFmpeg host** (Windows): `bili-dl-native-host-vX.Y.Z.zip` (Chrome edition) ·
  `bili-dl-native-host-firefox-vX.Y.Z.zip` (Firefox edition)

## 版本策略 · Versioning

两个版本**共用同一个版本号**：改动其中任意一个（或同时改动两个）时，都以同一个版本号一起发布 ——
例如 `v1.22.3` 这一次发布同时包含两版的安装包。历史记录见 Releases。

The two editions **share a single version number**: whenever either edition (or both) changes, they are
released together under that version -- e.g. `v1.22.3` ships both editions' packages in one release.

## 许可 · License

**GNU General Public License v3.0** —— 全文见 [LICENSE](LICENSE)（两版许可证相同，各自目录内另附一份）。

**GNU General Public License v3.0** -- see [LICENSE](LICENSE) for the full text (identical for both
editions; each edition folder also carries its own copy).

## 参考 · References

WBI 签名方案与画质 / 音质档位编号参考社区文档
[bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)。

The WBI signature scheme and the tier-id reference come from the community docs
[bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect).
