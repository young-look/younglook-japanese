<div align="center">
  <h1>YoungLook Japanese · 洋流日语</h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/img/logo-dark.png">
    <img src="docs/img/logo.png" width="120" alt="YoungLook Japanese logo">
  </picture>
</div>

> Turn the Japanese videos and subtitles already on your computer into study material you can pause, query, and practice with.
>
> 把本机里的日语视频和字幕，变成可以拆开、查询、练习的日语学习素材。

Obsidian plugin · Windows / macOS / Linux · Obsidian 1.7.2+

![Study view](docs/img/0-study-view.png)

## What it does · 它能帮你做什么

The lines you could have learned from disappear in a second when you watch anime or dramas. YoungLook Japanese turns videos and subtitles **already on your computer** into your own study material:

- Pause on any line, listen and read as many times as you like
- Click any word to look up its meaning and reading; new words go straight into your vocabulary notebook
- Record yourself reading aloud and compare against the original audio
- Write a note on every sentence — sign in and they sync to your account, available on any device

Video and subtitle files **stay where they are**. The plugin only remembers their paths — no copying, no uploading.

---

看番学日语，最可惜的是台词一遍就过去了。洋流日语把你**已经在电脑里**的视频和字幕沉淀成你的学习素材：

- 停在任意一句，反复听、反复读
- 点词查义、查读音，生词自动收进生词本
- 跟读录音，回放对比原声
- 每一句都能随手写自己的笔记，登录后存在账号里，换设备也能看到

视频和字幕文件**原地不动**，插件只记路径 —— 不复制、不上传。

---

## Installation · 安装

### From the Community Plugins directory (recommended) · 从社区插件市场安装（推荐）

1. Open **Settings → Community plugins** in Obsidian.
2. If restricted mode is on, turn it off with **Turn off restricted mode** (some versions label it **Turn off safe mode**). No community plugin can be installed while it is on.
3. Select **Browse** next to *Community plugins*, search for **YoungLook Japanese**, then **Install** and **Enable**.
4. The sea-otter icon appears in the left sidebar — click it to open the study view.

> The plugin **never updates itself**. Updates come from Obsidian's Community plugins: check for updates there, or rely on BRAT if you installed it that way.

1. 在 Obsidian 设置里打开 **第三方插件**。
2. 新装的 Obsidian 默认开着受限模式：在该页右上角点一次 **「退出受限模式」**（有的版本显示为「退出安全模式」，或是一个开关，关掉即可）。不关的话装不了任何社区插件。
3. 点 **社区插件市场** 右边的 **「浏览」**，搜 **YoungLook Japanese** 或 **洋流日语**，安装并启用。
4. 左侧栏出现**海獭图标**，点它打开学习页。

> 插件**不会自行更新**：到 Obsidian 的「第三方插件」页里点检查更新即可（BRAT 安装的用 BRAT 拉新版）。

First dictionary lookup offers to download the Japanese tokenizer dictionary (~17 MB, one time, fully offline afterwards).

第一次查词时会提示下载日语分词词典（约 17MB，只下这一次，之后完全离线）。

![Open Community plugins](docs/img/3-open-market.png)

---

## Getting started · 装好之后做什么

1. Click the sea-otter icon in the left sidebar. The list contains one **sample item** — press *Start* and it offers to download the demo material (~4 MB, one time, offline afterwards).
2. Import your own material: **Import video** in the top-right → pick a video file and a subtitle file → give it a name. Done.
3. To look up a word, click it in the sentence. To hear a reading, click *Hint* (downloads the dictionary once, fully offline afterwards).
4. For AI analysis and pronunciation feedback: open **Personal center → Account**, choose the built-in model or fill in your own API key. Switch anytime.

1. 点左侧栏**海獭图标**打开学习页，列表里有一条**「示例」**，点「开始学」会先问要不要下载示例素材（约 4MB，只下这一次，下载后可离线学）。
2. 导入自己的素材：学习页右上角点 **「导入视频」** → 选视频文件和字幕文件 → 填个名字，搞定。
3. 想查词：点句子里的单词；想听读音：点「提示」（第一次会下载分词词典，之后完全离线）。
4. 想要 AI 解析和发音评估：点右上角**个人中心** → 账户页，选「内置模型」或填上你自己的 API Key，选谁用谁。

![Import video](docs/img/8-import-video.png)

---

## FAQ · 常见问题

**Does it require an account or payment? · 必须登录 / 付费吗？**
No. Local features (import, splitting, lookup, notes) work without signing in. AI features (analysis, imitation practice, read-aloud feedback, assistant Q&A) need a model: either **your own API key** (free — requests go straight to your provider, not through us) or the built-in model (pay per use from a small balance). You can switch anytime.

不。不登录也能用本地功能。AI 功能才需要模型：可以用**自带 API Key**（请求直连你的供应商，不经过我们），也可以用内置模型（按量扣余额），可随时切换。

**Are my videos and subtitles uploaded? · 我的视频和字幕会被上传吗？**
No. They stay where they are; the plugin only remembers their paths.

不会。视频和字幕留在原处，插件只记路径，内容不上传。

**Why desktop only? · 为什么只有桌面端？**
The plugin reads video files on your computer; Obsidian mobile cannot do that.

插件要读你电脑上的视频文件，Obsidian 移动端做不到。

**What is the dictionary? · 词典是什么？**
A Japanese tokenizer dictionary (~17 MB), downloaded once on your first lookup, fully offline afterwards.

日语分词用的词典（约 17MB），第一次查词时自动下载，之后完全离线。

---

## Network & data · 联网与数据

The plugin **does not collect usage analytics**: no third-party trackers, no ads, no telemetry SDKs. All network requests happen when you actively use a feature.

插件**不收集使用行为**：没有第三方统计、没有广告、没有埋点 SDK。所有网络请求都发生在你主动使用某个功能时。

**Servers it connects to · 会连接的服务器**

| Destination | When | Why |
| --- | --- | --- |
| YoungLook server (`younglook.cc`) | Signing in, syncing study records, using the **built-in model** for AI analysis / imitation / read-aloud / assistant, downloading the dictionary and demo material | These features run or store data on the server itself |
| Your own model provider | Only when you filled in your own API key (BYOK) and selected it | Requests go **directly** to your provider, not through us |
| Bangumi (`api.bgm.tv`) | Only when you press *Auto-detect* in the import dialog | Fetches the title, year and episode names so you don't type them. Fails silently — import is unaffected |
| GitHub | When you install or update the plugin through the Community plugins directory or BRAT | Pulled by Obsidian / BRAT themselves — **the plugin never downloads or replaces its own code** |

| 连到哪 | 什么时候 | 为了什么 |
| --- | --- | --- |
| 洋流服务器（`younglook.cc`） | 登录账号、同步学习记录、用**内置模型**做 AI 解析/仿写核对/跟读核对/助手问答、下载词典与示例素材 | 这些功能本身就在服务器上算或存 |
| 你自己的模型供应商 | 只在你自己填了 API Key（BYOK）并选了它时 | 请求**直连**你的供应商，不经过我们 |
| Bangumi（`api.bgm.tv`） | 只在你点导入弹窗里的「自动识别」时 | 拿作品名、年份、集标题，省得手填。查不到就静默跳过，不影响导入 |
| GitHub | 你通过社区插件市场 / BRAT 安装或更新时 | 由 Obsidian / BRAT 自己拉取，**插件不会自行下载或替换自己的代码** |

**Files it reads outside the vault · 会读取 vault 之外的文件**

This is the core of the plugin: it reads videos and subtitles wherever they live on your computer — **nothing needs to be moved into the vault**. Only two cases involve reading: the two files you pick at import time, and playback along the recorded path while studying. The plugin **only remembers paths** — no copying, no modifying, no uploading, and it never scans directories you did not point it at.

你的视频和字幕在电脑哪个目录，插件就读哪个目录 —— **不要求把它们搬进 vault**。只有两种情况会读：你导入时选中的那两个文件，以及学习时按记录的路径回放。插件**只记路径**，不复制、不改动、不上传，也不会去扫你没有指定的目录。

**What reaches the server · 会存到服务器上的东西**

Signed-in accounts only:

- Account: email or phone number, nickname, avatar
- Study records: titles and episode numbers, progress, vocabulary, your per-sentence notes
- AI usage: scene, token counts, cost — **never** the transcript itself

登录账号后才有：账号（邮箱或手机号、昵称、头像）、学习记录（作品名与集号、学习进度、生词、你自己写的句子笔记）、AI 用量（场景、token 数、费用，**不含**台词原文）。

**One record that exists without signing in · 不需要登录也会有的一条**

- Install records: when you **successfully install** the Japanese dictionary or the demo material, the plugin reports once "what was installed, resource version, plugin version". The request itself carries your source IP, which the server stores with the record — **only to deduplicate by IP and estimate how many installs happened** (several people behind one network count as one, so it is an approximation). It is not linked to accounts or study records and contains no file content. To have it deleted, email `info@younglook.cc`.

你把日语词典或示例素材**装成功**时，插件上报一次「装了什么、资源版本、插件版本」。这次请求本身还会带来源 IP，服务器会连同这条记录一起存下来，**只用来按 IP 去重、估算有多少人装上了这些资源**（同一个网络下的多个人会算成一个，所以是个约数）。它不关联账号、不关联学习记录，也不含任何文件内容。想删掉这一条，发信到 `info@younglook.cc` 说明即可。

**What is never uploaded · 不会上传的东西**

- Video and subtitle **files** (only local paths are kept)
- The server **never stores the transcript**

视频与字幕**文件**（插件只记本机路径）；服务端**不保存台词原文**。

**Deleting data · 删除数据**: signing out only disconnects the device. To delete your account and cloud data, email `info@younglook.cc` from your account address — handled within 7 business days. Full privacy policy: [younglook.cc/privacy](https://younglook.cc/privacy).

退出登录只会断开连接；要删除账号与云端数据，请用账号邮箱发信到 `info@younglook.cc`，7 个工作日内处理。完整隐私政策见 [younglook.cc/privacy](https://younglook.cc/privacy)。

---

## Building from source · 从源码构建

```bash
npm install
npm run build     # output = main.js (building on the master branch points at the production server)
```

Source lives in `src/`. The released `main.js` is not committed (it is a build artifact) and is distributed only via GitHub Releases — so reviewers can always rebuild the binary from the sources in this repository.

源码在 `src/`，发布用的 `main.js` 不进版本库（构建产物），只随 GitHub Release 分发 —— 审核者拿到的二进制永远能从仓库里的源码重新构建出来。

## License

MIT © young-look. The shipped bundle packages third-party components (kuromoji / mecab-ipadic dictionary / node-qrcode / webm-muxer); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

本项目源码使用 [MIT](LICENSE)。插件运行产物里打包的第三方组件的许可与署名见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

Project website: [younglook.cc](https://younglook.cc) · 项目官网：[younglook.cc](https://younglook.cc)
