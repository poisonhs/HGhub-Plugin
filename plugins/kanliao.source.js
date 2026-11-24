export const meta = {
  id: 'kanliao.source',
  name: '今日看料',
  version: '1.0.1',
  protocol: 1,
  kind: 'source',
  description:
    '今日看料（kanliao20.org）：Typecho + Mirages 主题。首页与十一个分区、关键词搜索、详情与 HLS 回放。视频地址由服务端渲染进播放器 data-config，明文 m3u8 直连；主域名在部分地区解析不出来，会自动切两个同内容的备用域名；部分帖子只是导流外链，插件会直接说明。',
  mature: true,
  linkDomains: ['kanliao20.org', 'kanliao20.net', 'kanliao20.cyou', 'henxihuan-ma.top'],
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  timeouts: { read: 20, playback: 25 },
};

// 主站在 Cloudflare 上，部分地区直接解析不出来。站方另挂了两个同内容域名
// （首页 article id 列表逐条比对过，完全一致），按顺序探，谁通用谁。
const SITE_CANDIDATES = [
  'https://www.kanliao20.org',
  'https://www.kanliao20.net',
  'https://www.kanliao20.cyou',
];
const BASE = SITE_CANDIDATES[0];
const BASE_KEY = 'kanliao.base.v1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DETAIL_RE = /^https?:\/\/(?:www\.)?kanliao20\.(?:org|net|cyou)\/archives\/(\d+)/i;
const HREF_DETAIL_RE = /\/archives\/(\d+)\/?/;
const HREF_CAT_RE = /^\/category\/([a-z0-9]{2,12})\/$/i;

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
  const url = trim(raw);
  if (!url) return '';
  if (/gravatar\.loli\.net|\/avatar\/|logo\.png/i.test(url)) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${BASE}${url}`;
  return /^https?:\/\//i.test(url) ? url : '';
}

export default function (hg) {
  let catCache = null;
  let baseCache = null;

  // 先看缓存，再按候选顺序实测。解析失败的那条会抛 NETWORK，直接跳过。
  async function siteBase(ctx, force) {
    if (baseCache && !force) return baseCache;
    if (!force) {
      try {
        const saved = await hg.storage.get(BASE_KEY);
        if (saved && typeof saved.url === 'string' && saved.url) {
          baseCache = saved.url;
          return baseCache;
        }
      } catch {
        // 缓存异常按无缓存处理
      }
    }
    let lastError = null;
    for (const base of SITE_CANDIDATES) {
      try {
        const res = await hg.http.fetch({
          url: `${base}/`,
          headers: { 'User-Agent': UA, Accept: 'text/html' },
          timeoutMs: 8000,
          maxBytes: 2 * 1024 * 1024,
          retry: 0,
          signal: ctx.signal,
        });
        if (res.ok && norm(res.data).includes('/archives/')) {
          baseCache = base;
          try {
            await hg.storage.set(BASE_KEY, { url: base, at: Date.now() });
          } catch {
            // 忽略缓存异常
          }
          return base;
        }
        lastError = new hg.PluginError('UPSTREAM_ERROR', `${base} 返回 ${res.status}`);
      } catch (error) {
        if (error && error.code === 'CANCELLED') throw error;
        lastError = error;
      }
    }
    throw lastError instanceof hg.PluginError
      ? lastError
      : new hg.PluginError('NETWORK', '主站和两个备用域名都连不上');
  }

  async function fetchText(path, ctx, ttl) {
    const full = /^https?:\/\//i.test(path);
    let lastError = null;
    // 第一次用记住的域名；连不上就强制重新探一轮，防止旧域名一直挂着。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const base = full ? '' : await siteBase(ctx, attempt > 0);
      const url = full ? path : `${base}${path}`;
      try {
        const res = await hg.http.fetch({
          url,
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', Referer: `${base || BASE}/` },
          retry: 0,
          signal: ctx.signal,
          ...(ttl ? { cache: { ttlSec: ttl, staleIfErrorSec: 900 } } : {}),
        });
        // 一部分帖子根本不给内容，301 到 /go/xxx/ 再转到广告联盟落地页。
        // 跟随后 URL 已经不在本站，按「没有片源」处理，别让用户以为网络坏了。
        const landed = norm(res.url);
        if (landed && !/^https?:\/\/(?:www\.)?kanliao20\.(?:org|net|cyou)\//i.test(landed) && !full) {
          throw new hg.PluginError('CONTENT_LOCKED', '这条帖子只是导流外链，站内没有片源');
        }
        if (res.status === 404) throw new hg.PluginError('NOT_FOUND', '内容不存在或已下架');
        if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}`);
        return norm(res.data);
      } catch (error) {
        if (error && (error.code === 'CANCELLED' || error.code === 'CONTENT_LOCKED' || error.code === 'NOT_FOUND')) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError instanceof hg.PluginError
      ? lastError
      : new hg.PluginError('NETWORK', '站点连不上，换一条备用域名也没通');
  }

  async function fetchDoc(path, ctx, ttl) {
    return hg.html.parse(await fetchText(path, ctx, ttl));
  }

  // 列表页每页都会先铺 15 条带角标的推荐位，剩下的才是本页内容。
  // 角标就是标题里的 .wrap 节点，拿它区分最省事。
  function cardOf(node) {
    const anchor = node.select('a')[0] || node;
    const href = norm(anchor.attr('href'));
    const m = href.match(HREF_DETAIL_RE);
    if (!m) return null;
    if (node.first('.wrap')) return null;
    const head = node.first('h2[itemprop="headline"]') || node.first('.post-card-title');
    let title = trim(head && head.text());
    if (!title) title = trim(anchor.attr('title') || anchor.text());
    if (!title) return null;
    const item = { id: m[1], title: title.slice(0, 200), type: 'short' };
    const meta = node.first('meta[itemprop="image"]');
    const img = node.first('img');
    const cover = imageOf(
      (meta && meta.attr('content')) || (img && (img.attr('z-image-loader-url') || img.attr('src'))) || ''
    );
    if (cover) item.cover = cover;
    return item;
  }

  function cardsOf(root) {
    const out = [];
    const seen = new Set();
    for (const node of root.select('article')) {
      const card = cardOf(node);
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      out.push(card);
    }
    return out;
  }

  async function categoriesOf(ctx) {
    if (catCache) return catCache;
    const doc = await fetchDoc('/', ctx, 1800);
    const seen = new Map();
    for (const anchor of doc.select('a')) {
      const href = norm(anchor.attr('href'));
      const m = href.match(HREF_CAT_RE) || href.match(/^https?:\/\/(?:www\.)?kanliao20\.(?:org|net|cyou)\/category\/([a-z0-9]{2,12})\/$/i);
      if (!m) continue;
      const slug = m[1].toLowerCase();
      if (seen.has(slug)) continue;
      const label = trim(anchor.text());
      if (!label || label.length > 10) continue;
      seen.set(slug, label);
    }
    const cats = Array.from(seen.entries()).map(([id, label]) => ({ id, label }));
    if (!cats.length) throw new hg.PluginError('UPSTREAM_CHANGED', '没解析到分类导航');
    catCache = cats;
    return cats;
  }

  // 一页可能挂好几个播放器，每个 data-config 里 video.url 都是一条独立 m3u8。
  function episodesOf(doc) {
    const out = [];
    const seen = new Set();
    for (const node of doc.select('.dplayer')) {
      const raw = norm(node.attr('data-config')).trim();
      if (!raw) continue;
      const cfg = safeJson(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      const video = cfg && cfg.video;
      const url = trim(norm(video && video.url).replace(/\\\//g, '/'));
      if (!/^https?:\/\//i.test(url) || !/\.m3u8(\?|$)/i.test(url.split('#')[0])) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      // 这站根本没有 data-video_index。注意 Number('') === 0，直接 Number(attr)
      // 会让每一条都被当成序号 0，得先判断属性在不在。
      const idxAttr = node.attr('data-video_index');
      const parsed = idxAttr === null || idxAttr === '' ? NaN : Number(idxAttr);
      out.push({
        index: Number.isInteger(parsed) && parsed >= 0 ? parsed : out.length,
        title: trim(node.attr('data-video_title')),
        pic: imageOf(trim(norm(video && video.pic).replace(/\\\//g, '/'))),
        url,
      });
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }

  async function detailOf(id, ctx) {
    const doc = await fetchDoc(`/archives/${id}/`, ctx, 0);
    const episodes = episodesOf(doc);
    let title = '';
    const h1 = doc.first('h1');
    if (h1) title = trim(h1.text());
    if (!title) {
      const t = doc.first('title');
      title = trim(t && t.text()).split(/\s*[-_|]\s*/)[0];
    }
    if (!title) throw new hg.PluginError('UPSTREAM_CHANGED', '详情结构已变化');
    const desc = doc.first('meta[name="description"]');
    const overview = trim(desc && desc.attr('content'));
    let cover = '';
    for (const img of doc.select('img')) {
      const cand = imageOf(img.attr('z-image-loader-url') || img.attr('data-src') || img.attr('src'));
      if (cand && /henxihuan-ma|kanliao|jincai|\.jpe?g|\.png|\.gif/i.test(cand)) {
        cover = cand;
        break;
      }
    }
    return { doc, episodes, title, overview, cover };
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
        return categoriesOf(ctx);
      },

      async list(params, ctx) {
        const slug = trim(params && params.categoryId).toLowerCase();
        if (!/^[a-z0-9]{2,12}$/.test(slug)) throw new hg.PluginError('INVALID_ARGUMENT', '分类 ID 不合法');
        const page = pageNo(params && params.cursor);
        const path = page > 1 ? `/category/${slug}/${page}/` : `/category/${slug}/`;
        const doc = await fetchDoc(path, ctx, 120);
        const items = cardsOf(doc);
        const out = { items };
        if (items.length >= 8) out.next = String(page + 1);
        return out;
      },
    },

    search: {
      async search(params, ctx) {
        const query = trim(params && params.query);
        if (!query) return { items: [], next: null };
        // Typecho 的 ?s= 会 302，直接走 /search/{词}/ 更省事。
        const doc = await fetchDoc(`/search/${encodeURIComponent(query)}/`, ctx, 300);
        return { items: cardsOf(doc), next: null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = trim(params && params.id);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const detail = await detailOf(id, ctx);

        const out = { id, title: detail.title.slice(0, 200), type: 'short', playlists: [] };
        if (detail.cover) out.cover = detail.cover;
        if (detail.overview) out.description = detail.overview.slice(0, 5000);

        if (!detail.episodes.length) {
          throw new hg.PluginError('CONTENT_LOCKED', '这条是图文帖，没有可播放的视频');
        }
        const multi = detail.episodes.length > 1;
        out.playlists = [
          {
            id: 'main',
            label: multi ? '分段' : '播放',
            kind: 'main',
            episodes: detail.episodes.map((ep, i) => ({
              id: `e${ep.index}`,
              index: i + 1,
              episodeNumber: i + 1,
              label: (multi ? `第${i + 1}段` : ep.title || detail.title).slice(0, 200),
            })),
          },
        ];
        if (multi) {
          out.episodeCount = detail.episodes.length;
          out.totalEpisodes = detail.episodes.length;
        }
        return out;
      },

      async resolvePlayback(params, ctx) {
        const id = trim(params && params.mediaId);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        // 地址写在渲染好的 HTML 里，不缓存；每次播放重新取一遍。
        const { episodes } = await detailOf(id, ctx);
        if (!episodes.length) {
          throw new hg.PluginError('CONTENT_LOCKED', '这条是图文帖，没有可播放的视频');
        }
        const wanted = trim(params && params.episodeId).replace(/^e/, '');
        const idx = Number(wanted);
        const picked = episodes.find(ep => ep.index === idx) || episodes[0];
        const stream = { url: picked.url, kind: 'media', format: 'hls' };
        if (episodes.length > 1) stream.label = `第${picked.index + 1}段`;
        return { streams: [stream] };
      },

      async matchUrl(params) {
        const raw = trim(params && params.url);
        const d = raw.match(DETAIL_RE);
        if (d) return { mediaId: d[1] };
        const c = raw.match(/^https?:\/\/(?:www\.)?kanliao20\.(?:org|net|cyou)\/category\/([a-z0-9]{2,12})\/?/i);
        if (c) return { categoryId: c[1].toLowerCase() };
        return null;
      },
    },
  };
}
