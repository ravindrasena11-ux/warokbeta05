// WAROK – backend (Netlify Functions v2 + Netlify Blobs)
// Semua endpoint /api/* ditangani file ini. Rute diatur oleh `config.path` di bagian bawah.
//
// Variabel lingkungan (Netlify: Site configuration > Environment variables):
//   FONNTE_TOKEN       token PERANGKAT dari menu "Device" di dashboard Fonnte (bukan token akun)
//   OTP_SECRET         teks acak panjang (>= 32 karakter). Jika kosong, dibuat otomatis & disimpan di Blobs.
//   PETUGAS_KODE       kode pendaftaran petugas (teks biasa), ATAU
//   PETUGAS_KODE_HASH  SHA-256 (hex) dari "warok:" + kode
// Setelah mengubah variabel, lakukan "Trigger deploy" agar nilainya terbaca.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

// Nilai cadangan bila variabel lingkungan tidak diisi. Lebih aman pakai variabel lingkungan.
const FALLBACK = {
  FONNTE_TOKEN: '3pvdjauHffDB1FkWKNX9', // token perangkat Fonnte. Bisa ditimpa lewat env FONNTE_TOKEN.
  OTP_SECRET: '',
  PETUGAS_KODE: '',
  PETUGAS_KODE_HASH: 'f3480af76856a09f13842f1416f30bbe84d55edb4e6168f3a6c422c3a83d485d', // kode petugas bawaan (SHA-256 dari "warok:" + kode). Bisa ditimpa lewat env.
};

const env = (k) => (process.env[k] || (globalThis.Netlify?.env?.get?.(k)) || FALLBACK[k] || '').trim();

// ---------- util ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const randId = (n = 16) => crypto.randomBytes(n).toString('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

const nowWIB = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
};

// 08123..., +62812..., 62812..., 812... -> 62812...
export function normPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  return /^628\d{8,12}$/.test(d) ? d : null;
}

// ---------- penyimpanan ----------
const db = () => getStore({ name: 'warok', consistency: 'strong' });
const fs = () => getStore({ name: 'warok-files', consistency: 'strong' });

let secretCache = null;
async function secret() {
  if (secretCache) return secretCache;
  const s = env('OTP_SECRET');
  if (s.length >= 16) return (secretCache = s);
  // Tidak diisi: buat sekali, simpan di Blobs, dipakai seterusnya.
  const store = db();
  let saved = await store.get('config/secret');
  if (!saved) {
    await store.set('config/secret', randId(32), { onlyIfNew: true });
    saved = await store.get('config/secret');
  }
  return (secretCache = saved);
}
const hmac = async (s) => crypto.createHmac('sha256', await secret()).update(s).digest('base64url');

async function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + (await hmac(body));
}
async function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !safeEq(sig, await hmac(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// Pembatas percobaan sederhana (cukup untuk mencegah tebak kode / spam OTP)
async function limit(key, max, windowSec, msg) {
  const store = db(), k = 'rl/' + sha256(key), t = Date.now();
  const cur = (await store.get(k, { type: 'json' })) || { n: 0, s: t };
  if (t - cur.s > windowSec * 1000) { cur.n = 0; cur.s = t; }
  if (cur.n >= max) {
    const wait = Math.ceil((cur.s + windowSec * 1000 - t) / 60000);
    fail(429, msg || `Terlalu banyak percobaan. Coba lagi dalam ${wait} menit.`);
  }
  cur.n++;
  await store.setJSON(k, cur);
}

// ---------- password ----------
function hashPass(pw) {
  const salt = randId(16);
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
const checkPass = (pw, rec) => !!rec?.salt && safeEq(crypto.scryptSync(pw, rec.salt, 32).toString('hex'), rec.hash);

// ---------- kode petugas ----------
function kodeOk(kode) {
  kode = str(kode, 100);
  if (!kode) return false;
  const plain = env('PETUGAS_KODE'), hash = env('PETUGAS_KODE_HASH').toLowerCase();
  if (!plain && !hash) fail(503, 'Kode pendaftaran petugas belum diatur di server (PETUGAS_KODE atau PETUGAS_KODE_HASH).');
  return (plain && safeEq(kode, plain)) || (hash && safeEq(sha256('warok:' + kode), hash));
}

// ---------- Fonnte (WhatsApp) ----------
const FONNTE_HINT = {
  token: 'Token Fonnte tidak valid. Pakai token PERANGKAT (menu Device), bukan token akun.',
  disconnect: 'Perangkat WhatsApp pengirim terputus. Sambungkan ulang (scan QR) di dashboard Fonnte.',
  quota: 'Kuota pesan Fonnte habis.',
  target: 'Nomor WhatsApp tujuan tidak valid atau tidak terdaftar di WhatsApp.',
};
function fonnteMsg(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('token')) return FONNTE_HINT.token;
  if (r.includes('disconnect') || r.includes('device')) return FONNTE_HINT.disconnect;
  if (r.includes('quota') || r.includes('kuota')) return FONNTE_HINT.quota;
  if (r.includes('target') || r.includes('invalid')) return FONNTE_HINT.target;
  return 'Gagal mengirim WhatsApp: ' + (reason || 'alasan tidak diketahui') + '.';
}
export async function sendWA(phone, message) {
  const token = env('FONNTE_TOKEN');
  if (!token) fail(503, 'Pengirim WhatsApp belum diatur: FONNTE_TOKEN kosong di server.');
  const fd = new FormData();
  fd.append('target', phone);
  fd.append('message', message);
  fd.append('countryCode', '62');
  let r, j;
  try {
    r = await fetch('https://api.fonnte.com/send', { method: 'POST', headers: { Authorization: token }, body: fd });
    j = await r.json();
  } catch { fail(502, 'Server tidak bisa menghubungi Fonnte. Coba lagi sebentar.'); }
  // Fonnte membalas HTTP 200 walau gagal: yang menentukan adalah field `status`.
  if (j?.status !== true) {
    console.error('Fonnte send gagal:', JSON.stringify(j));
    fail(502, fonnteMsg(j?.reason || j?.detail));
  }
  return j;
}
const notify = (phone, msg) => sendWA(phone, msg).catch((e) => console.error('notifikasi WA gagal:', e.message));

// ---------- sesi ----------
const SESSION_MS = 12 * 3600 * 1000;
async function auth(req, role) {
  const h = req.headers.get('authorization') || '';
  const p = await verify(h.replace(/^Bearer\s+/i, ''));
  if (!p || p.t !== 'sess') fail(401, 'Sesi berakhir. Silakan masuk kembali.');
  if (role && p.r !== role) fail(403, 'Akses ditolak.');
  return p;
}

// ---------- OTP ----------
async function checkOtp(otpToken, code, phone) {
  const p = await verify(otpToken);
  if (!p || p.t !== 'otp') fail(400, 'Kode sudah kedaluwarsa. Tekan "Kirim ulang kode".');
  if (p.p !== phone) fail(400, 'Kode ini dikirim ke nomor lain. Kirim ulang kode ke nomor yang benar.');
  await limit('otp-try:' + p.j, 5, 600, 'Terlalu banyak percobaan. Tekan "Kirim ulang kode".');
  if (!/^\d{6}$/.test(String(code || '')) || !safeEq(await hmac('code:' + p.j + ':' + code), p.h)) fail(400, 'Kode salah. Periksa lagi pesan WhatsApp Anda.');
  // satu kode hanya untuk satu kali pakai
  const used = await db().set('otp-used/' + p.j, '1', { onlyIfNew: true });
  if (!used.modified) fail(400, 'Kode sudah dipakai. Tekan "Kirim ulang kode".');
}

// ---------- data warga / petugas ----------
const wargaKey = (email) => 'warga/' + sha256(email);
const nikKey = (nik) => 'nik/' + nik;
const petugasKey = (u) => 'petugas/' + u;
const wargaPublic = (w) => ({ nik: w.nik, name: w.name, wa: w.wa, email: w.email });
const petugasPublic = (p) => ({ user: p.user, name: p.name, nip: p.nip || '' });

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120; }

// ---------- pengajuan ----------
const SVC = ['kk', 'pindah', 'lahir', 'mati'];
const reqKey = (nik, id) => `reqs/${nik}/${id}`;
async function getReq(nik, id) {
  if (!/^\d{16}$/.test(String(nik)) || !/^[A-Z0-9-]{6,30}$/.test(String(id))) fail(400, 'Data tidak valid.');
  const r = await db().get(reqKey(nik, id), { type: 'json' });
  if (!r) fail(404, 'Pengajuan tidak ditemukan.');
  return r;
}
async function listReqs(prefix) {
  const store = db(), out = [];
  for await (const page of store.list({ prefix, paginate: true })) {
    const items = await Promise.all(page.blobs.map((b) => store.get(b.key, { type: 'json' })));
    out.push(...items.filter(Boolean));
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
const SVC_NAME = { kk: 'Kartu Keluarga', pindah: 'Surat Keterangan Pindah', lahir: 'Akta Kelahiran', mati: 'Akta Kematian' };
const ST_NAME = { 1: 'Pemeriksaan & verifikasi', 2: 'Diproses', 3: 'Selesai' };

// ============================================================
// ROUTES
// ============================================================
const routes = {
  // ----- OTP -----
  'POST otp-send': async (req, b, ctx) => {
    const phone = normPhone(b.phone);
    if (!phone) fail(400, 'Nomor WhatsApp tidak valid. Contoh: 08123456789.');
    await limit('otp-cd:' + phone, 1, 55, 'Tunggu 1 menit sebelum meminta kode lagi.');
    await limit('otp-hr:' + phone, 6, 3600, 'Terlalu sering meminta kode ke nomor ini. Coba lagi dalam 1 jam.');
    if (ctx?.ip) await limit('otp-ip:' + ctx.ip, 20, 3600);
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'), j = randId(8);
    await sendWA(phone, `Kode verifikasi WAROK Anda: *${code}*\n\nBerlaku 10 menit. Jangan berikan kode ini kepada siapa pun, termasuk petugas.`);
    const token = await sign({ t: 'otp', p: phone, j, h: await hmac('code:' + j + ':' + code), exp: Date.now() + 10 * 60 * 1000 });
    return { ok: true, token };
  },

  // ----- warga -----
  'POST warga-check': async (req, b) => {
    const email = str(b.email, 120).toLowerCase(), nik = str(b.nik, 16);
    if (!validEmail(email)) fail(400, 'Email tidak valid.');
    if (!/^\d{16}$/.test(nik)) fail(400, 'NIK harus 16 digit angka.');
    const store = db();
    if (await store.get(wargaKey(email))) fail(409, 'Email ini sudah terdaftar. Silakan masuk.');
    if (await store.get(nikKey(nik))) fail(409, 'NIK ini sudah terdaftar. Silakan masuk dengan email yang dipakai saat mendaftar.');
    return { ok: true };
  },
  'POST warga-register': async (req, b) => {
    const email = str(b.email, 120).toLowerCase(), nik = str(b.nik, 16), name = str(b.name, 100), wa = normPhone(b.wa), pw = String(b.password || '');
    if (!validEmail(email)) fail(400, 'Email tidak valid.');
    if (!/^\d{16}$/.test(nik)) fail(400, 'NIK harus 16 digit angka.');
    if (name.length < 2) fail(400, 'Nama wajib diisi.');
    if (!wa) fail(400, 'Nomor WhatsApp tidak valid.');
    if (pw.length < 6) fail(400, 'Kata sandi minimal 6 karakter.');
    await checkOtp(b.otpToken, b.code, wa);
    const store = db();
    const n = await store.set(nikKey(nik), email, { onlyIfNew: true });
    if (!n.modified) fail(409, 'NIK ini sudah terdaftar.');
    const user = { email, nik, name, wa, pass: hashPass(pw), created: nowWIB() };
    const w = await store.setJSON(wargaKey(email), user, { onlyIfNew: true });
    if (!w.modified) { await store.delete(nikKey(nik)); fail(409, 'Email ini sudah terdaftar.'); }
    const token = await sign({ t: 'sess', r: 'w', e: email, nik, exp: Date.now() + SESSION_MS });
    return { token, user: wargaPublic(user) };
  },
  'POST warga-login': async (req, b, ctx) => {
    const email = str(b.email, 120).toLowerCase();
    await limit('login-w:' + email, 10, 900);
    if (ctx?.ip) await limit('login-ip:' + ctx.ip, 40, 900);
    const user = await db().get(wargaKey(email), { type: 'json' });
    if (!user || !checkPass(String(b.password || ''), user.pass)) fail(400, 'Email atau kata sandi salah.');
    const token = await sign({ t: 'sess', r: 'w', e: email, nik: user.nik, exp: Date.now() + SESSION_MS });
    return { token, user: wargaPublic(user) };
  },

  // ----- petugas -----
  'POST petugas-check': async (req, b, ctx) => {
    const u = str(b.user, 20).toLowerCase();
    if (!/^[a-z0-9._]{4,20}$/.test(u)) fail(400, 'Nama pengguna 4-20 karakter: huruf kecil, angka, titik, atau garis bawah.');
    await limit('kode:' + (ctx?.ip || 'x'), 10, 900);
    if (!kodeOk(b.kode)) fail(403, 'Kode pendaftaran petugas salah.');
    if (await db().get(petugasKey(u))) fail(409, 'Nama pengguna sudah dipakai. Pilih yang lain.');
    return { ok: true };
  },
  'POST petugas-register': async (req, b, ctx) => {
    const u = str(b.user, 20).toLowerCase(), name = str(b.name, 100), nip = str(b.nip, 30).replace(/\D/g, ''), wa = normPhone(b.wa), pw = String(b.password || '');
    if (!/^[a-z0-9._]{4,20}$/.test(u)) fail(400, 'Nama pengguna tidak valid.');
    if (name.length < 2) fail(400, 'Nama wajib diisi.');
    if (!wa) fail(400, 'Nomor WhatsApp tidak valid.');
    if (pw.length < 8) fail(400, 'Kata sandi minimal 8 karakter.');
    await limit('kode:' + (ctx?.ip || 'x'), 10, 900);
    if (!kodeOk(b.kode)) fail(403, 'Kode pendaftaran petugas salah.');
    await checkOtp(b.otpToken, b.code, wa);
    const rec = { user: u, name, nip, wa, pass: hashPass(pw), created: nowWIB() };
    const w = await db().setJSON(petugasKey(u), rec, { onlyIfNew: true });
    if (!w.modified) fail(409, 'Nama pengguna sudah dipakai.');
    return { ok: true };
  },
  'POST petugas-login': async (req, b, ctx) => {
    const u = str(b.user, 20).toLowerCase();
    await limit('login-p:' + u, 10, 900);
    if (ctx?.ip) await limit('login-ip:' + ctx.ip, 40, 900);
    const rec = await db().get(petugasKey(u), { type: 'json' });
    if (!rec || !checkPass(String(b.password || ''), rec.pass)) fail(400, 'Nama pengguna atau kata sandi salah.');
    const token = await sign({ t: 'sess', r: 'p', u, exp: Date.now() + SESSION_MS });
    return { token, user: petugasPublic(rec) };
  },

  // ----- berkas -----
  'POST file': async (req, b) => {
    const s = await auth(req);
    let owner;
    if (s.r === 'w') owner = s.nik;
    else {
      owner = str(b.forNik, 16);
      if (!/^\d{16}$/.test(owner)) fail(400, 'NIK pemohon tidak valid.');
    }
    const name = str(b.name, 150).replace(/[\\/\r\n"]/g, '_') || 'berkas';
    const type = str(b.type, 100) || 'application/octet-stream';
    const ALLOWED = /^(image\/(jpeg|png)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/;
    if (!ALLOWED.test(type)) fail(400, 'Format berkas tidak didukung.');
    const buf = Buffer.from(String(b.data || ''), 'base64');
    if (!buf.length) fail(400, 'Berkas kosong.');
    if (buf.length > 3.6 * 1024 * 1024) fail(413, 'Berkas melebihi 3,5 MB.');
    const key = `f/${owner}/${randId(12)}`;
    await fs().set(key, buf, { metadata: { name, type, size: buf.length, owner, by: s.r === 'w' ? 'warga' : s.u, at: nowWIB() } });
    return { key };
  },
  'GET file': async (req) => {
    const s = await auth(req);
    const key = new URL(req.url).searchParams.get('key') || '';
    const m = /^f\/(\d{16})\/[a-f0-9]{24}$/.exec(key);
    if (!m) fail(400, 'Kunci berkas tidak valid.');
    if (s.r === 'w' && m[1] !== s.nik) fail(403, 'Akses ditolak.');
    const got = await fs().getWithMetadata(key, { type: 'arrayBuffer' });
    if (!got) fail(404, 'Berkas tidak ditemukan.');
    const md = got.metadata || {};
    return new Response(got.data, {
      headers: {
        'Content-Type': md.type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(md.name || 'berkas')}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },

  // ----- pengajuan -----
  'GET reqs': async (req) => {
    const s = await auth(req);
    return { reqs: await listReqs(s.r === 'w' ? `reqs/${s.nik}/` : 'reqs/') };
  },
  'POST reqs': async (req, b) => {
    const s = await auth(req, 'w');
    const svc = str(b.svc, 10);
    if (!SVC.includes(svc)) fail(400, 'Layanan tidak dikenal.');
    const desa = str(b.desa, 50), name = str(b.name, 100), wa = normPhone(b.wa);
    if (!desa) fail(400, 'Desa wajib dipilih.');
    if (name.length < 2) fail(400, 'Nama wajib diisi.');
    if (!wa) fail(400, 'Nomor WhatsApp tidak valid.');
    const list = Array.isArray(b.files) ? b.files.slice(0, 20) : [];
    const store = fs();
    const files = [];
    for (const f of list) {
      const key = str(f?.key, 80);
      if (!key.startsWith(`f/${s.nik}/`)) fail(400, 'Berkas tidak valid.');
      const meta = await store.getMetadata(key);
      if (!meta) fail(400, 'Ada berkas yang belum terunggah. Coba kirim ulang.');
      files.push({ key, label: str(f.label, 200), name: meta.metadata?.name || 'berkas', type: meta.metadata?.type || '', size: meta.metadata?.size || 0 });
    }
    const t = nowWIB();
    const id = 'WRK-' + Date.now().toString(36).toUpperCase().slice(-5) + crypto.randomBytes(2).toString('hex').toUpperCase();
    const r = { id, svc, jenis: str(b.jenis, 100), desa, ket: str(b.ket, 500), name, wa, nik: s.nik, date: t, ts: Date.now(), status: 1, times: [t], files, outDocs: [] };
    await db().setJSON(reqKey(s.nik, id), r);
    await notify(wa, `WAROK Kecamatan Slahung\n\nPengajuan *${SVC_NAME[svc]}*${r.jenis ? ' (' + r.jenis + ')' : ''} atas nama ${name} sudah kami terima.\nNomor tiket: *${id}*\n\nStatus: ${ST_NAME[1]}. Simpan nomor tiket untuk melacak berkas.`);
    return { req: r };
  },
  'POST reqs-advance': async (req, b) => {
    const s = await auth(req, 'p');
    const r = await getReq(str(b.nik, 16), str(b.id, 30));
    const n = Number(b.status);
    if (n !== r.status + 1 || n > 3) fail(409, 'Status berkas sudah berubah. Muat ulang halaman.');
    r.status = n;
    r.times[n - 1] = nowWIB();
    r.by = s.u;
    await db().setJSON(reqKey(r.nik, r.id), r);
    const msg = n === 2
      ? `Berkas *${r.id}* (${SVC_NAME[r.svc]}) sudah lengkap dan terverifikasi. Sekarang sedang *diproses* petugas.`
      : `Dokumen *${r.id}* (${SVC_NAME[r.svc]}) sudah *SELESAI*. Silakan ambil di kantor Kecamatan Slahung dan bawa KTP-el untuk tanda tangan/cap jempol.`;
    await notify(r.wa, 'WAROK Kecamatan Slahung\n\n' + msg);
    return { req: r };
  },
  'POST outdoc': async (req, b) => {
    await auth(req, 'p');
    const r = await getReq(str(b.nik, 16), str(b.id, 30));
    const key = str(b.key, 80);
    if (!key.startsWith(`f/${r.nik}/`)) fail(400, 'Berkas tidak valid.');
    const meta = await fs().getMetadata(key);
    if (!meta) fail(400, 'Berkas tidak ditemukan.');
    r.outDocs = r.outDocs || [];
    if (!r.outDocs.some((d) => d.k === key)) r.outDocs.push({ k: key, name: meta.metadata?.name || 'dokumen', type: meta.metadata?.type || '', size: meta.metadata?.size || 0, at: nowWIB() });
    await db().setJSON(reqKey(r.nik, r.id), r);
    return { req: r };
  },
  'POST outdoc-delete': async (req, b) => {
    await auth(req, 'p');
    const r = await getReq(str(b.nik, 16), str(b.id, 30));
    const key = str(b.key, 80);
    r.outDocs = (r.outDocs || []).filter((d) => d.k !== key);
    await db().setJSON(reqKey(r.nik, r.id), r);
    if (key.startsWith(`f/${r.nik}/`)) await fs().delete(key).catch(() => {});
    return { req: r };
  },

  // ----- cek perangkat Fonnte (halaman cek-wa.html) -----
  'POST fonnte-status': async (req, b, ctx) => {
    await limit('kode:' + (ctx?.ip || 'x'), 10, 900);
    if (!kodeOk(b.kode)) fail(403, 'Kode salah.');
    const token = env('FONNTE_TOKEN');
    if (!token) return { ok: false, reason: 'FONNTE_TOKEN kosong di server (token belum diisi).' };
    try {
      const r = await fetch('https://api.fonnte.com/device', { method: 'POST', headers: { Authorization: token } });
      const j = await r.json();
      if (j?.status !== true) return { ok: false, reason: j?.reason || 'tidak diketahui' };
      return { ok: true, name: j.name, device: j.device, device_status: j.device_status, package: j.package, quota: j.quota, expired: j.expired };
    } catch { return { ok: false, reason: 'Server tidak bisa menghubungi Fonnte.' }; }
  },
};

export default async (req, context) => {
  const url = new URL(req.url);
  const name = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)\/?/, '').replace(/\/+$/, '');
  const handler = routes[`${req.method} ${name}`];
  if (!handler) return json({ error: 'Alamat API tidak dikenal: ' + req.method + ' /api/' + name }, 404);
  try {
    let body = {};
    if (req.method === 'POST') {
      try { body = await req.json(); } catch { return json({ error: 'Data yang dikirim tidak valid.' }, 400); }
      if (!body || typeof body !== 'object') body = {};
    }
    const out = await handler(req, body, context);
    return out instanceof Response ? out : json(out);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(`[${name}]`, e);
    return json({ error: 'Terjadi kesalahan di server. Coba lagi sebentar.' }, 500);
  }
};

export const config = { path: '/api/*' };
