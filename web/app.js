/* Halo - Xiaomi BE6500 Pro remote.
   Inside the iPhone app, window.webkit.messageHandlers.halo talks to the router (native side does HTTP + login).
   Opened in a normal browser, the page runs on demo data. */
'use strict';
const $ = s => document.querySelector(s);
const BR = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.halo;
const LIVE = !!BR;

const svg = (p, sw = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  tablet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/>',
  laptop: '<rect x="5" y="5" width="14" height="10" rx="1"/><path d="M3 19h18"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v3"/>',
  game: '<rect x="3" y="8" width="18" height="9" rx="4.5"/><path d="M8 11v3M6.5 12.5h3M15.5 12h.01M17.5 13.5h.01"/>',
  speaker: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="14" r="3"/><path d="M12 7h.01"/>',
  router: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 13V9M17 13V9M7 16.5h.01"/>'
};
const CHK = svg('<path d="M5 12l5 5 9-10"/>', 2.5).replace('<svg', '<svg class="chk"');
const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 6l-6 6 6 6"/></svg>';
const DAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- storage (per phone) ---------- */
/* in the app, values live in iOS settings (injected as window.__haloStore at load); in a browser, in localStorage */
const store = {
  get(k, d) {
    try {
      if (LIVE) { const v = (window.__haloStore || {})[k]; return v === undefined ? d : JSON.parse(v); }
      const v = localStorage.getItem('halo.' + k); return v == null ? d : JSON.parse(v);
    } catch (e) { return d; }
  },
  set(k, v) {
    const j = JSON.stringify(v);
    if (LIVE) { window.__haloStore = window.__haloStore || {}; window.__haloStore[k] = j; BR.postMessage({ action: 'kvSet', key: k, value: j }).catch(() => {}); return; }
    try { localStorage.setItem('halo.' + k, j); } catch (e) {}
  }
};
let nicks = store.get('nicks', {});          // mac -> name
let known = store.get('known', null);        // macs seen before
let prefs = store.get('prefs', {});          // mac -> {prio, lim}

/* ---------- native bridge ---------- */
async function native(action, data = {}) {
  const r = await BR.postMessage(Object.assign({ action }, data));
  return r ? JSON.parse(r) : null;
}
async function api(path, params = {}, method = 'GET') {
  const j = await native('api', { path, params, method });
  if (!j || (j.code !== 0 && j.code !== undefined)) {
    const e = new Error((j && (j.msg || j.message)) || ('code ' + (j && j.code)));
    e.code = j && j.code; throw e;
  }
  return j;
}
const errText = e => {
  const m = String(e && e.message || e);
  if (m.includes('offline')) return 'לא מחובר ל-Wi-Fi של הבית';
  if (m.includes('badPassword')) return 'סיסמת הנתב שגויה';
  if (m.includes('noPassword')) return 'צריך להתחבר לנתב';
  if (m.includes('timeout')) return 'הנתב לא ענה בזמן';
  return 'הנתב החזיר שגיאה: ' + m;
};

/* ---------- state ---------- */
let devs = [], schs = store.get('schs', null), filter = 'all', profile = store.get('profile', 'norm');
let wifi = { ssid: 'Elior_Home', pw: 'Asif2026!home', ch: '2.4: 6 · 5: 36 · 160MHz', tx: 'max', on: true, guestSsid: 'Elior_Guest', guestPw: 'welcome2026' };
let online = true, shown = false, paused = false, gDur = 4;
let lastStatus = null, lastNet = null;

function guessType(name, band) {
  const n = (name || '').toLowerCase();
  if (/ipad|tab|kindle/.test(n)) return 'tablet';
  if (/iphone|galaxy|phone|pixel|redmi|xiaomi|android|oneplus|huawei|honor/.test(n)) return 'phone';
  if (/tv|chromecast|roku|bravia|webos|tizen|apple-tv|shield/.test(n)) return 'tv';
  if (/ps[345]|playstation|xbox|switch|nintendo/.test(n)) return 'game';
  if (/plug|tuya|esp|smart|switcher|sensor|ewelink|sonoff|shelly|breeze|ember/.test(n)) return 'plug';
  if (/echo|alexa|home|nest|speaker|sonos|homepod/.test(n)) return 'speaker';
  if (/router|mesh|xiaomi-router/.test(n)) return 'router';
  return band === 'cable' ? 'laptop' : 'phone';
}
const BAND = { 0: 'cable', 1: '2.4', 2: '5', 3: 'guest', 6: '5' };
const bandText = b => ({ cable: 'כבל', '2.4': '2.4 GHz', '5': '5 GHz', guest: 'רשת אורחים' }[b] || '');
const fmtRate = bps => { const m = bps / 1e6; return m >= 1 ? m.toFixed(1) + ' MB/s' : bps >= 1000 ? Math.round(bps / 1000) + ' KB/s' : ''; };
const fmtBytes = b => { b = +b || 0; if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB'; if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'; if (b >= 1e6) return Math.round(b / 1e6) + ' MB'; return Math.round(b / 1e3) + ' KB'; };
const fmtUp = s => { s = Math.floor(+s || 0); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const devName = d => nicks[d.mac] || d.n;

/* demo data */
function demoDevs() {
  return [
    { mac: 'A4:83:E7:1C:22:9F', n: 'iPhone של אליאור', band: '5', ip: '192.168.31.20', r: 12.4e6, tot: 6.2e9, online: true, blocked: false },
    { mac: 'F0:18:98:4A:11:03', n: 'iPad של אסיף', band: '5', ip: '192.168.31.24', r: 3.1e6, tot: 2.8e9, online: true, blocked: false },
    { mac: '70:2A:D5:90:6B:12', n: 'טלוויזיה סלון', band: 'cable', ip: '192.168.31.30', r: 8.7e6, tot: 5.1e9, online: true, blocked: false, t: 'tv' },
    { mac: 'D8:BB:C1:07:5E:44', n: 'מחשב עבודה', band: 'cable', ip: '192.168.31.10', r: 21e6, tot: 3.9e9, online: true, blocked: false, t: 'laptop' },
    { mac: '84:72:07:3D:A0:19', n: 'Breeze - מזגן', band: '2.4', ip: '192.168.31.51', r: 0, tot: 4e6, online: true, blocked: false, t: 'plug' },
    { mac: 'C4:5B:BE:62:91:7A', n: 'Ember - דוד', band: '2.4', ip: '192.168.31.52', r: 0, tot: 2e6, online: true, blocked: false, t: 'plug' },
    { mac: '50:EC:50:11:C2:8D', n: 'רמקול חכם', band: '2.4', ip: '192.168.31.60', r: 300e3, tot: 140e6, online: true, blocked: false, t: 'speaker' },
    { mac: '00:D9:D1:5A:7E:20', n: 'PlayStation', band: '5', ip: '192.168.31.40', r: 0, tot: 0, online: true, blocked: true, t: 'game' },
    { mac: '9C:2E:A1:40:B3:6E', n: 'Galaxy-A54', band: '2.4', ip: '192.168.31.77', r: 800e3, tot: 45e6, online: true, blocked: false, isNew: true, t: 'phone' }
  ];
}

/* ---------- ui helpers ---------- */
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2400); }
function sw(el, cb) { el.addEventListener('click', () => { const v = el.getAttribute('aria-checked') !== 'true'; el.setAttribute('aria-checked', v); cb && cb(v, el); }); }
const soon = () => toast('התכונה הזו תחובר לנתב בשלב הבא');
function openSheet(html, mount) { $('#sheet').innerHTML = html; $('#scrim').hidden = false; mount && mount($('#sheet')); }
function closeSheet() { $('#scrim').hidden = true; }
$('#scrim').addEventListener('click', e => { if (e.target.id === 'scrim' && !$('#scrim').dataset.lock) closeSheet(); });
function segHtml(id, opts, cur) { return `<div class="seg" id="${id}">${opts.map(o => `<button data-v="${o[0]}" aria-pressed="${String(o[0]) === String(cur)}">${o[1]}</button>`).join('')}</div>`; }
function bindSeg(root, id, cb) { root.querySelectorAll('#' + id + ' button').forEach(b => b.onclick = () => { root.querySelectorAll('#' + id + ' button').forEach(x => x.setAttribute('aria-pressed', x === b)); cb(b.dataset.v); }); }
function copy(t) { (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('הועתק'), () => toast('ההעתקה לא זמינה כאן')); }

/* switches without their own logic */
document.querySelectorAll('.sw:not([id])').forEach(s => sw(s, (v, el) => {
  if (LIVE) { el.setAttribute('aria-checked', !v); soon(); return; }
  toast(el.getAttribute('aria-label') + (v ? ' הופעל' : ' כובה'));
}));

/* ---------- connection status ---------- */
function setNet(state, text) {
  const n = $('#net'); n.className = 'net' + (state === 'ok' ? '' : state === 'warn' ? ' warn' : ' off');
  n.lastChild.textContent = text;
}
function setMode() {
  const p = $('#modePill');
  if (!LIVE) return;
  p.innerHTML = `<span class="dot" style="background:${online ? 'var(--ok)' : 'var(--off)'}"></span>${online ? 'BE6500 Pro' : 'לא בבית'}`;
  $('#modeNote').innerHTML = 'מחובר לנתב בבית. תכונות שמסומנות "בשלב הבא" עוד לא נשלחות לנתב.';
}
if (LIVE) document.querySelectorAll('[data-demo]').forEach(e => e.hidden = true);

/* ---------- live traffic ---------- */
const N = 40;
let dd = Array(N).fill(0), ud = Array(N).fill(0);
if (!LIVE) { dd = dd.map(() => 300 + Math.random() * 120); ud = ud.map(() => 25 + Math.random() * 15); }
function path(a, max) { return a.map((v, i) => `${i ? 'L' : 'M'}${(300 - i * 300 / (N - 1)).toFixed(1)},${(46 - v / max * 42).toFixed(1)}`).join(''); }
function drawSpark() {
  const max = Math.max(LIVE ? 50 : 600, ...dd, ...ud.map(v => v * 5)) * 1.05; const p = path(dd, max);
  $('#sl').setAttribute('d', p); $('#sa').setAttribute('d', p + 'L0,46L300,46Z'); $('#su').setAttribute('d', path(ud.map(v => v * 5), max));
  $('#down').textContent = dd[0] >= 10 ? Math.round(dd[0]) : dd[0].toFixed(1); $('#up').textContent = ud[0] >= 10 ? Math.round(ud[0]) : ud[0].toFixed(1);
  $('#arc').style.strokeDashoffset = 314 - 314 * Math.min(dd[0] / 1000, 1) * 0.92 - 8;
}
function pushTraffic(d, u) { dd.unshift(d); dd.pop(); ud.unshift(u); ud.pop(); drawSpark(); }
drawSpark();

/* tabs */
document.querySelectorAll('nav.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav.tabs button').forEach(x => x.classList.toggle('on', x === b));
  if (b.dataset.go === 'app') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const el = document.getElementById(b.dataset.go); if (b.dataset.go === 'more') el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---------- profiles (kept on the phone for now) ---------- */
const PROF = [['norm', 'רגיל', 'מאוזן לכולם', '<path d="M4 10a12 12 0 0 1 16 0"/><path d="M7.5 13.5a7 7 0 0 1 9 0"/><circle cx="12" cy="17.5" r="1"/>'],
  ['game', 'גיימינג', 'עדיפות לקונסולה', '<rect x="3" y="8" width="18" height="9" rx="4.5"/><path d="M8 11v3M6.5 12.5h3"/>'],
  ['work', 'עבודה', 'עדיפות למחשב', '<rect x="5" y="5" width="14" height="10" rx="1"/><path d="M3 19h18"/>'],
  ['night', 'לילה', 'נורית כבויה, חיסכון', '<path d="M20 14A8 8 0 1 1 10 4a7 7 0 0 0 10 10z"/>']];
function renderProf() {
  $('#profiles').innerHTML = PROF.map(p => `<button class="prof" data-p="${p[0]}" aria-pressed="${profile === p[0]}">${svg(p[3])}${p[1]}<small>${p[2]}</small></button>`).join('');
  document.querySelectorAll('.prof').forEach(b => b.onclick = () => {
    if (LIVE) { soon(); return; }
    profile = b.dataset.p; store.set('profile', profile); renderProf(); toast('מצב "' + PROF.find(x => x[0] === profile)[1] + '" הופעל');
  });
}
renderProf();

/* ---------- devices ---------- */
const FIL = [['all', 'הכל'], ['on', 'מחוברים'], ['wifi', 'Wi-Fi'], ['lan', 'כבל'], ['blk', 'חסומים']];
function renderDevs() {
  $('#filters').innerHTML = FIL.map(f => `<button class="chip" data-f="${f[0]}" aria-pressed="${filter === f[0]}">${f[1]}</button>`).join('');
  document.querySelectorAll('#filters .chip').forEach(b => b.onclick = () => { filter = b.dataset.f; renderDevs(); });
  const list = devs.filter(d => filter === 'all' || (filter === 'on' && d.online && !d.blocked) || (filter === 'blk' && d.blocked) || (filter === 'wifi' && d.band !== 'cable') || (filter === 'lan' && d.band === 'cable'))
    .sort((a, b) => (b.online - a.online) || (b.r - a.r));
  $('#devs').innerHTML = list.length ? list.map(d => {
    const p = prefs[d.mac] || {}; const t = d.t || guessType(d.n, d.band);
    return `<button class="row ${d.blocked || !d.online ? 'blk' : ''}" data-mac="${esc(d.mac)}"><div class="ic ${d.blocked ? 'bad' : ''}">${svg(IC[t])}</div><div class="t"><b>${esc(devName(d))}</b><small>${d.blocked ? '<span class="tag bad">חסום</span>' : d.online ? bandText(d.band) : 'לא מחובר'}${p.prio ? '<span class="tag acc">עדיפות</span>' : ''}${p.lim ? `<span class="tag hot">${p.lim} Mbps</span>` : ''}${d.isNew ? '<span class="tag hot">חדש</span>' : ''}</small></div><span class="v">${d.online && !d.blocked ? fmtRate(d.r) : ''}</span>${CHEV}</button>`;
  }).join('') : `<div class="row" style="color:var(--muted)">${LIVE && !devs.length ? 'טוען מכשירים...' : 'אין מכשירים בסינון הזה'}</div>`;
  document.querySelectorAll('#devs .row[data-mac]').forEach(r => r.onclick = () => devSheet(r.dataset.mac));
  const on = devs.filter(d => d.online).length; $('#devTitle').textContent = `מכשירים · ${on} מחוברים`; $('#cnt').textContent = on;
}
function checkNew() {
  const macs = devs.map(d => d.mac);
  if (known === null) { known = macs; store.set('known', known); return; }   // first run: everything is "known"
  const fresh = devs.filter(d => !known.includes(d.mac) && d.online);
  if (fresh.length) {
    const d = fresh[0]; d.isNew = true;
    $('#newDev .bt').innerHTML = `<b>${esc(devName(d))} התחבר</b><small>מכשיר חדש · ${bandText(d.band) || 'ברשת'}</small>`;
    $('#newDev').hidden = false;
  }
}
$('#ndNo').onclick = () => {
  devs.forEach(d => d.isNew = false); if (known) { known = [...new Set([...known, ...devs.map(d => d.mac)])]; store.set('known', known); }
  $('#newDev').hidden = true; renderDevs();
};
$('#pauseAll').onclick = e => { if (LIVE) { soon(); return; } paused = !paused; e.target.textContent = paused ? 'חדש הכל' : 'השהה הכל'; toast(paused ? 'האינטרנט הושהה לכל המכשירים חוץ ממך' : 'האינטרנט חזר לכולם'); };

async function setBlocked(d, blocked) {
  if (!LIVE) { d.blocked = blocked; renderDevs(); return true; }
  try {
    await api('xqsystem/set_mac_filter', { mac: d.mac, wan: blocked ? '0' : '1' });
    d.blocked = blocked; renderDevs(); setTimeout(loadDevices, 1500); return true;
  } catch (e) { toast(errText(e)); return false; }
}

function devSheet(mac) {
  const d = devs.find(x => x.mac === mac); if (!d) return; const p = Object.assign({ prio: false, lim: 0 }, prefs[mac]);
  let st = { blocked: d.blocked, prio: p.prio, lim: p.lim };
  openSheet(`<h3>${esc(devName(d))}</h3>
  <div class="field"><label for="dn">שם</label><input type="text" id="dn" value="${esc(devName(d))}"></div>
  <div class="group">
   <div class="row"><div class="t"><b>גישה לאינטרנט</b></div><button class="sw" role="switch" id="dOn" aria-checked="${!d.blocked}" aria-label="גישה"></button></div>
   <div class="row"><div class="t"><b>עדיפות במהירות</b><small>QoS - קודם לכל השאר${LIVE ? ' · בשלב הבא' : ''}</small></div><button class="sw" role="switch" id="dPr" aria-checked="${p.prio}" aria-label="עדיפות"></button></div>
  </div>
  <div class="lbl">הגבלת מהירות${LIVE ? ' · בשלב הבא' : ''}</div>
  ${segHtml('dLim', [[0, 'ללא'], [10, '10'], [50, '50'], [100, '100 Mbps']], p.lim)}
  <div class="group">
   <div class="kv"><span>כתובת IP</span><span>${esc(d.ip || '-')}</span></div>
   <div class="kv"><span>MAC</span><span>${esc(d.mac)}</span></div>
   <div class="kv"><span>חיבור</span><span>${bandText(d.band) || '-'}</span></div>
   <div class="kv"><span>מהירות עכשיו</span><span>${fmtRate(d.r) || '0'}</span></div>
   <div class="kv"><span>תעבורה מאז החיבור</span><span>${fmtBytes(d.tot)}</span></div>
   ${d.n !== devName(d) ? `<div class="kv"><span>שם מקורי</span><span>${esc(d.n)}</span></div>` : ''}
  </div>
  <div class="btns"><button class="btn" id="dCancel">ביטול</button><button class="btn pri" id="dSave">שמור</button></div>`,
    r => {
      sw(r.querySelector('#dOn'), v => st.blocked = !v);
      sw(r.querySelector('#dPr'), v => st.prio = v);
      bindSeg(r, 'dLim', v => st.lim = +v);
      r.querySelector('#dCancel').onclick = closeSheet;
      r.querySelector('#dSave').onclick = async () => {
        const nm = r.querySelector('#dn').value.trim();
        if (nm && nm !== d.n) nicks[mac] = nm; else delete nicks[mac];
        store.set('nicks', nicks);
        prefs[mac] = { prio: st.prio, lim: st.lim }; store.set('prefs', prefs);
        if (st.blocked !== d.blocked) {
          const ok = await setBlocked(d, st.blocked);
          if (ok) toast(st.blocked ? devName(d) + ' נחסם' : 'הגישה של ' + devName(d) + ' חזרה');
        } else toast('נשמר');
        renderDevs(); renderSch(); closeSheet();
      };
    });
}

/* ---------- schedules (kept on the phone for now) ---------- */
if (!schs) schs = LIVE ? [] : [
  { id: 1, from: '22:00', to: '07:00', days: [0, 1, 2, 3, 4], devs: ['F0:18:98:4A:11:03'], mode: 'off', on: true },
  { id: 2, from: '20:30', to: '23:00', days: [0, 1, 2, 3, 4, 5, 6], devs: ['00:D9:D1:5A:7E:20'], mode: 'lim', on: true }];
function renderSch() {
  $('#schs').innerHTML = schs.length ? schs.map(s => `<div class="row ${s.on ? '' : 'dis'}" data-id="${s.id}"><span class="tm">${s.from}-${s.to}</span><div class="info"><span class="act ${s.mode === 'lim' ? 'lim' : ''}"><i></i>${s.mode === 'off' ? 'אינטרנט כבוי' : 'מוגבל ל-5 Mbps'}</span><span class="days">${DAYS.map((x, i) => `<i class="${s.days.includes(i) ? 'on' : ''}">${x}</i>`).join('')}</span><span class="tags">${s.devs.map(m => { const d = devs.find(x => x.mac === m); return `<span class="tag">${esc(d ? devName(d) : (nicks[m] || m))}</span>`; }).join('')}</span></div><button class="sw" role="switch" aria-checked="${s.on}" aria-label="הפעלת זמן גלישה"></button></div>`).join('')
    : `<div class="row" style="color:var(--muted)">אין זמני גלישה. הוסף כדי להגביל מכשירים בשעות מסוימות.</div>`;
  document.querySelectorAll('#schs .row[data-id]').forEach(r => {
    const s = schs.find(x => x.id === +r.dataset.id);
    r.querySelector('.sw').onclick = e => { e.stopPropagation(); s.on = !s.on; store.set('schs', schs); renderSch(); toast(s.on ? 'זמן הגלישה הופעל' : 'זמן הגלישה כובה'); };
    r.onclick = () => schSheet(s);
  });
}
function schSheet(s) {
  const isNew = !s; s = s ? Object.assign({}, s, { days: [...s.days], devs: [...s.devs] }) : { id: Date.now(), from: '21:00', to: '07:00', days: [0, 1, 2, 3, 4], devs: [], mode: 'off', on: true };
  openSheet(`<h3>${isNew ? 'זמן גלישה חדש' : 'עריכת זמן גלישה'}</h3>
  ${LIVE ? '<p>נשמר בטלפון. השליחה לנתב תחובר בשלב הבא.</p>' : ''}
  ${segHtml('sMode', [['off', 'אינטרנט כבוי'], ['lim', 'מהירות מוגבלת']], s.mode)}
  <div class="trow"><label for="sf">מ-</label><input type="time" id="sf" value="${s.from}"></div>
  <div class="trow"><label for="st">עד</label><input type="time" id="st" value="${s.to}"></div>
  <div class="lbl">ימים</div>
  <div class="dpick" id="sDays">${DAYS.map((x, i) => `<button data-i="${i}" aria-pressed="${s.days.includes(i)}">${x}</button>`).join('')}</div>
  <div class="lbl">מכשירים</div>
  <div class="opts" id="sDevs">${devs.map(d => `<button class="opt" data-mac="${esc(d.mac)}" aria-pressed="${s.devs.includes(d.mac)}"><span>${esc(devName(d))}</span>${CHK}</button>`).join('')}</div>
  <div class="btns">${isNew ? '' : '<button class="btn del" id="sDel">מחק</button>'}<button class="btn pri" id="sSave">שמור</button></div>`,
    r => {
      bindSeg(r, 'sMode', v => s.mode = v);
      r.querySelectorAll('#sDays button').forEach(b => b.onclick = () => { const i = +b.dataset.i; s.days = s.days.includes(i) ? s.days.filter(x => x !== i) : [...s.days, i].sort(); b.setAttribute('aria-pressed', s.days.includes(i)); });
      r.querySelectorAll('#sDevs .opt').forEach(b => b.onclick = () => { const m = b.dataset.mac; s.devs = s.devs.includes(m) ? s.devs.filter(x => x !== m) : [...s.devs, m]; b.setAttribute('aria-pressed', s.devs.includes(m)); });
      const del = r.querySelector('#sDel'); if (del) del.onclick = () => { schs = schs.filter(x => x.id !== s.id); store.set('schs', schs); renderSch(); closeSheet(); toast('נמחק'); };
      r.querySelector('#sSave').onclick = () => {
        s.from = r.querySelector('#sf').value; s.to = r.querySelector('#st').value;
        if (!s.devs.length) { toast('בחר לפחות מכשיר אחד'); return; } if (!s.days.length) { toast('בחר לפחות יום אחד'); return; }
        if (isNew) schs.push(s); else schs[schs.findIndex(x => x.id === s.id)] = s; store.set('schs', schs); renderSch(); closeSheet(); toast('זמן הגלישה נשמר');
      };
    });
}
$('#addSch').onclick = () => schSheet(null);

/* ---------- speed test ---------- */
$('#speedBtn').onclick = () => {
  openSheet(`<h3>בדיקת מהירות</h3><p id="spP">${LIVE ? 'מודד מהטלפון דרך ה-Wi-Fi...' : 'מודד הורדה...'}</p><div class="bigv"><span id="spV">0</span> <small>Mbps</small></div><div class="prog"><i id="spG"></i></div><div class="res"><div class="stat"><b id="r1">-</b><span>הורדה</span></div><div class="stat"><b id="r2">-</b><span>העלאה</span></div><div class="stat"><b id="r3">-</b><span>פינג ms</span></div></div><button class="btn" id="spClose">סגור</button>`,
    async r => {
      r.querySelector('#spClose').onclick = closeSheet;
      const g = r.querySelector('#spG'), v = r.querySelector('#spV'), P = r.querySelector('#spP');
      if (LIVE) {
        try {
          g.style.width = '8%'; const pg = await native('speed', { phase: 'ping' }); r.querySelector('#r3').textContent = Math.round(pg.ms); $('#ping').textContent = Math.round(pg.ms);
          P.textContent = 'מודד הורדה...'; g.style.width = '20%'; let fake = setInterval(() => v.textContent = Math.round(Math.random() * 50 + (+v.textContent || 0) * 0.98), 200);
          const dn = await native('speed', { phase: 'down' }); clearInterval(fake); v.textContent = Math.round(dn.mbps); r.querySelector('#r1').textContent = Math.round(dn.mbps);
          P.textContent = 'מודד העלאה...'; g.style.width = '60%';
          const up = await native('speed', { phase: 'up' }); v.textContent = Math.round(up.mbps); r.querySelector('#r2').textContent = Math.round(up.mbps);
          g.style.width = '100%'; P.textContent = 'הבדיקה הסתיימה. זו המהירות שמגיעה לטלפון, לא לכבל של הנתב.'; v.textContent = Math.round(dn.mbps);
        } catch (e) { P.textContent = 'הבדיקה נכשלה: ' + errText(e); }
        return;
      }
      let t = 0; const D = 880 + Math.round(Math.random() * 90), U = 92 + Math.round(Math.random() * 8);
      const h = setInterval(() => {
        t++; if (!document.body.contains(g)) { clearInterval(h); return; }
        g.style.width = (t * 5) + '%';
        if (t <= 10) v.textContent = Math.round(D * (t / 10) * (0.85 + Math.random() * .2));
        else if (t === 11) { r.querySelector('#r1').textContent = D; P.textContent = 'מודד העלאה...'; }
        else if (t <= 19) v.textContent = Math.round(U * ((t - 10) / 9) * (0.85 + Math.random() * .2));
        else { clearInterval(h); v.textContent = D; r.querySelector('#r2').textContent = U; r.querySelector('#r3').textContent = 6; P.textContent = 'הבדיקה הסתיימה'; }
      }, 220);
    });
};

/* ---------- reboot ---------- */
$('#rebootBtn').onclick = () => openSheet(`<h3>להפעיל את הנתב מחדש?</h3><p>כל המכשירים יתנתקו לכ-2 דקות, כולל המזגנים והדוד.</p><div class="btns"><button class="btn" id="rbNo">ביטול</button><button class="btn dz" id="rbYes">הפעל מחדש</button></div>`,
  r => {
    r.querySelector('#rbNo').onclick = closeSheet;
    r.querySelector('#rbYes').onclick = async () => {
      closeSheet();
      if (LIVE) { try { await api('xqsystem/reboot', { client: 'web' }); } catch (e) { toast(errText(e)); return; } }
      setNet('warn', 'הנתב עולה מחדש...'); toast('הנתב מופעל מחדש'); rebooting = Date.now();
      if (!LIVE) setTimeout(() => { setNet('ok', 'מחובר לאינטרנט'); toast('הנתב חזר לפעולה'); }, 5000);
    };
  });
let rebooting = 0;

/* ---------- wifi ---------- */
const TX = { max: 'חזקה', mid: 'רגילה', min: 'חיסכון' };
function renderWifi() {
  $('#ssid').textContent = wifi.ssid; $('#pw').textContent = shown ? wifi.pw : '••••••••••';
  $('#chV').textContent = wifi.ch; $('#txV').textContent = TX[wifi.tx] || wifi.tx;
  $('#wMain').setAttribute('aria-checked', wifi.on);
  $('#gName').textContent = wifi.guestSsid;
}
$('#wMain').addEventListener('click', e => {
  e.stopImmediatePropagation();
  const turnOff = $('#wMain').getAttribute('aria-checked') === 'true';
  if (!turnOff) { toast('הרשת כבר פעילה'); return; }
  openSheet(`<h3>לכבות את ה-Wi-Fi?</h3><p>הטלפון יתנתק מהנתב ולא תוכל להדליק אותה שוב מהאפליקציה. רק דרך כבל או כפתור בנתב.</p><div class="btns"><button class="btn" id="wNo">ביטול</button><button class="btn dz" id="wYes">כבה</button></div>`,
    r => { r.querySelector('#wNo').onclick = closeSheet; r.querySelector('#wYes').onclick = async () => { closeSheet(); if (LIVE) { soon(); return; } wifi.on = false; renderWifi(); toast('הרשת הראשית כובתה'); }; });
}, true);
sw($('#wMlo'), (v, el) => { if (LIVE) { el.setAttribute('aria-checked', !v); soon(); return; } toast(v ? 'MLO הופעל' : 'MLO כובה'); });
function setGuest(v) { $('#wGuest').setAttribute('aria-checked', v); $('#guestBtn').setAttribute('aria-pressed', v); $('#gSub').textContent = v ? (gDur ? `פעילה · נכבית בעוד ${gDur} שעות` : 'פעילה · ללא הגבלה') : 'כבויה'; }
sw($('#wGuest'), (v, el) => { if (LIVE) { el.setAttribute('aria-checked', !v); soon(); return; } setGuest(v); toast(v ? 'רשת האורחים הופעלה' : 'רשת האורחים כובתה'); });
$('#guestBtn').onclick = () => { if (LIVE) { soon(); return; } const v = $('#guestBtn').getAttribute('aria-pressed') !== 'true'; setGuest(v); toast(v ? 'רשת האורחים הופעלה' : 'רשת האורחים כובתה'); };
$('#pwShow').onclick = e => { shown = !shown; renderWifi(); e.target.textContent = shown ? 'הסתר' : 'הצג'; };
$('#pwCopy').onclick = () => copy(wifi.pw);
function qrSvg(text) {
  if (!window.qrcode) return 'QR';
  const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
}
const wifiEsc = t => String(t).replace(/([\\;,:"])/g, '\\$1');
$('#qrBtn').onclick = () => openSheet(`<h3>שיתוף Wi-Fi</h3><p>האורח מכוון מצלמה לקוד ומתחבר בלי להקליד סיסמה.</p>${LIVE ? '' : segHtml('qNet', [['main', 'רשת ראשית'], ['guest', 'רשת אורחים']], 'main')}<div class="qr" id="qr"></div><div class="group"><div class="kv"><span>רשת</span><span id="qS"></span></div><div class="kv"><span>סיסמה</span><span id="qP"></span></div></div><button class="btn" id="qClose">סגור</button>`,
  r => {
    const make = (s, p) => { r.querySelector('#qr').innerHTML = qrSvg(`WIFI:T:WPA;S:${wifiEsc(s)};P:${wifiEsc(p)};;`); const el = r.querySelector('#qr svg'); if (el) { el.style.width = '192px'; el.style.height = '192px'; } r.querySelector('#qS').textContent = s; r.querySelector('#qP').textContent = p; };
    make(wifi.ssid, wifi.pw); if (!LIVE) bindSeg(r, 'qNet', v => make(v === 'main' ? wifi.ssid : wifi.guestSsid, v === 'main' ? wifi.pw : wifi.guestPw));
    r.querySelector('#qClose').onclick = closeSheet;
  });
function optSheet(title, opts, cur, cb) {
  openSheet(`<h3>${title}</h3><div class="opts">${opts.map(o => `<button class="opt" data-v="${o[0]}" aria-pressed="${String(o[0]) === String(cur)}"><span>${o[1]}${o[2] ? `<small>${o[2]}</small>` : ''}</span>${CHK}</button>`).join('')}</div>`,
    r => r.querySelectorAll('.opt').forEach(b => b.onclick = () => { cb(b.dataset.v); closeSheet(); }));
}
$('#txBtn').onclick = () => optSheet('עוצמת שידור', [['max', 'חזקה', 'כיסוי מקסימלי בכל הבית'], ['mid', 'רגילה', 'איזון בין כיסוי לחשמל'], ['min', 'חיסכון', 'לדירה קטנה, פחות קרינה']], wifi.tx, v => { if (LIVE) { soon(); return; } wifi.tx = v; renderWifi(); toast('עוצמה: ' + TX[v]); });
$('#gDurBtn').onclick = () => optSheet('כיבוי אוטומטי לרשת אורחים', [[1, 'אחרי שעה'], [4, 'אחרי 4 שעות'], [24, 'אחרי יום'], [0, 'ללא הגבלה']], gDur, v => { if (LIVE) { soon(); return; } gDur = +v; $('#gDurV').textContent = gDur ? (gDur === 1 ? 'אחרי שעה' : gDur === 24 ? 'אחרי יום' : 'אחרי 4 שעות') : 'ללא הגבלה'; setGuest($('#wGuest').getAttribute('aria-checked') === 'true'); });
$('#chOpt').onclick = e => { if (LIVE) { soon(); return; } e.target.textContent = 'סורק...'; setTimeout(() => { e.target.textContent = 'אופטימיזציה'; $('#chV').textContent = '2.4: 11 · 5: 149 · 160MHz'; toast('נבחרו ערוצים פנויים יותר'); }, 1800); };
$('#meshAdd').onclick = () => toast('הנח נתב Xiaomi נוסף ליד הנתב ולחץ על כפתור Mesh');
$('#fwBtn').onclick = e => { if (LIVE) { soon(); return; } e.target.textContent = 'בודק...'; setTimeout(() => { e.target.textContent = 'בדוק'; toast('הקושחה עדכנית'); }, 1500); };

/* ---------- router details sheet ---------- */
function netSheet() {
  const s = lastStatus || {}, n = lastNet || {}, hw = s.hardware || {};
  const ip = n.ip && (n.ip.address || n.ip.ip) || (LIVE ? '-' : '84.110.27.193');
  const dns = n.dns ? [].concat(n.dns).join(', ') : (LIVE ? '-' : '1.1.1.1');
  openSheet(`<h3>פרטי חיבור</h3><div class="group">
   <div class="kv"><span>דגם</span><span>Xiaomi BE6500 Pro${hw.platform ? ' (' + esc(hw.platform) + ')' : ''}</span></div>
   <div class="kv"><span>IP ציבורי</span><span>${esc(ip)}</span></div>
   <div class="kv"><span>שער</span><span>${esc(n.gw || (LIVE ? '-' : '84.110.27.1'))}</span></div>
   <div class="kv"><span>DNS</span><span>${esc(dns)}</span></div>
   <div class="kv"><span>סוג חיבור</span><span>${esc(n.proto || (LIVE ? '-' : 'PPPoE'))}</span></div>
   <div class="kv"><span>כתובת הנתב</span><span>192.168.31.1</span></div>
   <div class="kv"><span>זמן פעולה</span><span>${s.upTime ? fmtUp(s.upTime) : (LIVE ? '-' : '6d 14h')}</span></div>
   <div class="kv"><span>קושחה</span><span>${esc(hw.version || (LIVE ? '-' : '1.0.42'))}</span></div></div>
   ${LIVE ? '<div class="btns"><button class="btn" id="nDiag">בדיקת חיבור</button><button class="btn del" id="nOut">התנתק</button></div>' : '<p>נתוני הדגמה. באפליקציה יוצגו פרטי הנתב שלך.</p>'}
   <button class="btn" id="nClose">סגור</button>`, r => {
    r.querySelector('#nClose').onclick = closeSheet;
    const o = r.querySelector('#nOut'); if (o) o.onclick = async () => { await native('logout'); closeSheet(); loginSheet(); };
    const dg = r.querySelector('#nDiag'); if (dg) dg.onclick = diagSheet;
  });
}
$('#menu').onclick = netSheet;

/* diagnostics: raw answers from the router, to send to Claude when something is off */
async function diagSheet() {
  openSheet(`<h3>בדיקת חיבור</h3><p>התשובות של הנתב, בלי סיסמאות. אפשר להעתיק ולשלוח.</p><div class="raw" id="raw">בודק...</div><div class="btns"><button class="btn" id="rCopy">העתק</button><button class="btn pri" id="rClose">סגור</button></div>`, r => { r.querySelector('#rClose').onclick = closeSheet; });
  const paths = ['misystem/status', 'misystem/devicelist', 'xqnetwork/wifi_detail_all', 'xqnetwork/pppoe_status', 'xqnetwork/wan_info', 'misystem/qos_info', 'xqnetwork/get_guest_wifi', 'xqsystem/get_mac_filter'];
  let out = '';
  for (const p of paths) {
    try { const j = await native('api', { path: p, params: {}, method: 'GET' }); out += `## ${p}\n${JSON.stringify(j).replace(/"(password|pwd|key|psk)":"[^"]*"/gi, '"$1":"***"').slice(0, 1500)}\n\n`; }
    catch (e) { out += `## ${p}\nERROR ${e.message}\n\n`; }
    const raw = $('#raw'); if (raw) raw.textContent = out;
  }
  const c = $('#rCopy'); if (c) c.onclick = () => copy(out);
}

/* ---------- login ---------- */
function loginSheet(msg) {
  $('#scrim').dataset.lock = '1';
  openSheet(`<h3>התחברות לנתב</h3><p>הסיסמה של ממשק הניהול של הנתב (לא של ה-Wi-Fi, אם הן שונות). היא נשמרת רק בטלפון הזה.</p>
   <div class="field"><label for="lp">סיסמה</label><input type="password" id="lp" autocomplete="current-password" style="flex:1;min-width:0;font-size:16px;padding:6px 0;direction:ltr;text-align:left"></div>
   <div class="login-err" id="lerr">${msg ? esc(msg) : ''}</div>
   <button class="btn pri" id="lgo">התחבר</button>`, r => {
    const go = async () => {
      const pw = r.querySelector('#lp').value; if (!pw) { r.querySelector('#lerr').textContent = 'הקלד סיסמה'; return; }
      r.querySelector('#lgo').textContent = 'מתחבר...';
      try { await native('login', { password: pw }); delete $('#scrim').dataset.lock; closeSheet(); toast('מחובר לנתב'); start(); }
      catch (e) { r.querySelector('#lerr').textContent = errText(e); r.querySelector('#lgo').textContent = 'התחבר'; }
    };
    r.querySelector('#lgo').onclick = go; r.querySelector('#lp').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    setTimeout(() => r.querySelector('#lp').focus(), 300);
  });
}

/* ---------- live data from the router ---------- */
let statusTimer = null, devTimer = null, failCount = 0;
function applyStatus(s) {
  lastStatus = s;
  const w = s.wan || {};
  pushTraffic((+w.downspeed || 0) * 8 / 1e6, (+w.upspeed || 0) * 8 / 1e6);
  if (s.upTime) $('#upt').textContent = fmtUp(s.upTime);
  if (s.cpu && s.cpu.load != null) { let c = +s.cpu.load; if (c <= 1) c *= 100; c = Math.round(c); $('#cpu').textContent = c + '%'; $('#cpuM').style.width = Math.min(c, 100) + '%'; }
  if (s.mem && s.mem.usage != null) { let m = +s.mem.usage; if (m <= 1) m *= 100; m = Math.round(m); $('#mem').textContent = m + '%'; $('#memM').style.width = Math.min(m, 100) + '%'; }
  if (s.temperature != null && +s.temperature > 0) { $('#tmp').textContent = Math.round(+s.temperature) + '°'; $('#tmpM').style.width = Math.min(+s.temperature, 100) + '%'; }
  if (w.download != null) { $('#useD').textContent = fmtBytes(w.download); $('#useU').textContent = fmtBytes(w.upload); $('#useT').textContent = fmtBytes((+w.download || 0) + (+w.upload || 0)); }
  if (s.hardware && s.hardware.version) $('#fwV').textContent = 'גרסה ' + s.hardware.version;
  (s.dev || []).forEach(x => { const d = devs.find(y => y.mac.toUpperCase() === String(x.mac).toUpperCase()); if (d) { d.r = +x.downspeed || 0; d.tot = (+x.download || 0) + (+x.upload || 0); } });
  if (!$('#scrim').hidden) return; renderDevs();
}
async function loadStatus() {
  try {
    const s = await api('misystem/status'); failCount = 0;
    if (!online || rebooting) { online = true; rebooting = 0; setMode(); }
    setNet('ok', 'מחובר לאינטרנט'); applyStatus(s);
  } catch (e) {
    const m = String(e.message);
    if (m.includes('badPassword') || m.includes('noPassword')) { stop(); loginSheet(m.includes('badPassword') ? 'הסיסמה השמורה כבר לא נכונה' : ''); return; }
    if (rebooting && Date.now() - rebooting < 240000) { setNet('warn', 'הנתב עולה מחדש...'); return; }
    if (++failCount >= 2) { online = false; setMode(); setNet('off', m.includes('offline') ? 'לא מחובר ל-Wi-Fi של הבית' : 'הנתב לא עונה'); pushTraffic(0, 0); }
  }
}
async function loadDevices() {
  try {
    const j = await api('misystem/devicelist');
    const list = j.list || [];
    const old = devs;
    devs = list.filter(x => !x.isap || x.isap === 0).map(x => {
      const ipObj = (x.ip || [])[0] || {};
      const prev = old.find(o => o.mac === x.mac) || {};
      return {
        mac: x.mac, n: x.name || x.oname || x.mac, band: BAND[x.type] || (x.type == null ? '' : 'cable'),
        ip: ipObj.ip, online: x.online == null ? true : !!+x.online, blocked: x.authority ? +x.authority.wan === 0 : false,
        r: prev.r || +ipObj.downspeed || 0, tot: prev.tot || 0, isNew: prev.isNew
      };
    });
    checkNew(); renderDevs(); renderSch();
  } catch (e) { /* status handler reports connection problems */ }
}
async function loadWifi() {
  try {
    const j = await api('xqnetwork/wifi_detail_all');
    const info = j.info || [];
    const a = info[0] || {}, b = info[1] || {};
    wifi.ssid = a.ssid || b.ssid || wifi.ssid; wifi.pw = a.password || b.password || '';
    const ch = x => x && x.channelInfo ? x.channelInfo.channel : (x && x.channel);
    const bw = b.channelInfo && b.channelInfo.bandwidth ? b.channelInfo.bandwidth + 'MHz' : '';
    wifi.ch = `2.4: ${ch(a) || 'auto'} · 5: ${ch(b) || 'auto'}${bw ? ' · ' + bw : ''}`;
    wifi.tx = a.txpwr || b.txpwr || wifi.tx; wifi.on = (a.status === '1' || a.status === 1 || b.status === '1' || b.status === 1);
    const g = info.find(x => /guest/i.test(x.ifname || '') || x.guest); if (g) { wifi.guestSsid = g.ssid; setGuest(g.status === '1' || g.status === 1); }
    $('#wSub').textContent = (a.ssid && b.ssid && a.ssid !== b.ssid) ? `5 GHz: ${b.ssid}` : '2.4 + 5 GHz · Wi-Fi 7';
    renderWifi();
  } catch (e) {}
  try { lastNet = await api('xqnetwork/pppoe_status'); } catch (e) {}
}
function stop() { clearInterval(statusTimer); clearInterval(devTimer); statusTimer = devTimer = null; }
async function start() {
  stop(); setMode(); setNet('warn', 'מתחבר לנתב...');
  await loadDevices(); loadWifi(); loadStatus();
  statusTimer = setInterval(loadStatus, 2000); devTimer = setInterval(loadDevices, 15000);
}
document.addEventListener('visibilitychange', () => { if (!LIVE) return; if (document.hidden) stop(); else if (!statusTimer && $('#scrim').dataset.lock !== '1') start(); });

/* ---------- boot ---------- */
if (LIVE) {
  devs = []; $('#newDev').hidden = true; $('#cnt').textContent = '-'; $('#upt').textContent = '-'; $('#ping').textContent = '-';
  ['#useD', '#useU', '#useT'].forEach(s => $(s).textContent = '-');
  $('#useDl').textContent = 'הורדה מאז ההפעלה'; $('#useUl').textContent = 'העלאה מאז ההפעלה'; $('#useTl').textContent = 'סה"כ';
  setGuest(false); renderDevs(); renderSch(); renderWifi();
  native('hasPassword').then(r => { if (r && r.has) start(); else loginSheet(); }).catch(() => loginSheet());
} else {
  devs = demoDevs(); renderDevs(); renderSch(); renderWifi(); setGuest(false);
  setInterval(() => {
    const base = profile === 'night' ? 60 : profile === 'game' ? 200 : 320;
    pushTraffic(Math.max(5, base + Math.random() * 160 * (Math.random() < .15 ? 2.5 : 1)), 15 + Math.random() * 30);
    $('#ping').textContent = 6 + Math.round(Math.random() * 5);
    const c = 8 + Math.round(Math.random() * 14); $('#cpu').textContent = c + '%'; $('#cpuM').style.width = c + '%';
  }, 1500);
  const wk = [[52, 'א'], [61, 'ב'], [44, 'ג'], [73, 'ד'], [58, 'ה'], [88, 'ו'], [20, 'ש']];
  const today = new Date().getDay();
  $('#bars').innerHTML = wk.map((w, i) => `<div class="bar ${i === today ? 'today' : ''}"><i style="height:${w[0]}%"></i><small>${w[1]}</small></div>`).join('');
  const log = [['15:05', 'w', 'מכשיר חדש: Galaxy-A54'], ['14:40', '', 'iPad של אסיף התחבר'], ['07:00', '', 'זמן גלישה "לילה" הסתיים'], ['04:00', '', 'אתחול מתוזמן הושלם'], ['22:00', 'off', 'iPad של אסיף נחסם (זמן גלישה)']];
  $('#log').innerHTML = log.map(l => `<div class="row"><span class="ld ${l[1]}"></span><span class="t">${l[2]}</span><span class="lt">${l[0]}</span></div>`).join('');
}
