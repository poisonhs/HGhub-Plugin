# HGhub-Plugin

HGhub 插件集（HPP 1.0，单文件数据源）。

HGhub 客户端下载：<https://github.com/Minireel/HGhub/releases>

| 插件 | 能力 | 备注 |
| --- | --- | --- |
| `bfzy.source` 暴风资源 | 首页 / 分类 / 搜索 / 详情 / 播放 | |
| `tangxin.vlog` 糖心Vlog | 首页 / 演员·标签 / 搜索 / 详情 / 播放 | 成人内容，需在设置里开启 |
| `av321.source` 321AV | 首页 / 分类 / 搜索 / 详情 / 播放 | 成人内容，需在设置里开启 |
| `hanime16.source` H動漫 hanime16 | 首页 / 分类 / 搜索 / 详情 / 播放 | 成人内容，需在设置里开启 |
| `juzong.source` 剧踪影院 | 首页 / 分类 / 搜索 / 详情 / 播放 | |
| `hlws.source` 51黑料 | 首页 / 分类 / 搜索 / 详情 / 播放 | 成人内容，需在设置里开启 |
| `chengguo.source` 橙果短剧 | 首页 / 频道 / 搜索 / 详情 / 播放 | 成人内容，需在设置里开启 |
| `jisu.source` 极速追剧 | 首页 / 分类 / 搜索 / 详情 / 播放 | |
| `kxyy.source` 开心影院 | 首页 / 分类 / 搜索 / 详情 / 播放 | 需要关闭🛩️ |
| `dhvideo.source` 豆花电影网 | 首页 / 分类 / 搜索 / 详情 / 播放 | 首集可能要等 3 MB 播放页，之后走缓存 |
| `auete.source` Auete影视 | 首页 / 分类 / 详情 / 播放 | 站内搜索需图形验证码，未提供搜索 |
| `netflixgc.source` 奈飞工厂 | 首页 / 分类 / 搜索 / 详情 / 播放 | |
| `cg91.source` 91吃瓜 | 首页 / 分类 / 搜索 / 详情 / 播放 | 成人内容，需在设置里开启 |
| `av591.source` 591AV | 首页 / 分类 / 搜索 / 详情 / 播放 | 成人内容，需在设置里开启 |
| `huangguo.source` 黄果短剧 | 首页 / 分类 / 榜单 / 搜索 / 详情 / 播放 / 图文 | 成人内容，需在设置里开启 |
| `dbku.source` 独播库 | 首页 / 分类 / 筛选 / 搜索 / 详情 / 播放 | |
| `yingxi.source` 影夕视频 | 首页 / 分类 / 筛选 / 搜索 / 详情 / 播放 | |
| `hhkan.source` 好好看 | 首页 / 分类 / 搜索 / 详情 / 播放 | |
| `pianku.source` 片库 | 首页 / 分类 / 搜索 / 详情 / 播放 | |
| `dpw.source` 66大片网 | 首页 / 分类 / 详情 / 播放 | 需要关闭🛩️ |
| `heiliao.source` 黑料网 | 首页 / 分类 / 搜索 / 详情 / 播放 | 成人内容，需在设置里开启 |
| `hl365.source` 黑料不打烊 | 首页 / 分类 / 搜索 / 详情 / 播放 | 成人内容，需在设置里开启 |

```
manifest/manifest.json      插件列表，订阅入口
plugins/bfzy.source.js      单文件插件
plugins/tangxin.vlog.js     单文件插件
plugins/av321.source.js     单文件插件
plugins/hanime16.source.js  单文件插件
plugins/juzong.source.js    单文件插件
plugins/hlws.source.js      单文件插件
plugins/chengguo.source.js  单文件插件
plugins/jisu.source.js      单文件插件
plugins/kxyy.source.js      单文件插件
plugins/dhvideo.source.js   单文件插件
plugins/auete.source.js     单文件插件
plugins/netflixgc.source.js 单文件插件
plugins/cg91.source.js      单文件插件
plugins/av591.source.js     单文件插件
plugins/huangguo.source.js  单文件插件
plugins/dbku.source.js     单文件插件
plugins/yingxi.source.js   单文件插件
plugins/hhkan.source.js   单文件插件
plugins/pianku.source.js  单文件插件
plugins/dpw.source.js     单文件插件
plugins/heiliao.source.js 单文件插件
plugins/hl365.source.js   单文件插件
```

## 订阅

在 HGhub 里导入下面这个地址即可，它是一份插件列表：

```
https://raw.githubusercontent.com/poisonhs/HGhub-Plugin/main/manifest/manifest.json
```

1. 打开 HGhub，进入 **插件中心 → 导入与订阅**（手机端从「我的」进插件中心）。
2. 选择「网址 / 订阅」，粘贴上面的地址，确认。
3. 列表里出现 **插件**，勾选导入；状态变成「已就绪」后返回首页。

回到搜索框输入，能出结果、能点进详情选集、能播放，就通了。

导入后这个地址会存成一条订阅，以后在订阅页点「检查更新」即可拉取新版本，不用重新粘贴。

## 说明

- 不需要账号，不读写片库以外的数据，插件只在被调用时运行。
- `tangxin.vlog`、`av321.source`、`av591.source`、`cg91.source`、`hanime16.source`、`heiliao.source`、`hl365.source`、`hlws.source`、`huangguo.source` 与 `chengguo.source` 声明了 `meta.mature`，宿主默认隐藏，需在设置里允许成人内容后才会出现。
- 数据与播放地址来自上游采集接口，站点换域名或改接口会导致插件失效；换地址时改 `plugins/bfzy.source.js` 顶部的 `API` 常量。
- 流地址有时效，播放中途失效时宿主会带 `reason: "refresh"` 重新调用插件解析。
