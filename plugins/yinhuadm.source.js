export const meta = {
  id: 'yinhuadm.source',
  name: '樱花动漫',
  version: '1.0.0',
  protocol: 1,
  kind: 'source',
  description: '樱花动漫（yinhuadm.net）：首页分区、四个频道、按关键词检索、详情与 HLS 播放。播放地址由站内播放器用 AES 封在 iframe 里，插件复刻了它的密钥派生（两个 meta 标签 id 交叉重排 + MD5 取前后半段作 key/iv）在本地还原。',
  mature: false,
  linkDomains: ['yinhuadm.net', 'www.yinhuadm.net', 'yinhuadm.one'],
  defaultHeaders: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  timeouts: { read: 25, playback: 30 },
};

const SITE = 'https://www.yinhuadm.net';
const PARSER = 'https://player.mcue.cc/yinhua/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 站方播放器的密钥派生：md5(seed + 'lemon') 的后 16 位当 key、前 16 位当 iv，
// seed 由解析页两个 meta 的 id 去掉 now_ 前缀后交叉重排得到。见 README 说明。
const SALT = 'lemon';
const ID_PREFIX = 'now_';

const CATS = [
  { id: '1', label: '最新动漫', type: 'anime' },
  { id: '2', label: '推荐', type: 'anime' },
  { id: '9', label: '国产动漫', type: 'anime' },
  { id: '10', label: '日韩动漫', type: 'anime' },
  { id: '11', label: '欧美动漫', type: 'anime' },
];
const CAT_TYPE = new Map(CATS.map(c => [c.id, c.type]));

const DETAIL_RE = /^https?:\/\/(?:www\.)?yinhuadm\.net\/v\/(\d+)\.html/i;
const PLAY_RE = /^https?:\/\/(?:www\.)?yinhuadm\.net\/p\/(\d+)-(\d+)-(\d+)\.html/i;
const HREF_DETAIL_RE = /\/v\/(\d+)\.html/;
const HREF_PLAY_RE = /\/p\/(\d+)-(\d+)-(\d+)\.html/;
const PLACEHOLDER_RE = /(?:^|\/)(?:load(?:ing)?|blank|placeholder|spacer|lazy)[^/]*\.(?:gif|png|jpe?g|webp)$/i;

const norm = s => (typeof s === 'string' ? s : '');
const trim = s => norm(s).replace(/\s+/g, ' ').trim();
const pageNo = cursor => {
  const n = Number(cursor);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

function toMs(text) {
  const m = norm(text).match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0) - 8, Number(m[5] || 0));
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms > Date.now() + 3600 * 1000) return undefined;
  return Math.round(ms);
}

// 剧集链接的标题形如「播放XXX第01集」，取末尾的第 N 集作展示名。
function episodeLabel(title, nid) {
  const t = trim(title);
  const m = t.match(/第\s*([0-9.]+)\s*[集话話]/);
  if (m) return `第${m[1]}集`;
  return `第${nid}集`;
}

export default function (hg) {
  function md5Hex(text) {
    const raw = hg.crypto.digest('md5', text);
    let out = '';
    for (let i = 0; i < raw.length; i += 1) out += raw[i].toString(16).padStart(2, '0');
    return out;
  }

  // 复刻解析页的 decrypt()：把 charset-id 的每个字符当排序键，
  // 按它重排 viewport-id 的字符得到 seed，再 md5(seed + 'lemon')。
  function deriveKeyMaterial(charsetId, viewportId) {
    const keys = String(charsetId || '').replace(ID_PREFIX, '');
    const chars = String(viewportId || '').replace(ID_PREFIX, '');
    const pairs = [];
    for (let i = 0; i < keys.length; i += 1) {
      pairs.push({ id: keys[i], text: chars[i] || '' });
    }
    // 原实现是 (a, b) => a - b；键是数字字符时等价于数值升序，非数字时保持原序。
    const numeric = pairs.every(p => /[0-9]/.test(p.id));
    if (numeric) pairs.sort((a, b) => Number(a.id) - Number(b.id));
    const seed = pairs.map(p => p.text).join('');
    const hex = md5Hex(seed + SALT);
    return { key: hex.slice(16), iv: hex.slice(0, 16) };
  }

  function decryptStream(cipher, charsetId, viewportId) {
    const { key, iv } = deriveKeyMaterial(charsetId, viewportId);
    const data = hg.codec.base64Decode(norm(cipher).trim());
    const plain = hg.crypto.aesDecrypt(
      { mode: 'cbc', key: hg.codec.utf8Encode(key), iv: hg.codec.utf8Encode(iv), padding: 'pkcs7' },
      data
    );
    return hg.codec.utf8Decode(plain).trim();
  }

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
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}`);
    return norm(res.data);
  }

  async function fetchDoc(path, ctx, ttl) {
    return hg.html.parse(await fetchText(path, ctx, ttl));
  }

  function coverOf(raw) {
    const url = norm(raw).trim();
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('/')) return `${SITE}${url}`;
    return /^https?:\/\//i.test(url) ? url : '';
  }

  function pickCover(anchor, img) {
    for (const cand of [
      anchor && anchor.attr('data-original'),
      anchor && anchor.attr('data-src'),
      img && img.attr('data-original'),
      img && img.attr('data-src'),
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
    const ep = t.match(/(\d+)\s*[集话話]/);
    if (ep) return `更至${ep[1]}集`.slice(0, 8);
    return '';
  }

  // 卡片是 <a class="module-poster-item" href="/v/{id}.html" title="...">，
  // 封面在 .module-item-pic img[data-original]，角标在 .module-item-note。
  function cardsOf(root, fallbackType) {
    const out = [];
    const seen = new Set();
    for (const anchor of root.select('a')) {
      const m = norm(anchor.attr('href')).match(HREF_DETAIL_RE);
      if (!m || seen.has(m[1])) continue;
      const cls = norm(anchor.attr('class'));
      if (!/module-poster-item|module-item/.test(cls) && !anchor.first('img')) continue;
      const img = anchor.first('img');
      const title = trim(anchor.attr('title')) || trim(img && img.attr('alt')) || trim(anchor.text());
      if (!title) continue;
      seen.add(m[1]);
      const item = { id: m[1], title: title.slice(0, 200), type: fallbackType || 'anime' };
      const cover = pickCover(anchor, img);
      if (cover) item.cover = cover;
      const note = anchor.first('.module-item-note');
      const badge = shortBadge(note && note.text());
      if (badge) item.badge = badge;
      out.push(item);
    }
    return out;
  }

  function playlistsOf(doc) {
    const groups = new Map();
    for (const anchor of doc.select('a')) {
      const href = norm(anchor.attr('href'));
      const m = href.match(HREF_PLAY_RE);
      if (!m) continue;
      const sid = m[2];
      const nid = Number(m[3]);
      if (!Number.isInteger(nid) || nid < 1) continue;
      const list = groups.get(sid) || [];
      if (list.some(e => e.nid === nid)) continue;
      list.push({ nid, label: episodeLabel(anchor.attr('title') || anchor.text(), nid) });
      groups.set(sid, list);
    }
    const out = [];
    const ordered = Array.from(groups.entries()).sort((a, b) => Number(a[0]) - Number(b[0]));
    for (const [sid, list] of ordered) {
      list.sort((a, b) => a.nid - b.nid);
      out.push({
        id: sid,
        label: groups.size > 1 ? `线路 ${sid}` : '默认线路',
        kind: 'main',
        episodes: list.map((e, i) => ({
          id: `${sid}-${e.nid}`,
          index: i + 1,
          episodeNumber: e.nid,
          label: e.label.slice(0, 200),
        })),
      });
    }
    return out;
  }

  function playerDataOf(html) {
    const anchor = norm(html).indexOf('player_aaaa');
    if (anchor < 0) return null;
    const start = norm(html).indexOf('{', anchor);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i += 1) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  async function resolveOne(id, sid, nid, ctx) {
    const playHtml = await fetchText(`/p/${id}-${sid}-${nid}.html`, ctx, 0);
    const player = playerDataOf(playHtml);
    if (!player) throw new hg.PluginError('UPSTREAM_CHANGED', '播放页结构已变化');
    const seeded = trim(player.url);
    if (!seeded) throw new hg.PluginError('CONTENT_LOCKED', '这一集没有给出播放参数');

    const next = trim(player.link_next);
    const query = `url=${seeded}` + (next ? `&next=${encodeURIComponent(`${SITE}${next}`)}` : '') + `&title=${encodeURIComponent(trim(player.vod_data && player.vod_data.vod_name) || 'player')}`;
    const parserHtml = await fetchText(`${PARSER}?${query}`, ctx, 0);
    const doc = hg.html.parse(parserHtml);

    const configMatch = norm(parserHtml).match(/"url"\s*:\s*"([^"]+)"/);
    const cipher = configMatch ? configMatch[1] : '';
    if (!cipher) throw new hg.PluginError('CONTENT_LOCKED', '解析页没给出加密流地址');

    const charsetMeta = doc.first('meta[charset="UTF-8"]') || doc.select('meta[charset]')[0];
    const viewportMeta = doc.first('meta[name="viewport"]') || doc.select('meta[name="viewport"]')[0];
    const charsetId = charsetMeta ? norm(charsetMeta.attr('id')) : '';
    const viewportId = viewportMeta ? norm(viewportMeta.attr('id')) : '';
    if (!charsetId || !viewportId) {
      throw new hg.PluginError('UPSTREAM_CHANGED', '解析页缺少密钥标签，站方可能换了加密方式');
    }

    let url = '';
    try {
      url = decryptStream(cipher, charsetId, viewportId);
    } catch {
      throw new hg.PluginError('UPSTREAM_CHANGED', '流地址解密失败，站方可能换了密钥');
    }
    if (!/^https?:\/\//i.test(url)) throw new hg.PluginError('CONTENT_LOCKED', '解密结果不是播放地址');

    const isHls = /\.m3u8(\?|$)/i.test(url.split('#')[0]);
    const stream = { url, kind: 'media', format: isHls ? 'hls' : 'progressive' };

    // 解密出地址不等于 CDN 认它，先探一次；探不到让上层换线路。
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
      if (!probe.ok || !okBody) throw new hg.PluginError('CONTENT_LOCKED', `这条线路取流失败（${probe.status}）`);
    } catch (error) {
      if (error && error.code === 'CANCELLED') throw error;
      if (error instanceof hg.PluginError) throw error;
      throw new hg.PluginError('CONTENT_LOCKED', '这条线路连不上');
    }
    return stream;
  }

  async function listFrom(path, ctx, fallbackType) {
    const doc = await fetchDoc(path, ctx, 120);
    return cardsOf(doc, fallbackType);
  }

  return {
    home: {
      async getSections(params, ctx) {
        const doc = await fetchDoc('/', ctx, 900);
        const sections = [];
        const seen = new Set();
        for (const module of doc.select('.module')) {
          const titleNode = module.first('.module-title');
          let title = trim(titleNode && titleNode.text());
          // 站方把英文副名直接拼在中文后面：国产动漫GuoChanDongMan → 国产动漫
          title = title.replace(/(?:[A-Z][A-Za-z]*\s*){1,}$/, '').trim();
          if (!title || seen.has(title)) continue;
          const items = cardsOf(module, 'anime');
          if (!items.length) continue;
          seen.add(title);
          const link = module.select('a').find(a => /\/w\/\d+\.html/.test(norm(a.attr('href'))));
          const tidMatch = link ? norm(link.attr('href')).match(/\/w\/(\d+)\.html/) : null;
          const section = {
            id: `s${sections.length}`,
            title: title.slice(0, 200),
            layout: sections.length === 0 ? 'row' : 'grid',
            items: items.slice(0, 24),
          };
          if (tidMatch && CAT_TYPE.has(tidMatch[1])) {
            section.id = `cat:${tidMatch[1]}`;
            section.more = true;
          }
          sections.push(section);
          if (sections.length >= 6) break;
        }
        if (!sections.length) throw new hg.PluginError('UPSTREAM_CHANGED', '首页结构已变化');
        return { items: sections, next: null };
      },

      async listSection(params, ctx) {
        const id = trim(params && params.sectionId);
        const m = id.match(/^cat:(\d+)$/);
        if (!m) return { items: [], next: null };
        const items = await listFrom(`/s/${m[1]}.html`, ctx, CAT_TYPE.get(m[1]));
        return { items, next: null };
      },
    },

    catalog: {
      async getCategories() {
        return CATS.map(c => ({ id: c.id, label: c.label }));
      },

      // 站点列表页只有首屏是服务端渲染的，翻页与筛选都在前端脚本里，抓不到稳定接口，
      // 所以这里不假装提供筛选，靠搜索补足片库深度。
      async getFilters() {
        return { filters: [], sorts: [] };
      },

      async list(params, ctx) {
        const tid = trim(params && params.categoryId);
        if (!CAT_TYPE.has(tid)) throw new hg.PluginError('INVALID_ARGUMENT', '分类 ID 不合法');
        const items = await listFrom(`/s/${tid}.html`, ctx, CAT_TYPE.get(tid));
        return { items, next: null };
      },
    },

    search: {
      async search(params, ctx) {
        const query = trim(params && params.query);
        if (!query) return { items: [], next: null };
        const page = pageNo(params && params.cursor);
        const kw = encodeURIComponent(query);
        const path = page > 1 ? `/vch/${kw}-${page}.html` : `/vch/${kw}.html`;
        const doc = await fetchDoc(path, ctx, 60);
        const items = cardsOf(doc, 'anime');
        const out = { items };
        if (page === 1 && items.length >= 12) out.next = '2';
        return out;
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = trim(params && params.id);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const doc = await fetchDoc(`/v/${id}.html`, ctx, 300);

        const head = doc.first('h1');
        let title = trim(head && head.text());
        if (!title) {
          const tag = doc.first('title');
          title = trim(tag && tag.text()).split(/\s*[-_]\s*/)[0];
        }
        if (!title) throw new hg.PluginError('UPSTREAM_CHANGED', '详情结构已变化');

        const detail = { id, title: title.slice(0, 200), type: 'anime', playlists: [] };

        const poster = doc.first('.module-info-poster') || doc.first('.module-item-pic');
        const cover = poster ? pickCover(poster, poster.first('img')) : '';
        if (cover) detail.cover = cover;

        const rows = doc.select('.module-info-item').map(row => trim(row.text()));
        const info = rows.join(' ');
        const director = (info.match(/导演：\s*(.+?)(?:\s*主演：|$)/) || [])[1] || '';
        const actor = (info.match(/主演：\s*(.+?)(?:\s*更新：|$)/) || [])[1] || '';
        const updated = (info.match(/更新：\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
        const note = (info.match(/备注：\s*(.+?)$/) || [])[1] || '';

        const descNode = doc.first('.module-info-introduction');
        let description = trim(descNode && descNode.text()).replace(/^简介[:：]\s*/, '');
        if (!description) {
          const meta = doc.first('meta[name="description"]');
          description = trim(meta && meta.attr('content'));
        }
        if (description) detail.description = description.slice(0, 5000);

        const splitNames = value =>
          norm(value)
            .split(/[/、,，]/)
            .map(s => s.trim().slice(0, 30))
            .filter(Boolean);

        const people = [];
        for (const name of splitNames(director)) people.push({ name, role: '导演' });
        for (const name of splitNames(actor)) people.push({ name, role: '演员' });
        if (people.length) detail.people = people.slice(0, 30);

        if (note) {
          const tags = [note.slice(0, 30)];
          detail.tags = tags;
          if (/完结|全集/.test(note)) detail.status = 'finished';
          else if (/更新|连载/.test(note)) detail.status = 'ongoing';
        }

        const updatedMs = toMs(updated);
        if (updatedMs !== undefined) detail.updatedAt = updatedMs;

        detail.playlists = playlistsOf(doc);
        if (!detail.playlists.length) throw new hg.PluginError('CONTENT_LOCKED', '这部还没有可播放的剧集');
        const count = detail.playlists[0].episodes.length;
        detail.episodeCount = count;
        detail.totalEpisodes = count;
        detail.type = count > 1 ? 'anime' : 'movie';
        return detail;
      },

      async resolvePlayback(params, ctx) {
        const id = trim(params && params.mediaId);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const m = trim(params && params.episodeId).match(/^(\d+)-(\d+)$/);
        if (!m) throw new hg.PluginError('INVALID_ARGUMENT', '分集 ID 不合法');
        const sid = m[1];
        const nid = m[2];

        let firstError = null;
        try {
          return { streams: [await resolveOne(id, sid, nid, ctx)] };
        } catch (error) {
          if (error && (error.code === 'CANCELLED' || error.code === 'RATE_LIMITED')) throw error;
          firstError = error;
        }

        // 这条线路的 CDN 挂了，按集号平移到同片其它线路。
        let playlists = [];
        try {
          const doc = await fetchDoc(`/v/${id}.html`, ctx, 300);
          playlists = playlistsOf(doc);
        } catch (error) {
          if (error && (error.code === 'CANCELLED' || error.code === 'RATE_LIMITED')) throw error;
        }
        for (const pl of playlists) {
          if (pl.id === sid) continue;
          const cand = pl.episodes.find(e => String(e.episodeNumber) === nid);
          if (!cand) continue;
          try {
            return { streams: [await resolveOne(id, pl.id, nid, ctx)] };
          } catch (error) {
            if (error && (error.code === 'CANCELLED' || error.code === 'RATE_LIMITED')) throw error;
          }
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
