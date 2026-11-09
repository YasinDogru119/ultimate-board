// Ultimate Jigsaw — dünya sıralaması ROBOTU (GitHub Actions'ta saatte bir çalışır; Node 20+, ek paket YOK).
// İş: Firestore'dan YALNIZCA son çalışmadan beri değişen oyuncuları okur (ücretsiz kota: günde 50 bin okuma),
// tam durumu şifreli state.enc'de tutar, telefonların indirdiği hazır dosyaları yazar:
//   week.json / season.json  → { id, upd, n, top: ilk 100 [kimlik, isim, ülke, puan, lig, yapboz], h: [[puan, kişi], …] }
//   awards.json              → { kimlik: [[tür, dönem, sıra], …] }   (haftanın ilk 3'ü, sezonun ilk 10'u)
//   champs.json              → [{ s: "2026-1", top: [[kimlik, isim, ülke, puan] ×3] }, …]
// Ortam: SA_JSON (Firebase hizmet hesabı JSON'u — GitHub Secrets), STATE_KEY (şifre — GitHub Secrets).
// Yerel deneme: node robot.mjs --fake 3000 --out ./out   (Firestore'a bağlanmaz, rastgele oyuncu üretir)
import { createCipheriv, createDecipheriv, createHash, createSign, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1] ?? true; };
const OUT = arg('out', '.');
const FAKE = arg('fake', null);
const STATE = join(OUT, 'state.enc');
const DAY = 864e5;

// ---- takvim: telefondaki src/leaderboard/time.ts ile AYNI olmalı
const weekId = (ms = Date.now()) => {
  const d = new Date(ms), day = (d.getUTCDay() + 6) % 7;
  const thu = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3), y = new Date(thu).getUTCFullYear();
  return y + '-' + (1 + Math.floor((thu - Date.UTC(y, 0, 1)) / DAY / 7));
};
/** Sezonun başlangıcı (1 Ocak / 1 Temmuz, UTC) — ilk kez görülen oyuncunun sezon puanı bu tarihten beri birikmiş olabilir */
const seasonStart = (ms = Date.now()) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() < 6 ? 0 : 6, 1); };
const seasonId = (ms = Date.now()) => { const d = new Date(ms); return d.getUTCFullYear() + '-' + (d.getUTCMonth() < 6 ? 1 : 2); };

// ---- isim süzgeci: telefondaki BAD listesiyle aynı (src/leaderboard/store.ts) + bildirimle gizlenenler
const BAD = ['fuck', 'shit', 'bitch', 'cunt', 'nigg', 'fag', 'porn', 'sex', 'dick', 'pussy', 'rape', 'nazi', 'hitler',
  'sik', 'amk', 'amcık', 'orospu', 'piç', 'yarak', 'göt', 'kahpe', 'puta', 'mierda', 'pendejo', 'merde', 'salope', 'scheiß', 'fotze', 'cazzo', 'blyat', 'сука', 'хуй', 'пизд'];
const badName = n => {
  const words = String(n).toLocaleLowerCase().split(/[ _.0-9]+/), glued = words.join('');
  return BAD.some(b => (b.length > 4 ? glued.includes(b) : words.some(w => w.startsWith(b))));
};
const REPORTS_TO_HIDE = 3;
const REPORTER_MIN_PUZZLES = 3;   // bildirim yalnızca en az 3 yapboz bitirmiş oyuncudan sayılır (sahte hesapla isim gizletme olmasın)
// telefondaki isim kuralıyla aynı (src/leaderboard/store.ts SYMBOL) + görünmez/yön değiştiren karakterler: telefonu atlayıp
// doğrudan sunucuya yazan biri bunlarla taklit isim yapmasın → böyle isim "Player XXXX" görünür
const SYMBOL = /[\u0000-\u001f!-\-/:-@[-^`{-~\u007f-\u00bf\u2000-\u2bff\ud800-\udfff\ufe00-\ufe0f]/;
const nameOk = n => { const v = String(n).trim(); return v.length >= 3 && v.length <= 16 && !SYMBOL.test(v) && !/\s{2}/.test(v); };

// ---- hile kontrolü (9 Kasım 2026, kullanıcı: "Günün Yapbozu 2 katını hileden sayma")
// İki gönderim arasında kazanılan puan, gerçek oyunla mümkün olandan fazlaysa oyuncu O SEZON listelerden ve kupalardan çıkar.
// Telefonuna bir şey olmaz (puanı yine kendi telefonunda görünür). Sınırlar bilerek cömert: dürüst oyuncu asla takılmasın.
const PER_PUZZLE = 50;       // en çok: 100 parça 25 puan, reklamla 2 katı 50
const DAILY_EXTRA = 50;      // Günün Yapbozu: 2 kat → reklamla en çok 100; normal sınırın üstündeki 50 her gün serbest
const PER_MIN = 15;          // dakikada ortalama 15 puandan fazlası insanüstü (çok hızlı oyuncu ~8)
const BURST = 300;           // anlık sıçrama payı (aynı Firestore kuralındaki gibi)
/** Önceki kayıt → yeni kayıt arasında kazanç makul mü; değilse sebep metni */
function suspicious(prev, cur, since) {
  const gain = prev && prev.s === cur.s ? cur.sp - prev.sp : cur.sp;
  if (gain <= 0) return null;
  const mins = Math.max(1, ((cur.t || Date.now()) - (prev ? prev.t : since)) / 6e4);
  const days = Math.ceil(mins / 1440) + 1;
  const puzzles = prev ? Math.max(0, cur.pz - prev.pz) : cur.pz;
  // Günün Yapbozu da bir yapboz: ek pay en çok bitirilen yapboz sayısı kadar (9 Kasım: yapbozsuz +340 puan yakalanmıyordu)
  const dailies = Math.min(days, puzzles);
  if (gain > PER_PUZZLE * puzzles + DAILY_EXTRA * dailies + 20) return `yapboz başına fazla: +${gain} puan / ${puzzles} yapboz`;
  if (gain > BURST + PER_MIN * mins + DAILY_EXTRA * dailies) return `çok hızlı: +${gain} puan / ${Math.round(mins)} dk`;
  return null;
}
const cheat = (st, uid) => st.flag[uid] === st.season;
const pidOf = uid => uid.slice(0, 12);
const shown = (st, uid, name) => (st.hidden[pidOf(uid)] || badName(name) || !nameOk(name) ? 'Player ' + pidOf(uid).slice(0, 4).toUpperCase() : name);

// ---- şifreli durum (AES-256-GCM). Açık depoda durduğu için şifreli: içinde bütün oyuncular var.
const keyOf = () => createHash('sha256').update(process.env.STATE_KEY || 'yerel-deneme').digest();
function loadState() {
  const empty = { v: 1, lastT: '1970-01-01T00:00:00Z', lastRT: '1970-01-01T00:00:00Z', week: null, season: null, players: {}, reports: {}, hidden: {}, flag: {}, awards: {}, champs: [] };
  if (!existsSync(STATE)) return empty;
  try {
    const b = readFileSync(STATE), d = createDecipheriv('aes-256-gcm', keyOf(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return { ...empty, ...JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')) };
  } catch (e) { console.log('durum okunamadı, baştan kuruluyor (tam okuma):', e.message); return empty; }
}
function saveState(st) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyOf(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(st), 'utf8'), c.final()]);
  writeFileSync(STATE, Buffer.concat([iv, c.getAuthTag(), enc]));
}

// ---- Firestore (hizmet hesabıyla; robot kuralları aşar, telefonlar aşamaz)
let SA = null, TOKEN = null, reads = 0;
async function token() {
  if (TOKEN) return TOKEN;
  SA = JSON.parse(process.env.SA_JSON);
  const now = Math.floor(Date.now() / 1000), b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = createSign('RSA-SHA256').update(body).sign(SA.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + body + '.' + sig });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google girişi başarısız: ' + JSON.stringify(j));
  return (TOKEN = j.access_token);
}
const fv = v => (v == null ? null : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? +v.integerValue : 'timestampValue' in v ? v.timestampValue : null);

/** Bir koleksiyondan t > since olan belgeler (sayfa sayfa; okunan her belge 1 okuma) */
async function changed(col, since) {
  const out = [], base = `https://firestore.googleapis.com/v1/projects/${SA?.project_id ?? JSON.parse(process.env.SA_JSON).project_id}/databases/(default)/documents:runQuery`;
  let cursor = null;
  for (;;) {
    const q = { from: [{ collectionId: col }], where: { fieldFilter: { field: { fieldPath: 't' }, op: 'GREATER_THAN', value: { timestampValue: since } } },
      orderBy: [{ field: { fieldPath: 't' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: 2000 };
    if (cursor) q.startAt = { values: cursor, before: false };
    const r = await fetch(base, { method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: q }) });
    if (!r.ok) throw new Error(col + ' okunamadı: ' + r.status + ' ' + await r.text());
    const docs = (await r.json()).filter(x => x.document).map(x => x.document);
    reads += Math.max(1, docs.length);
    out.push(...docs);
    if (docs.length < 2000) break;
    const last = docs[docs.length - 1];
    cursor = [{ timestampValue: last.fields.t.timestampValue }, { referenceValue: last.name }];
  }
  return out.map(d => ({ id: d.name.split('/').pop(), f: Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, fv(v)])) }));
}

// ---- deneme verisi
function fakeNames(n, seed) {
  let s = seed; const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const F = ['Ayşe', 'Mehmet', 'Elif', 'Can', 'Zeynep', 'Lucía', 'Mateo', 'Sofia', 'Luca', 'Emma', 'Noah', 'Mia', 'Hana', 'Kenji', 'Minji', 'Anna', 'Olga', 'Priya', 'Omar', 'Lea', 'João', 'Siti', 'Erik', 'Zara'];
  const H = ['PuzzleQueen', 'JigsawJoe', 'PieceMaster', 'EdgeFinder', 'CornerKing', 'NightOwl', 'ParçaAvcısı', 'YapbozKralı', 'BlueFox', 'GreenTea'];
  const C = ['US', 'US', 'TR', 'TR', 'DE', 'GB', 'FR', 'BR', 'JP', 'KR', 'IT', 'ES', 'MX', 'IN', 'ID', 'RU', 'CU', 'PK', 'VE', 'CO', 'BW', 'AZ'];
  return Array.from({ length: n }, (_, i) => {
    const k = r(), f = F[Math.floor(r() * F.length)];
    const name = k < 0.4 ? H[Math.floor(r() * H.length)] + Math.floor(r() * 99) : k < 0.7 ? f + ' ' + String.fromCharCode(65 + Math.floor(r() * 26)) + '.' : f + '_' + Math.floor(r() * 900 + 10);
    return { uid: 'fake' + String(i).padStart(8, '0') + 'x'.repeat(16), name, c: C[Math.floor(r() * C.length)], r };
  });
}

// ---- dönem kapanışı: kupalar ve şampiyonlar
function closeWeek(st, id) {
  const top = Object.entries(st.players).filter(([uid, p]) => p.w === id && p.wp > 0 && !cheat(st, uid)).sort((a, b) => b[1].wp - a[1].wp || a[1].t - b[1].t).slice(0, 3);
  top.forEach(([uid], i) => (st.awards[pidOf(uid)] ??= []).push(['week', id, i + 1]));
  console.log('hafta kapandı', id, top.map(([u, p]) => p.n + ':' + p.wp).join(', '));
}
function closeSeason(st, id) {
  const top = Object.entries(st.players).filter(([uid, p]) => p.s === id && p.sp > 0 && !cheat(st, uid)).sort((a, b) => b[1].sp - a[1].sp || a[1].t - b[1].t).slice(0, 10);
  top.forEach(([uid], i) => (st.awards[pidOf(uid)] ??= []).push([i === 0 ? 'champ' : i === 1 ? 'second' : i === 2 ? 'third' : 'top10', id, i + 1]));
  if (top.length) st.champs.unshift({ s: id, top: top.slice(0, 3).map(([uid, p]) => [pidOf(uid), shown(st, uid, p.n), p.c, p.sp]) });
  console.log('sezon kapandı', id, top.length, 'kupa');
}
function rollover(st, now) {
  const w = weekId(now), s = seasonId(now);
  if (st.week && st.week !== w) closeWeek(st, st.week);
  if (st.season && st.season !== s) closeSeason(st, st.season);
  st.week = w; st.season = s;
  for (const u in st.flag) if (st.flag[u] !== s) delete st.flag[u];   // yeni sezon: herkese temiz sayfa
}

function board(st, kind) {
  const id = kind === 'week' ? st.week : st.season, pk = kind === 'week' ? 'wp' : 'sp', ik = kind === 'week' ? 'w' : 's';
  const all = Object.entries(st.players).filter(([uid, p]) => p[ik] === id && p[pk] > 0 && !cheat(st, uid)).sort((a, b) => b[1][pk] - a[1][pk] || a[1].t - b[1].t);
  const h = new Map();
  for (const [, p] of all) h.set(p[pk], (h.get(p[pk]) ?? 0) + 1);
  return {
    id, upd: Date.now(), n: all.length,
    top: all.slice(0, 100).map(([uid, p]) => [pidOf(uid), shown(st, uid, p.n), p.c, p[pk], p.lg ?? 0, p.pz ?? 0]),
    h: [...h.entries()].sort((a, b) => b[0] - a[0]),
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const st = loadState();
  const t0 = Date.now();
  if (FAKE) {
    // 1) geçen hafta ve geçen sezonla oyuncular → kapanış (kupa ve şampiyon üretimini dener) 2) bu haftanın puanları
    const n = +FAKE || 3000, P = fakeNames(n, 7);
    const prev = t0 - 7 * DAY, prevSeason = Date.UTC(new Date(t0).getUTCFullYear(), new Date(t0).getUTCMonth() < 6 ? -1 : 5, 15);
    st.week = weekId(prev); st.season = seasonId(prevSeason);
    for (const p of P) st.players[p.uid] = { n: p.name, c: p.c, w: st.week, wp: Math.floor(p.r() ** 3 * 3000), s: st.season, sp: Math.floor(p.r() ** 3 * 40000), lg: Math.floor(p.r() * 6), pz: Math.floor(p.r() * 900), t: t0 - 3 * DAY };
    rollover(st, t0);
    for (const p of P) if (p.r() < 0.8) Object.assign(st.players[p.uid], { w: st.week, wp: Math.floor(p.r() ** 4 * 3200), s: st.season, sp: Math.floor(p.r() ** 3 * 9000), t: t0 - Math.floor(p.r() * DAY) });
    // hile denemesi: önceki kayıt 1 saat önce, şimdi +5000 puan / 2 yapboz → şüpheli; Günün Yapbozu 2 katı (+100 / 1 yapboz) → temiz
    for (const [uid, gain, pz] of [['fake-cheater-000000000000', 5000, 2], ['fake-daily2x-000000000000', 100, 1]]) {
      const prev = { n: uid.slice(5, 12), c: 'US', w: st.week, wp: 10, s: st.season, sp: 10, lg: 0, pz: 5, t: t0 - 36e5 };
      const cur = { ...prev, wp: 10 + gain, sp: 10 + gain, pz: 5 + pz, t: t0 };
      const why = suspicious(prev, cur, seasonStart(t0));
      if (why) { st.flag[uid] = cur.s; console.log('şüpheli', pidOf(uid), why); } else console.log('temiz', pidOf(uid));
      st.players[uid] = cur;
    }
    st.players['fake-bad-name-000000000000'] = { n: 'sikko', c: 'TR', w: st.week, wp: 2900, s: st.season, sp: 3000, lg: 2, pz: 10, t: t0 };   // süzgeç denemesi
  } else {
    const ps = await changed('players', st.lastT);
    let flagged = 0;
    for (const d of ps) {
      const f = d.f;
      if (typeof f.n !== 'string' || typeof f.w !== 'string') continue;
      const cur = { n: f.n.slice(0, 16), c: /^[A-Z]{2}$/.test(f.c) ? f.c : 'UN', w: f.w, wp: f.wp | 0, s: f.s, sp: f.sp | 0, lg: f.lg | 0, pz: f.pz | 0, t: Date.parse(f.t) };
      const why = suspicious(st.players[d.id], cur, seasonStart(cur.t));
      if (why && st.flag[d.id] !== cur.s) { st.flag[d.id] = cur.s; flagged++; console.log('şüpheli', pidOf(d.id), why); }
      st.players[d.id] = cur;
      if (f.t > st.lastT) st.lastT = f.t;
    }
    const rs = await changed('reports', st.lastRT);
    for (const d of rs) {
      const reporter = d.id.split('_')[0], target = String(d.f.x ?? '').slice(0, 12);
      const list = (st.reports[target] ??= []);
      if (!list.includes(reporter)) list.push(reporter);
      const real = list.filter(r => (st.players[r]?.pz ?? 0) >= REPORTER_MIN_PUZZLES).length;
      if (real >= REPORTS_TO_HIDE) st.hidden[target] = true;
      if (d.f.t > st.lastRT) st.lastRT = d.f.t;
    }
    console.log('değişen oyuncu', ps.length, '· bildirim', rs.length, '· şüpheli', flagged);
    rollover(st, t0);
  }
  const files = { 'week.json': board(st, 'week'), 'season.json': board(st, 'season'), 'awards.json': st.awards, 'champs.json': st.champs };
  for (const [f, v] of Object.entries(files)) writeFileSync(join(OUT, f), JSON.stringify(v));
  saveState(st);
  console.log(`tamam: ${Object.keys(st.players).length} oyuncu · hafta ${st.week} (${files['week.json'].n}) · sezon ${st.season} (${files['season.json'].n}) · ${reads} okuma · ${Date.now() - t0} ms`);
}
main().catch(e => { console.error(e); process.exit(1); });
