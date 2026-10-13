// v1
/* Halo cloud bridge - lets the app read the router through Xiaomi's cloud when you're away from home.
   Secrets (set by the GitHub workflow): XIAOMI_USER, XIAOMI_PASS, ACCESS_KEY.
   The router exposes only a few things to the cloud: download/upload speed, number of connected devices,
   their IDs, and the indicator light. */

const DID = '2020079154';                 // router's cloud device id (from init_info → miioDid)
const API = 'https://api.io.mi.com/app';  // Mainland China server
const UA = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-HALOAPPHALOAPP APP/xiaomi.smarthome APPV/62830';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-halo-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/') return json({ ok: true, name: 'halo-cloud' });
    if (!env.ACCESS_KEY || req.headers.get('x-halo-key') !== env.ACCESS_KEY) return json({ error: 'key' }, 401);
    try {
      if (url.pathname === '/status') return json(await status(env));
      if (url.pathname === '/led' && req.method === 'POST') {
        const body = await req.json();
        return json(await miot(env, '/miotspec/prop/set', { params: [{ did: DID, siid: 3, piid: 1, value: !!body.on }] }));
      }
      if (url.pathname === '/raw') {   // diagnostics: full property dump
        const params = [];
        for (let siid = 1; siid <= 4; siid++) for (let piid = 1; piid <= 6; piid++) params.push({ did: DID, siid, piid });
        return json(await miot(env, '/miotspec/prop/get', { params }));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.code || 'failed', message: String(e.message || e), url: e.url }, e.status || 500);
    }
  }
};

async function status(env) {
  const r = await miot(env, '/miotspec/prop/get', {
    params: [
      { did: DID, siid: 2, piid: 1 }, { did: DID, siid: 2, piid: 2 }, { did: DID, siid: 2, piid: 3 },
      { did: DID, siid: 2, piid: 4 }, { did: DID, siid: 3, piid: 1 }
    ]
  });
  const v = {};
  (r.result || []).forEach(p => { if (p.code === 0) v[`${p.siid}.${p.piid}`] = p.value; });
  let ids = v['2.4'];
  try { if (typeof ids === 'string') ids = JSON.parse(ids); } catch (e) {}
  return { ok: true, down: v['2.1'], up: v['2.2'], count: v['2.3'], devices: ids, led: v['3.1'], raw: r.result };
}

/* ---------- Xiaomi account login ---------- */
/* the session lives in the worker's memory while it stays warm (Cache API is not available on workers.dev) */
let SESSION = null;
async function session(env, force) {
  if (!force && SESSION) return SESSION;
  SESSION = await login(env.XIAOMI_USER, env.XIAOMI_PASS);
  return SESSION;
}

const parseXm = t => JSON.parse(t.replace('&&&START&&&', ''));
async function login(user, pass) {
  if (!user || !pass) throw Object.assign(new Error('Xiaomi account not configured'), { code: 'config' });
  const deviceId = 'halo' + Math.random().toString(36).slice(2, 14);
  const cookie = `sdkVersion=accountsdk-18.8.15; deviceId=${deviceId}; userId=${user}`;
  const r1 = await fetch('https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const j1 = parseXm(await r1.text());
  const form = new URLSearchParams({
    sid: 'xiaomiio', hash: (await digest('MD5', pass)).toUpperCase(), callback: 'https://sts.api.io.mi.com/sts',
    qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue', user, _sign: j1._sign || '', _json: 'true'
  });
  const r2 = await fetch('https://account.xiaomi.com/pass/serviceLoginAuth2', {
    method: 'POST', body: form, headers: { 'User-Agent': UA, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const j2 = parseXm(await r2.text());
  if (j2.notificationUrl) throw Object.assign(new Error('Xiaomi wants to verify this login'), { code: 'verify', status: 403, url: j2.notificationUrl });
  if (!j2.ssecurity || !j2.location) throw Object.assign(new Error(j2.desc || 'Xiaomi login failed'), { code: 'login', status: 403 });
  const r3 = await fetch(j2.location, { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const setCookie = r3.headers.get('set-cookie') || '';
  const m = setCookie.match(/serviceToken=([^;]+)/);
  if (!m) throw Object.assign(new Error('no service token'), { code: 'login', status: 403 });
  return { userId: String(j2.userId), ssecurity: j2.ssecurity, serviceToken: m[1] };
}

/* ---------- signed + RC4-encrypted cloud API call ---------- */
async function miot(env, path, data, retried) {
  const s = await session(env, false);
  const nonce = makeNonce();
  const signed = b64(await sha256Bytes(concat(unb64(s.ssecurity), unb64(nonce))));
  const params = { data: JSON.stringify(data) };
  const method = 'POST';
  params.rc4_hash__ = await encSig(method, path, params, signed);
  for (const k of Object.keys(params)) params[k] = rc4b64(signed, params[k]);
  params.signature = await encSig(method, path, params, signed);
  params.ssecurity = s.ssecurity;
  params._nonce = nonce;

  const r = await fetch(API + path, {
    method,
    body: new URLSearchParams(params),
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Encoding': 'identity',
      'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2', 'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
      Cookie: `userId=${s.userId}; yetAnotherServiceToken=${s.serviceToken}; serviceToken=${s.serviceToken}; locale=en_GB; timezone=GMT+03:00; channel=MI_APP_STORE`
    }
  });
  const text = await r.text();
  if (r.status === 401 || r.status === 403) {
    if (!retried) { SESSION = null; await session(env, true); return miot(env, path, data, true); }
    throw Object.assign(new Error('cloud auth failed ' + r.status), { code: 'login', status: 403 });
  }
  let out;
  try { out = JSON.parse(rc4dec(signed, text)); } catch (e) { out = { code: -1, message: text.slice(0, 200) }; }
  return out;
}

async function encSig(method, path, params, signedNonce) {
  const parts = [method.toUpperCase(), path];
  for (const [k, v] of Object.entries(params)) parts.push(`${k}=${v}`);
  parts.push(signedNonce);
  return b64(await digestBytes('SHA-1', new TextEncoder().encode(parts.join('&'))));
}

function makeNonce() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b.subarray(0, 8));
  const minutes = Math.floor(Date.now() / 60000);
  new DataView(b.buffer).setUint32(8, minutes);
  return b64(b);
}

/* RC4 with the first 1024 keystream bytes dropped, as Xiaomi's app does */
function rc4(keyB64, data) {
  const key = unb64(keyB64), S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  let i = 0, j = 0;
  const step = () => { i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]]; return S[(S[i] + S[j]) & 255]; };
  for (let n = 0; n < 1024; n++) step();
  const out = new Uint8Array(data.length);
  for (let n = 0; n < data.length; n++) out[n] = data[n] ^ step();
  return out;
}
const rc4b64 = (k, s) => b64(rc4(k, new TextEncoder().encode(s)));
const rc4dec = (k, s) => new TextDecoder().decode(rc4(k, unb64(s.trim())));

/* ---------- byte helpers ---------- */
function b64(bytes) { let s = ''; bytes = new Uint8Array(bytes); for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function unb64(s) { const t = atob(s); const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); return b; }
function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
async function digestBytes(alg, bytes) { return new Uint8Array(await crypto.subtle.digest(alg, bytes)); }
const sha256Bytes = b => digestBytes('SHA-256', b);
async function digest(alg, text) { return [...await digestBytes(alg, new TextEncoder().encode(text))].map(x => x.toString(16).padStart(2, '0')).join(''); }
