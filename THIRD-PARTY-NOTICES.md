# 第三方组件与许可

**洋流日语自己的源码使用 MIT，见 [LICENSE](LICENSE)。**

插件的运行产物（`main.js`）里打包了下面这些第三方组件，它们的许可与署名要求在此一并满足。

| 组件 | 许可 | 用在哪 |
| --- | --- | --- |
| [kuromoji](https://github.com/takuyaa/kuromoji.js) | Apache-2.0 | 日语分词（拆词、查读音） |
| mecab-ipadic 2.7.0-20070801（随 kuromoji 分发的词典数据，按需下载） | 见下节，须保留声明 | 分词词典 |
| [node-qrcode](https://github.com/soldair/node-qrcode) | MIT | 登录二维码 |
| [webm-muxer](https://github.com/Vanilagy/webm-muxer) | MIT | 跟读录音导出 |

## kuromoji — Apache License 2.0

Copyright 2014 Takuya Asano（kuromoji.js 项目）

许可全文随本仓库附在 [`licenses/kuromoji-Apache-2.0.txt`](licenses/kuromoji-Apache-2.0.txt)，
官方文本见 <https://www.apache.org/licenses/LICENSE-2.0>。

## mecab-ipadic — 词典数据

词典文件（`dict/`，以及按需下载的那份）来自 **mecab-ipadic 2.7.0-20070801**：

- Copyright 2000, 2001, 2002, 2003 Nara Institute of Science and Technology. All Rights Reserved.
- 其中大量词条源自 ICOT Free Software。

该许可要求：任何形式的拷贝都必须同时保留上述版权声明与下列免责段落。完整原文随本仓库附在
[`licenses/kuromoji-NOTICE-ipadic.md`](licenses/kuromoji-NOTICE-ipadic.md)，要点如下：

> Use, reproduction, and distribution of this software is permitted. Any copy of this software,
> whether in its original form or modified, must include both the above copyright notice and the
> following paragraphs.
>
> Nara Institute of Science and Technology (NAIST), the copyright holders, disclaims all warranties
> with regard to this software, including all implied warranties of merchantability and fitness, in
> no event shall NAIST be liable for any special, indirect or consequential damages or any damages
> whatsoever resulting from loss of use, data or profits, whether in an action of contract,
> negligence or other tortuous action, arising out of or in connection with the use or performance
> of this software.
>
> A large portion of the dictionary entries originate from ICOT Free Software. … Each User may also
> freely distribute the Program, whether in its original form or modified, to any third party or
> parties, PROVIDED that the provisions of Section 3 ("NO WARRANTY") will ALWAYS appear on, or be
> attached to, the Program …

## node-qrcode — MIT

The MIT License (MIT) · Copyright (c) 2012 Ryan Day

## webm-muxer — MIT

MIT License · Copyright (c) 2022 Vanilagy
