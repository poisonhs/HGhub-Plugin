export const meta = {
  id: 'amj.source',
  name: '爱美剧',
  version: '1.0.0',
  protocol: 1,
  kind: 'source',
  description:
    '爱美剧（amj31.com）：苹果CMS 自建前端。六个频道分页、详情与多线路 HLS。播放页把片源写成两套：encrypt=4 的是密文，要 POST 到 /amj-play.php 换真实地址；encrypt=0 的直接就是明文 m3u8。站内搜索返回 404，未提供。',
  mature: false,
  linkDomains: ['amj31.com', 'aimeiju.org'],
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  timeouts: { read: 20, playback: 30 },
};

const BASE = 'https://amj31.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 站点在 Cloudflare 上缓存了一份 zstd 变体，而且不看 Accept-Encoding 就回它。
// 宿主的 reqwest 只带了 gzip / brotli，解不了 zstd，拿到的就是一坨二进制。
// 加一个查询参数能把请求变回 DYNAMIC 回源，那一步会按 Accept-Encoding 正常协商。
const CACHE_BUST = 'amjv=1';

const CATS = [
  { id: '1', label: '电影', type: 'movie' },
  { id: '2', label: '连续剧', type: 'series' },
  { id: '126', label: '短剧', type: 'short' },
  { id: '4', label: '动漫', type: 'anime' },
  { id: '3', label: '综艺', type: 'variety' },
  { id: '124', label: '福利', type: 'movie' },
];
const CAT_TYPE = new Map(CATS.map(c => [c.id, c.type]));

const DETAIL_RE = /^https?:\/\/(?:www\.)?(?:amj31\.com|aimeiju\.org)\/voddetail\/(\d+)\.html/i;
const HREF_DETAIL_RE = /\/voddetail\/(\d+)\.html/;
const HREF_PLAY_RE = /\/vodplay\/(\d+)-(\d+)-(\d+)\.html/;

const norm = s => (typeof s === 'string' ? s : '');
const trim = s => norm(s).replace(/\s+/g, ' ').trim();
const pageNo = cursor => {
  const n = Number(cursor);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function imageOf(raw) {
  const url = trim(raw).replace(/&amp;/g, '&');
  if (!url) return '';
  // 封面都套了一层百度图床的转发，src 参数里才是真地址；原样用也能出图。
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${BASE}${url}`;
  return /^https?:\/\//i.test(url) ? url : '';
}

export default function (hg) {
  // 统一给路径补上缓存绕行参数，已有查询串就接在后面。
  function withBust(path) {
    const url = /^https?:\/\//i.test(path) ? path : `${BASE}${path}`;
    return url.includes('?') ? `${url}&${CACHE_BUST}` : `${url}?${CACHE_BUST}`;
  }

  async function fetchText(path, ctx, ttl) {
    const res = await hg.http.fetch({
      url: withBust(path),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', Referer: `${BASE}/` },
      retry: 0,
      signal: ctx.signal,
      ...(ttl ? { cache: { ttlSec: ttl, staleIfErrorSec: 900 } } : {}),
    });
    if (res.status === 404) throw new hg.PluginError('NOT_FOUND', '内容不存在或已下架');
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}`);
    const body = norm(res.data);
    // 万一还是拿到 zstd（缓存恰好没绕开），别让它一路走到「结构变了」。
    if (body.length > 4 && body.charCodeAt(0) === 0x28 && body.charCodeAt(1) === 0xb5) {
      throw new hg.PluginError('UPSTREAM_ERROR', '站点返回了未解压的数据，换个时间再试');
    }
    return body;
  }

  async function fetchDoc(path, ctx, ttl) {
    return hg.html.parse(await fetchText(path, ctx, ttl));
  }

  function cardOf(node) {
    const links = node.select('a');
    let id = '';
    let title = '';
    for (const a of links) {
      const m = norm(a.attr('href')).match(HREF_DETAIL_RE);
      if (!m) continue;
      if (!id) id = m[1];
      const text = trim(a.text());
      if (text && !/播放|详情/.test(text)) {
        title = text;
        break;
      }
    }
    if (!id) return null;
    if (!title) {
      const img = node.first('img');
      title = trim(img && img.attr('alt')).replace(/海报$/, '');
    }
    if (!title) return null;
    const item = { id, title: title.slice(0, 200), type: 'movie' };
    const img = node.first('img');
    const cover = imageOf(img && img.attr('src'));
    if (cover && !/^data:/.test(cover)) item.cover = cover;
    const state = node.first('.film-state');
    const badge = trim(state && state.text());
    if (badge && badge.length <= 8) item.badge = badge;
    const meta = trim((node.first('p') && node.first('p').text()) || '');
    if (meta) {
      const year = (meta.match(/\b(19|20)\d{2}\b/) || [])[0];
      if (year) item.year = Number(year);
    }
    return item;
  }

  function cardsOf(root) {
    const out = [];
    const seen = new Set();
    for (const node of root.select('.film-card')) {
      const card = cardOf(node);
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      out.push(card);
    }
    if (out.length) return out;
    // 首页的轮播卡不是 film-card，退回按链接扫一遍。
    for (const node of root.select('article')) {
      const card = cardOf(node);
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      out.push(card);
    }
    return out;
  }

  // 线路标签只在播放页的 #amj-player-options 里，详情页看不到。
  function sourcesOf(html) {
    const m = html.match(/<script[^>]*id="amj-player-options"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return new Map();
    const cfg = safeJson(m[1].trim()) || {};
    const map = new Map();
    for (const row of cfg.sources || []) {
      const mm = norm(row && row.page).match(HREF_PLAY_RE);
      if (!mm) continue;
      const label = trim(row.label);
      if (label) map.set(mm[2], label);
    }
    return map;
  }

  function playerDataOf(html) {
    const m = html.match(/<script[^>]*id="amj-player-data"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    return safeJson(m[1].trim());
  }

  return {
    home: {
      async getSections(params, ctx) {
        const doc = await fetchDoc('/', ctx, 600);
        const items = cardsOf(doc).slice(0, 24);
        if (!items.length) throw new hg.PluginError('UPSTREAM_CHANGED', '首页结构已变化');
        return { items: [{ id: 'latest', title: '最新', layout: 'grid', items }], next: null };
      },
    },

    catalog: {
      async getCategories(params, ctx) {
        return CATS.map(c => ({ id: c.id, label: c.label }));
      },

      async list(params, ctx) {
        const id = trim(params && params.categoryId);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '分类 ID 不合法');
        const page = pageNo(params && params.cursor);
        // 苹果CMS 的筛选段是十个短横，第几页就把数字塞进倒数第三段。
        const path = `/vodshow/${id}--------${page}---.html`;
        const doc = await fetchDoc(path, ctx, 120);
        const items = cardsOf(doc);
        const t = CAT_TYPE.get(id) || 'movie';
        for (const item of items) item.type = t;
        const out = { items };
        if (items.length >= 12) out.next = String(page + 1);
        return out;
      },
    },

    // 站内搜索无论走 /vodsearch/ 哪种写法都回 404，所以不提供 search 能力。

    media: {
      async getDetail(params, ctx) {
        const id = trim(params && params.id);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const doc = await fetchDoc(`/voddetail/${id}.html`, ctx, 0);

        const h1 = doc.first('h1');
        let title = trim(h1 && h1.text());
        if (!title) {
          const t = doc.first('title');
          title = trim(t && t.text()).split(/\s*[-_|]\s*/)[0];
        }
        if (!title) throw new hg.PluginError('UPSTREAM_CHANGED', '详情结构已变化');

        const out = { id, title: title.slice(0, 200), type: 'movie', playlists: [] };
        const poster = doc.first('img.pk-detail-poster');
        const cover = imageOf(poster && poster.attr('src'));
        if (cover) out.cover = cover;

        const metaText = trim((doc.first('.pk-meta') && doc.first('.pk-meta').text()) || '');
        if (metaText) {
          const year = (metaText.match(/\b(19|20)\d{2}\b/) || [])[0];
          if (year) out.year = Number(year);
          // 这一行里塞了一长串关键词，单条 tag 上限 30 字符，短的挑出来用就够了
          const tags = [];
          for (const piece of metaText.split(/[·,，\/]/)) {
            const t = trim(piece);
            if (!t || t.length > 30) continue;
            if (tags.includes(t)) continue;
            tags.push(t);
            if (tags.length >= 6) break;
          }
          if (tags.length) out.tags = tags;
        }
        const summary = doc.first('.pk-detail-summary') || doc.first('.pk-summary');
        const overview = trim(summary && summary.text());
        if (overview) out.description = overview.slice(0, 5000);

        // 700 多个播放链接按 sid 分组就是全部线路的分集表
        const groups = new Map();
        for (const anchor of doc.select('a')) {
          const m = norm(anchor.attr('href')).match(HREF_PLAY_RE);
          if (!m || m[1] !== id) continue;
          const sid = m[2];
          const nid = Number(m[3]);
          if (!Number.isInteger(nid)) continue;
          if (!groups.has(sid)) groups.set(sid, new Map());
          const bucket = groups.get(sid);
          if (bucket.has(nid)) continue;
          bucket.set(nid, trim(anchor.text()) || String(nid));
        }
        if (!groups.size) {
          throw new hg.PluginError('CONTENT_LOCKED', '这部还没有可播放的线路');
        }

        // 抓一条播放页把线路名补齐（顺带确认这条线路真的能出地址）
        let labels = new Map();
        const playBtn = doc.first('.main-btn') || doc.first('a[href*="/vodplay/"]');
        if (playBtn) {
          const href = norm(playBtn.attr('href'));
          if (HREF_PLAY_RE.test(href)) {
            try {
              labels = sourcesOf(await fetchText(href, ctx, 0));
            } catch {
              labels = new Map();
            }
          }
        }

        const playlists = [];
        for (const [sid, bucket] of groups) {
          const episodes = Array.from(bucket.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([nid, label], i) => ({
              id: `s${sid}e${nid}`,
              index: i + 1,
              episodeNumber: nid,
              label: label.slice(0, 200),
            }));
          if (!episodes.length) continue;
          playlists.push({
            id: `s${sid}`,
            label: (labels.get(sid) || `线路${sid}`).slice(0, 200),
            kind: 'main',
            episodes,
          });
        }
        // 有名字的线路靠前，没名字的是详情页残留的死线路
        playlists.sort((a, b) => (labels.has(a.id.slice(1)) ? 0 : 1) - (labels.has(b.id.slice(1)) ? 0 : 1));

        const total = Math.max(...playlists.map(p => p.episodes.length));
        out.playlists = playlists.slice(0, 20);
        if (total > 1) {
          out.type = 'series';
          out.episodeCount = total;
          out.totalEpisodes = total;
        }
        return out;
      },

      async resolvePlayback(params, ctx) {
        const id = trim(params && params.mediaId);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const sid = (trim(params && params.playlistId).match(/^s(\d+)$/) || [])[1];
        const nid = (trim(params && params.episodeId).match(/e(\d+)$/) || [])[1];
        if (!sid || !nid) throw new hg.PluginError('INVALID_ARGUMENT', '分集标识不合法');

        const pagePath = `/vodplay/${id}-${sid}-${nid}.html`;
        const html = await fetchText(pagePath, ctx, 0);
        const data = playerDataOf(html);
        if (!data) throw new hg.PluginError('UPSTREAM_CHANGED', '播放页里没有播放器配置');

        let url = '';
        if (Number(data.encrypt) === 4) {
          // 密文要拿回服务端换地址，接口顺带做频率限制；换不到就照实说。
          const res = await hg.http.fetch({
            url: `${BASE}/amj-play.php`,
            method: 'POST',
            headers: {
              'User-Agent': UA,
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
              Referer: withBust(pagePath),
              Origin: BASE,
            },
            body: `token=${encodeURIComponent(norm(data.url))}`,
            responseType: 'json',
            retry: 0,
            signal: ctx.signal,
          });
          const payload = typeof res.data === 'string' ? safeJson(res.data) : res.data;
          if (payload && payload.error === 'captcha_required') {
            throw new hg.PluginError('CONTENT_LOCKED', '站点这次要求人机验证，稍后再试或换一条线路');
          }
          if (!res.ok || !payload || !payload.url) {
            throw new hg.PluginError(
              'CONTENT_LOCKED',
              (payload && payload.message) || `换地址失败（${res.status}），换一条线路试试`
            );
          }
          url = trim(payload.url);
        } else {
          // encrypt=0 的线路本来就把明文 m3u8 摆在 url 里
          url = trim(norm(data.url).replace(/\\\//g, '/'));
        }

        if (!/^https?:\/\//i.test(url)) {
          throw new hg.PluginError('CONTENT_LOCKED', '这条线路没有给出有效地址');
        }
        if (!/\.m3u8(\?|$)/i.test(url.split('#')[0])) {
          throw new hg.PluginError('CONTENT_LOCKED', `${trim(data.from) || '这条线路'} 不是直连片源`);
        }
        const stream = { url, kind: 'media', format: 'hls' };
        const from = trim(data.from);
        if (from) stream.label = from.slice(0, 40);
        return { streams: [stream] };
      },

      async matchUrl(params) {
        const raw = trim(params && params.url);
        const d = raw.match(DETAIL_RE);
        if (d) return { mediaId: d[1] };
        const p = raw.match(/\/vodplay\/(\d+)-(\d+)-(\d+)\.html/i);
        if (p) return { mediaId: p[1], episodeId: `s${p[2]}e${p[3]}` };
        const c = raw.match(/^https?:\/\/(?:www\.)?(?:amj31\.com|aimeiju\.org)\/vodshow\/(\d+)/i);
        if (c) return { categoryId: c[1] };
        return null;
      },
    },
  };
}
