export const meta = {
  id: 'agedm.source',
  name: 'AGE动漫',
  version: '1.0.2',
  protocol: 1,
  kind: 'source',
  description: 'AGE动漫（agedm.io，age.tv 跳转至此）：首页今日推荐与最近更新、目录八维筛选（版本/年份/地区/类型/首字母/季度/状态/资源）、搜索、详情与多线路 HLS。播放地址藏在第三方解析 iframe 里，插件走 播放页 → iframe → 解析页 三层取出 m3u8，并支持同集换线路。',
  mature: false,
  linkDomains: ['agedm.io', 'www.agedm.io', 'age.tv', 'm.agedm.io'],
  // 各条片源 CDN 都不校验 Referer，刻意只留 UA；解析页在第三方域名上，也不能靠默认头带站点 Referer。
  defaultHeaders: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  timeouts: { read: 25, playback: 30 },
};

const SITE = 'https://www.agedm.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 24;

const CATS = [
  { id: 'all', label: '全部', type: 'anime' },
  { id: 'TV', label: 'TV', type: 'anime' },
  { id: '剧场版', label: '剧场版', type: 'movie' },
  { id: 'OVA', label: 'OVA', type: 'anime' },
];
const CAT_TYPE = new Map(CATS.map(c => [c.id, c.type]));

const FILTER_TTL_MS = 60 * 60 * 1000;
const DEAD_KEY = 'dead.line.v1';
const DEAD_TTL_MS = 10 * 60 * 1000;
const SLOT_KEYS = ['type', 'year', 'letter', 'tags', 'source', 'order', 'page', 'area', 'season', 'status'];

const DETAIL_RE = /^https?:\/\/(?:www\.)?agedm\.io\/detail\/(\d+)/i;
const PLAY_RE = /^https?:\/\/(?:www\.)?agedm\.io\/play\/(\d+)\/(\d+)\/(\d+)/i;
const HREF_DETAIL_RE = /\/detail\/(\d+)/;
const HREF_PLAY_RE = /\/play\/(\d+)\/(\d+)\/(\d+)/;
const PLACEHOLDER_RE = /(?:^|\/)(?:load(?:ing)?|blank|placeholder|spacer|lazy)[^/]*\.(?:gif|png|jpe?g|webp)$/i;

const norm = s => (typeof s === 'string' ? s : '');
const trim = s => norm(s).replace(/\s+/g, ' ').trim();
const pageNo = cursor => {
  const n = Number(cursor);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

function unescapeHtml(text) {
  return norm(text)
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function toMs(text) {
  const m = norm(text).match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0) - 8, Number(m[5] || 0));
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms > Date.now() + 3600 * 1000) return undefined;
  return Math.round(ms);
}

function animeTypeOf(kind, count) {
  const k = norm(kind);
  if (/剧场版|映画|电影/.test(k)) return 'movie';
  if (/OVA|OAD|特别篇/.test(k)) return 'anime';
  return count > 1 ? 'anime' : 'movie';
}

function slotsOf(href) {
  const clean = norm(href).split('?')[0].replace(/^https?:\/\/[^/]+/i, '').replace(/^\/?catalog\//i, '');
  if (!clean) return null;
  const parts = clean.split('-');
  if (parts.length !== 7 && parts.length !== 10) return null;
  const out = {};
  SLOT_KEYS.forEach((key, i) => {
    out[key] = parts[i] === undefined ? 'all' : parts[i];
  });
  return out;
}

function catalogPath(opts) {
  const o = opts || {};
  const page = pageNo(o.page);
  const base = [
    trim(o.type) || 'all',
    trim(o.year) || 'all',
    trim(o.letter) || 'all',
    trim(o.tags) || 'all',
    trim(o.source) || 'all',
    trim(o.order) || 'time',
    String(page),
  ];
  const tail = [trim(o.area) || 'all', trim(o.season) || 'all', trim(o.status) || 'all'];
  const needTail = tail.some(v => v !== 'all');
  return `/catalog/${base.concat(needTail ? tail : []).join('-')}`;
}

export default function (hg) {
  let filterCache = null;

  async function fetchText(path, ctx, ttl) {
    const url = /^https?:\/\//i.test(path) ? path : `${SITE}${path}`;
    const res = await hg.http.fetch({
      url,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', Referer: `${SITE}/` },
      retry: 1,
      signal: ctx.signal,
      ...(ttl ? { cache: { ttlSec: ttl, staleIfErrorSec: 3600 } } : {}),
    });
    if (res.status === 404) throw new hg.PluginError('NOT_FOUND', '内容不存在或已下架');
    if (res.status === 429) throw new hg.PluginError('RATE_LIMITED', '站点限流了，等一会儿再试', { retryAfterSec: 30 });
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}`);
    return norm(res.data);
  }

  async function fetchDoc(path, ctx, ttl) {
    return hg.html.parse(await fetchText(path, ctx, ttl));
  }

  function coverOf(raw) {
    const url = unescapeHtml(raw).trim();
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('/')) return `${SITE}${url}`;
    return /^https?:\/\//i.test(url) ? url.replace(/^http:\/\//i, 'https://') : '';
  }

  function pickCover(anchor, img) {
    for (const cand of [
      anchor && anchor.attr('data-original'),
      anchor && anchor.attr('data-src'),
      img && img.attr('data-original'),
      img && img.attr('data-src'),
      img && img.attr('src'),
    ]) {
      const url = coverOf(cand);
      if (url && !PLACEHOLDER_RE.test(url)) return url;
    }
    return '';
  }

  function shortBadge(text) {
    const t = trim(text);
    if (!t) return '';
    if (t.length <= 8) return t;
    const ep = t.match(/(\d+)\s*集/);
    if (ep) return `更至${ep[1]}集`.slice(0, 8);
    return '';
  }

  // 列表卡片是 li.col 里的 .video_item，标题在 .video_item-title，角标在 .video_item--info。
  function cardsOf(root, fallbackType) {
    const out = [];
    const seen = new Set();

    const build = (anchor, holder) => {
      const m = norm(anchor.attr('href')).match(HREF_DETAIL_RE);
      if (!m || seen.has(m[1])) return null;
      const img = (holder || anchor).first('img');
      const titleNode = holder && holder.first('.video_item-title');
      const title =
        trim(titleNode && titleNode.text()) ||
        trim(anchor.attr('title')) ||
        trim(anchor.text()) ||
        trim(img && img.attr('alt'));
      if (!title) return null;
      seen.add(m[1]);
      const item = { id: m[1], title: title.slice(0, 200), type: fallbackType || 'anime' };
      const cover = pickCover(anchor, img);
      if (cover) item.cover = cover;
      const infoNode = holder && holder.first('.video_item--info');
      const badge = shortBadge(infoNode && infoNode.text());
      if (badge) item.badge = badge;
      return item;
    };

    for (const holder of root.select('.video_item')) {
      const anchor = holder.select('a').find(a => HREF_DETAIL_RE.test(norm(a.attr('href'))));
      const item = anchor ? build(anchor, holder) : null;
      if (item) out.push(item);
    }
    if (out.length) return out;

    for (const anchor of root.select('a')) {
      const m = norm(anchor.attr('href')).match(HREF_DETAIL_RE);
      if (!m || seen.has(m[1])) continue;
      const parent = anchor.parent();
      const item = build(anchor, parent || anchor);
      if (item) out.push(item);
    }
    return out;
  }

  function infoOf(doc) {
    const map = {};
    const tags = doc.select('.detail_imform_tag');
    const values = doc.select('.detail_imform_value');
    for (let i = 0; i < tags.length && i < values.length; i += 1) {
      const key = trim(tags[i].text()).replace(/[：:]\s*$/, '');
      if (!key) continue;
      map[key] = trim(values[i].text());
    }
    return map;
  }

  // 每条线路是一个 #playlist-source-<src> 面板，标签在同一工具栏的按钮上。
  function playlistsOf(doc) {
    const labelBySrc = new Map();
    for (const btn of doc.select('button[data-bs-target^="#playlist-source-"]')) {
      const target = norm(btn.attr('data-bs-target')).replace('#playlist-source-', '');
      const label = trim(btn.text());
      if (target && label) labelBySrc.set(target, label);
    }
    const out = [];
    const seenGroup = new Set();
    for (const pane of doc.select('[id^="playlist-source-"]')) {
      const src = norm(pane.attr('id')).replace('playlist-source-', '');
      const episodes = [];
      let group = '';
      for (const anchor of pane.select('a')) {
        const m = norm(anchor.attr('href')).match(HREF_PLAY_RE);
        if (!m) continue;
        group = m[2];
        const ep = Number(m[3]);
        if (!Number.isInteger(ep) || ep < 1) continue;
        if (episodes.some(e => e.ep === ep)) continue;
        episodes.push({ ep, label: trim(anchor.text()) });
      }
      if (!group || !episodes.length || seenGroup.has(group)) continue;
      seenGroup.add(group);
      episodes.sort((a, b) => a.ep - b.ep);
      out.push({
        id: group,
        label: labelBySrc.get(src) || `线路 ${group}`,
        kind: 'main',
        episodes: episodes.map((e, i) => ({
          id: `${group}-${e.ep}`,
          index: i + 1,
          episodeNumber: e.ep,
          label: (e.label || `第${e.ep}集`).slice(0, 200),
        })),
      });
    }
    return out;
  }

  function iframeSrcOf(html) {
    const m = norm(html).match(/<iframe[^>]*\bid="iframeForVideo"[^>]*\bsrc="([^"]+)"/i) || norm(html).match(/<iframe[^>]*\bsrc="([^"]*jx\.[^"]+)"/i);
    if (!m) return '';
    return unescapeHtml(m[1]).trim();
  }

  function parserUrlOf(html) {
    const m = norm(html).match(/Vurl\s*=\s*'([^']+)'/i) || norm(html).match(/Vurl\s*=\s*"([^"]+)"/i);
    if (!m) return '';
    return unescapeHtml(m[1]).trim();
  }

  async function loadDead() {
    try {
      const box = await hg.storage.get(DEAD_KEY);
      if (box && typeof box === 'object' && box.lines && Date.now() - Number(box.at || 0) < DEAD_TTL_MS) {
        return box.lines;
      }
    } catch {
      // 缓存异常按空处理
    }
    return {};
  }

  async function markDead(id, group) {
    try {
      const lines = await loadDead();
      lines[`${id}:${group}`] = Date.now();
      await hg.storage.set(DEAD_KEY, { at: Date.now(), lines }, { ttlSec: DEAD_TTL_MS / 1000 });
    } catch {
      // 忽略缓存异常
    }
  }

  async function resolveOne(id, group, ep, ctx) {
    const playHtml = await fetchText(`/play/${id}/${group}/${ep}`, ctx, 0);
    const iframe = iframeSrcOf(playHtml);
    if (!iframe) throw new hg.PluginError('CONTENT_LOCKED', '这一集没有播放器入口');
    if (!/^https?:\/\//i.test(iframe)) throw new hg.PluginError('UPSTREAM_CHANGED', '播放器地址不是绝对地址');
    // /vip/ 是站方的会员线路，解析页只吐一段广告 mp4，没有正片。
    if (/\/vip\//i.test(iframe)) throw new hg.PluginError('CONTENT_LOCKED', '这条线路是站方会员专享');
    const parserHtml = await fetchText(iframe, ctx, 0);
    const url = parserUrlOf(parserHtml);
    if (!url) throw new hg.PluginError('CONTENT_LOCKED', '解析页没给出播放地址');
    if (!/^https?:\/\//i.test(url)) throw new hg.PluginError('UPSTREAM_CHANGED', '解析地址不是绝对地址');
    const isHls = /\.m3u8(\?|$)/i.test(url.split('#')[0]);
    const stream = { url, kind: 'media', format: isHls ? 'hls' : 'progressive' };

    // 解析页给出地址不代表 CDN 认它：ffzy 那条线路对任何请求都回 403，
    // 所以这里先探一次，探不到就让上层换线路。
    try {
      const probe = await hg.http.fetch({
        url,
        responseType: 'text',
        headers: { 'User-Agent': UA, Range: 'bytes=0-2047' },
        timeoutMs: 6000,
        maxBytes: 256 * 1024,
        retry: 0,
        signal: ctx.signal,
      });
      const body = norm(probe.data);
      const okBody = isHls ? body.startsWith('#EXTM3U') : body.length > 0;
      if (!probe.ok || !okBody) {
        throw new hg.PluginError('CONTENT_LOCKED', `这条线路取流失败（${probe.status}）`);
      }
    } catch (error) {
      if (error && error.code === 'CANCELLED') throw error;
      if (error instanceof hg.PluginError) throw error;
      throw new hg.PluginError('CONTENT_LOCKED', '这条线路连不上');
    }
    return stream;
  }

  async function filterData(ctx) {
    if (filterCache && Date.now() - filterCache.at < FILTER_TTL_MS) return filterCache;
    let doc;
    try {
      doc = await fetchDoc(catalogPath({}), ctx, 1800);
    } catch (error) {
      if (error && error.code === 'CANCELLED') throw error;
      return { at: Date.now(), filters: [], sorts: [] };
    }
    const buckets = new Map();
    for (const block of doc.select('.filter_field')) {
      const head = block.select('a.filter_type_name')[0];
      const ntype = head && norm(head.attr('data-ntype'));
      if (!ntype || ntype === 'order') continue;
      const label = head ? trim(head.text()) : ntype;
      const options = [];
      for (const anchor of block.select('a')) {
        const slots = slotsOf(anchor.attr('href'));
        if (!slots || slots[ntype] === 'all') continue;
        const text = trim(anchor.text());
        if (!text) continue;
        if (options.some(o => o.id === slots[ntype])) continue;
        options.push({ id: slots[ntype], label: text.slice(0, 20) });
      }
      if (options.length) buckets.set(ntype, { label, options });
    }
    const filters = [];
    for (const [key, label] of [['year', '年份'], ['area', '地区'], ['tags', '类型'], ['status', '状态'], ['letter', '首字母'], ['source', '资源'], ['season', '季度']]) {
      const bucket = buckets.get(key);
      if (bucket && bucket.options.length) filters.push({ id: key, label: bucket.label || label, options: bucket.options });
    }
    const sorts = [
      { id: 'time', label: '最新' },
      { id: '点击量', label: '最热' },
    ];
    const data = { at: Date.now(), filters, sorts };
    filterCache = data;
    return data;
  }

  async function catalogList(params, ctx) {
    const tid = trim(params && params.categoryId) || 'all';
    if (!CAT_TYPE.has(tid)) throw new hg.PluginError('INVALID_ARGUMENT', '分类 ID 不合法');
    const page = pageNo(params && params.cursor);
    const filters = (params && params.filters) || {};
    const pick = key => {
      const value = filters[key];
      const first = Array.isArray(value) ? value[0] : value;
      return trim(first);
    };
    const path = catalogPath({
      type: tid,
      year: pick('year'),
      area: pick('area'),
      tags: pick('tags'),
      status: pick('status'),
      letter: pick('letter'),
      source: pick('source'),
      season: pick('season'),
      order: trim(params && params.sort),
      page,
    });
    const doc = await fetchDoc(path, ctx, 120);
    const items = cardsOf(doc, CAT_TYPE.get(tid));
    const out = { items };
    if (items.length >= PAGE_SIZE) out.next = String(page + 1);
    return out;
  }

  return {
    home: {
      async getSections(params, ctx) {
        const doc = await fetchDoc('/', ctx, 900);
        const sections = [];

        const picks = cardsOf(doc, 'anime');
        if (picks.length) {
          sections.push({ id: 'pick', title: '今日推荐', layout: 'grid', items: picks.slice(0, 24) });
        }

        // 「最近更新」是文字列表，每行一个条目，元素本身没有卡片结构。
        const recent = [];
        const seen = new Set();
        for (const anchor of doc.select('a')) {
          const href = norm(anchor.attr('href'));
          const m = href.match(HREF_DETAIL_RE);
          if (!m || seen.has(m[1])) continue;
          const text = trim(anchor.text());
          if (!text || text.length > 60) continue;
          seen.add(m[1]);
          recent.push({ id: m[1], title: text.slice(0, 200), type: 'anime' });
          if (recent.length >= 30) break;
        }
        if (recent.length) {
          sections.push({ id: 'recent', title: '最近更新', layout: 'list', items: recent });
        }

        if (!sections.length) throw new hg.PluginError('UPSTREAM_CHANGED', '首页结构已变化');
        return { items: sections, next: null };
      },
    },

    catalog: {
      async getCategories() {
        return CATS.map(c => ({ id: c.id, label: c.label }));
      },

      async getFilters(params, ctx) {
        const tid = trim(params && params.categoryId) || 'all';
        if (!CAT_TYPE.has(tid)) return { filters: [], sorts: [] };
        const data = await filterData(ctx);
        return { filters: data.filters, sorts: data.sorts };
      },

      async list(params, ctx) {
        return catalogList(params, ctx);
      },
    },

    search: {
      async search(params, ctx) {
        const query = trim(params && params.query);
        if (!query) return { items: [], next: null };
        const page = pageNo(params && params.cursor);
        const kw = encodeURIComponent(query);
        const path = page > 1 ? `/search?keyword=${kw}&page=${page}` : `/search?keyword=${kw}`;
        const doc = await fetchDoc(path, ctx, 60);
        const items = cardsOf(doc, 'anime');
        const out = { items };
        if (items.length >= PAGE_SIZE) out.next = String(page + 1);
        return out;
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = trim(params && params.id);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const doc = await fetchDoc(`/detail/${id}`, ctx, 300);

        const ogTitle = doc.first('meta[property="og:title"]');
        let title = trim(ogTitle && ogTitle.attr('content')).replace(/\s*-\s*AGE动漫\s*$/, '');
        if (!title) {
          const tag = doc.first('title');
          title = trim(tag && tag.text()).replace(/\s*-\s*AGE动漫\s*$/, '');
        }
        if (!title) throw new hg.PluginError('UPSTREAM_CHANGED', '详情结构已变化');

        const detail = { id, title: title.slice(0, 200), type: 'anime', playlists: [] };

        const ogImage = doc.first('meta[property="og:image"]');
        const poster = doc.first('.video_detail_box img[data-original]') || doc.first('img[data-original]');
        const cover = (ogImage && coverOf(ogImage.attr('content'))) || (poster ? pickCover(poster, poster) : '');
        if (cover) detail.cover = cover;

        const ogDesc = doc.first('meta[property="og:description"]');
        const desc = trim(ogDesc && ogDesc.attr('content'));
        if (desc) detail.description = desc.slice(0, 5000);

        const info = infoOf(doc);
        const area = info['地区'] || '';
        const kind = info['动画种类'] || '';
        const genre = info['剧情类型'] || '';
        const status = info['播放状态'] || '';
        const firstAir = info['首播时间'] || '';
        const studio = info['制作公司'] || '';
        const originName = info['原版名称'] || '';

        const tags = [];
        for (const t of genre.split(/[\s,，/]+/)) {
          const v = t.trim().slice(0, 30);
          if (v) tags.push(v);
        }
        if (area) tags.push(area);
        if (kind) tags.push(kind);
        if (tags.length) detail.tags = Array.from(new Set(tags)).slice(0, 20);

        const year = (firstAir.match(/(\d{4})/) || [])[1] || '';
        if (year) detail.year = Number(year);
        if (/连载|更新/.test(status)) detail.status = 'ongoing';
        else if (/完结/.test(status)) detail.status = 'finished';
        else if (/未播放|未播出/.test(status)) detail.status = 'upcoming';

        const people = [];
        if (studio) people.push({ name: studio.slice(0, 30), role: '制作公司' });
        if (originName) people.push({ name: originName.slice(0, 30), role: '原作' });
        if (people.length) detail.people = people;

        const airMs = toMs(firstAir);
        if (airMs !== undefined) detail.publishedAt = airMs;

        detail.playlists = playlistsOf(doc);
        if (!detail.playlists.length) throw new hg.PluginError('CONTENT_LOCKED', '这部还没有可播放的剧集');
        // 近期取流失败的线路沉底，默认第一条就是能播的。
        // 注意 key 必须带作品 ID：不同作品里 group=1 可能是不同片源（西瓜 / B站）。
        const deadLines = await loadDead();
        detail.playlists.sort((a, b) => (deadLines[`${id}:${a.id}`] ? 1 : 0) - (deadLines[`${id}:${b.id}`] ? 1 : 0));
        const count = detail.playlists[0].episodes.length;
        detail.episodeCount = count;
        detail.totalEpisodes = count;
        detail.type = animeTypeOf(kind, count);
        return detail;
      },

      async resolvePlayback(params, ctx) {
        const id = trim(params && params.mediaId);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const m = trim(params && params.episodeId).match(/^(\d+)-(\d+)$/);
        if (!m) throw new hg.PluginError('INVALID_ARGUMENT', '分集 ID 不合法');
        const group = m[1];
        const ep = m[2];

        let firstError = null;
        try {
          return { streams: [await resolveOne(id, group, ep, ctx)] };
        } catch (error) {
          if (error && (error.code === 'CANCELLED' || error.code === 'RATE_LIMITED')) throw error;
          firstError = error;
          await markDead(id, group);
        }

        // 这条线路的解析或 CDN 挂了，就按集号平移到同片其它线路。
        let playlists = [];
        try {
          const doc = await fetchDoc(`/detail/${id}`, ctx, 300);
          playlists = playlistsOf(doc);
        } catch (error) {
          if (error && (error.code === 'CANCELLED' || error.code === 'RATE_LIMITED')) throw error;
        }
        for (const pl of playlists) {
          if (pl.id === group) continue;
          const cand = pl.episodes.find(e => String(e.episodeNumber) === ep) || null;
          if (!cand) continue;
          try {
            return { streams: [await resolveOne(id, pl.id, ep, ctx)] };
          } catch (error) {
            if (error && (error.code === 'CANCELLED' || error.code === 'RATE_LIMITED')) throw error;
            await markDead(id, pl.id);
          }
        }
        // 单线路的作品基本都是「只有会员线路」，别让用户以为换一条就能看。
        const vipOnly = firstError && firstError.code === 'CONTENT_LOCKED' && /会员/.test(firstError.message);
        if (vipOnly) {
          throw new hg.PluginError(
            'CONTENT_LOCKED',
            playlists.length <= 1 ? '这部只有一条线路，且是站方会员专享' : '这部只有会员线路，其它线路也取不到地址'
          );
        }
        throw firstError || new hg.PluginError('CONTENT_LOCKED', '所有线路都取不到地址，稍后再试');
      },

      async matchUrl(params) {
        const url = norm(params && params.url);
        const play = url.match(PLAY_RE);
        if (play) return { mediaId: play[1], episodeId: `${play[2]}-${play[3]}` };
        const detail = url.match(DETAIL_RE);
        if (detail) return { mediaId: detail[1] };
        return null;
      },
    },
  };
}
