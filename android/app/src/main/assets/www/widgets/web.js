import { $, API, PANEL_HEADERS, ago, api, bridge, h, haptic, safeFetch, store, t, tick, toast } from '../main.js';
import { W } from '../registry.js';
import { cached, every, fmtNum, lines, pctSpan, sparkLine } from './helpers.js';

// ---------------------------------------------------------------- the internet
W.hackernews = {
  needs: ['tick'],
  create(box) {
    const list = h('div', 'hn-list', h('div', 'empty', t('w.loading')));
    box.style.setProperty('--c', '#ff6600');
    box.append(h('div', 'w-title', 'Hacker News', h('span', 'w-sub', '')), list);
    const load = every(15 * 60_000, async () => {
      try {
        const key = 'hn';
        let data = store.get('nc:' + key, null);
        if (!data || Date.now() - data.at > 15 * 60_000) {
          const ids = (await cached('hn-ids', 'https://hacker-news.firebaseio.com/v0/topstories.json', 15 * 60_000)).slice(0, 15);
          const items = await Promise.all(ids.map((id) => safeFetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json()).catch(() => null)));
          data = { at: Date.now(), data: items.filter(Boolean).map((i) => ({ t: i.title, u: i.url, s: i.score, c: i.descendants || 0 })) };
          store.set('nc:' + key, data);
        }
        box.querySelector('.w-sub').textContent = ago(data.at);
        const n = Math.max(1, Math.floor((box.clientHeight - 30) / 33));
        list.replaceChildren(...data.data.slice(0, n).map((s, i) => {
          let host = '';
          try { host = s.u ? new URL(s.u).hostname.replace(/^www\./, '') : 'news.ycombinator.com'; } catch (_) {}
          return h('div', 'hn-i', h('span', 'hn-r', i + 1), h('div', 'hn-b', h('div', 'hn-t', s.t), h('div', 'hn-m', `▲ ${s.s} · ${s.c} comments · ${host}`)));
        }));
      } catch (_) { if (!list.querySelector('.hn-i')) list.replaceChildren(h('div', 'empty', t('w.offline'))); return false; }
    });
    return { update: load };
  },
};

// Headlines from the RSS / Atom feeds set up on the PC. The agent fetches them (at most every 15 minutes); the
// phone gets titles, the feed's name and times, and opens an article on the PC by its id. The list scrolls, and an
// article opened from this phone loses its accent bar (the ids it opened are kept on the phone).
const FEEDS_READ = 'feeds-read', FEEDS_READ_MAX = 500, FEEDS_SHOWN = 60;
const feedsRead = () => new Set(store.get(FEEDS_READ, []));
const markFeedRead = (id) => {
  const ids = store.get(FEEDS_READ, []).filter((x) => x !== id);
  ids.push(id);
  store.set(FEEDS_READ, ids.slice(-FEEDS_READ_MAX));
};
W.feeds = {
  needs: ['tick'],
  create(box, { o }) {
    const only = String(o.feed || '').trim().toLowerCase();
    const showSource = o.showSource !== false, showTime = o.showTime !== false;
    const lineCount = ['2', '3'].includes(String(o.lines)) ? +o.lines : 1;
    const list = h('div', 'fd-list', h('div', 'empty', t('w.loading')));
    if (lineCount > 1) { list.classList.add('wrap'); list.style.setProperty('--fl', lineCount); }
    const sub = h('span', 'w-sub', '');
    box.style.setProperty('--c', '#f59e0b');
    if (o.title !== '') box.append(h('div', 'w-title', o.title || 'News', sub));
    box.append(list);
    let data = null, lastKey = '', busy = null;
    const open = async (it) => {
      if (!it.openable || busy) return;
      // this widget's own option, not just whether some widget allows it (the agent checks the latter)
      if (o.open !== true || !data?.canOpen) { toast(t('w.feeds.openOff'), 'err'); return; }
      haptic();
      busy = it.id;
      // one deadline for the request and its body, so a stalled answer can't leave the widget refusing taps
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(`${API}/feeds/open?id=${encodeURIComponent(it.id)}`, { method: 'POST', cache: 'no-store', headers: PANEL_HEADERS, signal: ctl.signal });
        const j = await r.json().catch(() => ({}));
        if (r.ok) { toast(t('w.feeds.opening'), 'ok'); markFeedRead(it.id); lastKey = ''; render(); }
        else toast(j.error || t('w.feeds.openFailed'), 'err');
      } catch (_) { toast(t('panel.pcNoAnswer'), 'err'); }
      finally { clearTimeout(timer); busy = null; }
    };
    const render = () => {
      const items = (data?.items || []).filter((i) => !only || i.source.toLowerCase() === only).slice(0, FEEDS_SHOWN);
      const canOpen = o.open === true && !!data?.canOpen;
      const read = feedsRead();
      const key = JSON.stringify([!!data, canOpen, items.map((i) => i.id + (read.has(i.id) ? '.' : '')), data?.errors, Math.floor(Date.now() / 60_000)]);
      if (key === lastKey) return;
      lastKey = key;
      const err = (data?.errors || []).filter((e) => !only || e.toLowerCase().startsWith(only + ':'));
      sub.textContent = err.length ? '⚠' : '';
      sub.title = err.join('\n');
      if (!data) return;
      if (!items.length) {
        list.replaceChildren(h('div', 'empty', err.length ? err[0] : data.updated && (data.items || []).length ? t('w.feeds.noneFrom', { name: o.feed }) : t('w.feeds.addInSettings')));
        return;
      }
      // the list is rebuilt every minute (the ages): keep where it was scrolled to
      const top = list.scrollTop;
      list.replaceChildren(...items.map((it) => {
        const meta = [showSource ? it.source : '', showTime && it.published ? ago(it.published) : ''].filter(Boolean).join(' · ');
        const link = it.openable && canOpen;
        const row = h('div', 'fd-i' + (link ? ' link' + (read.has(it.id) ? ' read' : '') : ''), h('div', 'fd-t', it.title), meta ? h('div', 'fd-m', meta) : null);
        row.onclick = () => open(it);
        return row;
      }));
      list.scrollTop = top;
    };
    const load = every(60_000, async () => {
      try { data = await api('/feeds', 'GET', 5000); lastKey = ''; render(); }
      catch (_) { if (!data) list.replaceChildren(h('div', 'empty', t('w.offline'))); return false; }
    });
    return { update() { load(); render(); } };
  },
};

W.exchange = {
  needs: ['tick'],
  create(box, { o }) {
    const base = (o.base || 'EUR').toUpperCase();
    const syms = lines(o.symbols, ['TRY', 'USD', 'GBP']).map((s) => s.toUpperCase()).slice(0, 8);
    const list = h('div', 'fx-list', h('div', 'empty', t('w.loading')));
    box.append(h('div', 'w-title', `1 ${base}`, h('span', 'w-sub', '')), list);
    const load = every(60 * 60_000, async () => {
      try {
        const from = new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10);
        const d = await cached(`fx:${base}:${syms}`, `https://api.frankfurter.dev/v1/${from}..?base=${base}&symbols=${syms.join(',')}`, 60 * 60_000);
        const days = Object.keys(d.rates || {}).sort();
        if (!days.length) {
          box.querySelector('.w-sub').textContent = '';
          list.replaceChildren(h('div', 'empty', t('w.ratesUnavailable')));
          return false;
        }
        box.querySelector('.w-sub').textContent = 'ECB · ' + days[days.length - 1];
        list.replaceChildren(...syms.map((s) => {
          const series = days.map((k) => d.rates[k]?.[s]).filter((v) => Number.isFinite(v) && v > 0);
          const last = series[series.length - 1], prev = series[series.length - 2];
          const change = prev === undefined ? h('span', 'chg', '—') : pctSpan(((last - prev) / prev) * 100);
          const c = h('canvas', 'fx-sp');
          const row = h('div', 'fx-i', h('b', null, s), h('span', 'fx-v', fmtNum(last)), change, c);
          requestAnimationFrame(() => sparkLine(c, series, last >= series[0] ? '#22c55e' : '#ef4444'));
          return row;
        }));
      } catch (_) { list.replaceChildren(h('div', 'empty', t('w.ratesUnavailable'))); return false; }
    });
    return { update: load };
  },
};

W.crypto = {
  needs: ['tick'],
  create(box, { o }) {
    const coins = lines(o.coins, ['bitcoin', 'ethereum', 'solana']).map((s) => s.toLowerCase()).slice(0, 8);
    const cur = (o.currency || 'usd').toLowerCase();
    const list = h('div', 'fx-list', h('div', 'empty', t('w.loading')));
    box.append(h('div', 'w-title', 'Crypto', h('span', 'w-sub', cur.toUpperCase() + ' · 24 h · 7 d')), list);
    const load = every(5 * 60_000, async () => {
      try {
        const d = await cached(`cg:${cur}:${coins}`, `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${cur}&ids=${coins.join(',')}&sparkline=true&price_change_percentage=24h`, 5 * 60_000);
        list.replaceChildren(...d.map((c) => {
          const cv = h('canvas', 'fx-sp');
          const series = c.sparkline_in_7d?.price || [];
          requestAnimationFrame(() => sparkLine(cv, series, (c.price_change_percentage_24h ?? 0) >= 0 ? '#22c55e' : '#ef4444'));
          return h('div', 'fx-i', h('b', null, (c.symbol || '').toUpperCase()), h('span', 'fx-v', fmtNum(c.current_price)), pctSpan(c.price_change_percentage_24h ?? 0), cv);
        }));
      } catch (_) { list.replaceChildren(h('div', 'empty', t('w.pricesUnavailable'))); return false; }
    });
    return { update: load };
  },
};

W.image = {
  needs: ['tick'],
  create(box, { o }) {
    const url = String(o.url || '');
    const img = h('img', 'im-img');
    img.alt = '';
    img.style.objectFit = o.fit === 'contain' ? 'contain' : 'cover';
    box.append(img);
    if (o.caption) box.append(h('div', 'im-cap', o.caption));
    if (!/^https?:\/\//i.test(url)) { box.replaceChildren(h('div', 'empty', t('w.setImageUrl'))); return {}; }
    img.onerror = () => box.classList.add('err');
    img.onload = () => box.classList.remove('err');
    const mins = Number(o.minutes) || 0;
    const load = every(mins > 0 ? mins * 60_000 : 1e12, () => { img.src = mins > 0 ? url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now() : url; });
    return { update: load };
  },
};

// ---------------------------------------------------------------- web page
// A page in a frame. In the app, a page on the computer or the local network (http://, 127.0.0.1, 192.168.…) can't load
// directly: the app allows plain http only to the phone itself and shows the panel as a secure page. So the app has
// the agent fetch it (WebPageProxy.cs) and shows it under an address of its own,
// https://<hex of "pageId/widgetId">.pcweb.androidplatform.net/<path> (MainActivity.webPage). That origin is not the
// panel's, so the page runs with its own origin (scripts, storage, requests to its own server, which come back through
// the agent) and still can't reach the panel or the bridge. "127.0.0.1" in the address is the computer, not the phone.
export const WEB_HOST = 'pcweb.androidplatform.net'; // MainActivity.WEB_HOST

/** True for an address the phone itself usually can't, or mustn't, load: this computer, the local network, a single name. */
export function localHost(host) {
  const hn = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!hn) return false;
  if (hn === 'localhost' || hn.endsWith('.localhost') || hn.endsWith('.local') || hn.endsWith('.lan') || hn.endsWith('.home.arpa')) return true;
  if (hn === '::1' || /^f[cd][0-9a-f]{2}:/.test(hn) || /^fe[89ab][0-9a-f]:/.test(hn)) return true;
  const ip = hn.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip) {
    const [a, b] = [+ip[1], +ip[2]];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127); // Tailscale
  }
  return !hn.includes('.') && !hn.includes(':'); // a computer's own name on the network
}

/** The frame's address for a widget: the page itself, or (in the app) the page fetched through the computer. */
export function webPageSrc(url, key, via = 'auto', inApp = !!bridge) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const viaPc = inApp && (via === 'pc' || (via !== 'direct' && (u.protocol === 'http:' || localHost(u.hostname))));
  if (!viaPc) return u.href;
  const hex = [...new TextEncoder().encode(key)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `https://${hex.match(/.{1,60}/g).join('.')}.${WEB_HOST}${u.pathname}${u.search}${u.hash}`;
}

W.webpage = {
  needs: ['tick'],
  create(box, { o, page, w }) {
    const src = webPageSrc(o.url, `${page.id}/${w.id}`, o.via);
    if (!src) { box.replaceChildren(h('div', 'empty', t('w.setWebUrl'))); return {}; }
    const zoom = Math.max(25, Math.min(300, Number(o.zoom) || 100)) / 100;
    const frame = h('iframe', 'web-frame');
    // allow-same-origin gives the page its own origin (never the panel's: it is another host), so its scripts can use
    // storage and talk to their own server
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    if (zoom !== 1) {
      frame.style.width = frame.style.height = `${100 / zoom}%`;
      frame.style.transform = `scale(${zoom})`;
    }
    // by default the page only shows: taps and swipes stay with the panel, so swiping still changes pages
    if (!o.interactive) frame.classList.add('web-still');
    box.append(frame);
    const mins = Number(o.minutes) || 0;
    // setting src again reloads the page, also when the address is the same
    const load = every(mins > 0 ? mins * 60_000 : 1e12, () => { frame.src = src; });
    return { update: load };
  },
};
