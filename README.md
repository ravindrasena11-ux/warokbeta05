# WAROK – Wadah Administrasi Registrasi Online Kecamatan

Layanan PATEN digital Kecamatan Slahung, Kabupaten Ponorogo. Warga dapat mengajukan berkas
(Kartu Keluarga, Surat Pindah, Akta Kelahiran, Akta Kematian), mengunggah persyaratan, dan
melacak status. Petugas memeriksa berkas, memperbarui status, dan mengunggah dokumen hasil.
Notifikasi dan kode OTP dikirim lewat WhatsApp (Fonnte).

## Struktur

```
index.html                  Aplikasi utama (warga & petugas)
cek-wa.html                 Halaman pengelola: cek status perangkat Fonnte
netlify/functions/api.mjs   Backend semua endpoint /api/*
netlify.toml                Konfigurasi Netlify
package.json                Dependensi (@netlify/blobs)
.env.example                Contoh variabel lingkungan
```

Data akun, pengajuan, dan berkas disimpan di **Netlify Blobs** (tanpa database terpisah).

## Deploy ke Netlify dari GitHub

1. Di Netlify: **Add new site → Import an existing project → GitHub**, pilih repositori ini.
   Build command dibiarkan kosong; pengaturan lain sudah ada di `netlify.toml`.
2. Buka **Site configuration → Environment variables**, isi:

   | Variabel | Keterangan |
   |---|---|
   | `FONNTE_TOKEN` | Opsional. Token bawaan sudah terpasang di `api.mjs`. Isi variabel ini hanya jika token Fonnte berganti. |
   | `PETUGAS_KODE` | Opsional. Kode bawaan sudah terpasang di `api.mjs` (dalam bentuk hash). Isi variabel ini hanya jika ingin menggantinya. |
   | `OTP_SECRET` | Opsional. Teks acak ≥ 32 karakter. Jika kosong, server membuatnya sendiri. |

3. **Deploys → Trigger deploy** agar variabel terbaca.
4. Buka `https://<situs-anda>/cek-wa.html`, masukkan kode petugas, pastikan status **Tersambung**.

> **Penting:** `api.mjs` berisi token Fonnte. Repositori ini harus **Private**. Jika pernah
> terbuka publik, segera buat token baru di dashboard Fonnte dan isi lewat Environment variables.

## Endpoint API

| Metode | Alamat | Fungsi |
|---|---|---|
| POST | `/api/otp-send` | Kirim kode OTP ke WhatsApp |
| POST | `/api/warga-check`, `/api/warga-register`, `/api/warga-login` | Akun warga |
| POST | `/api/petugas-check`, `/api/petugas-register`, `/api/petugas-login` | Akun petugas |
| GET/POST | `/api/reqs` | Daftar / buat pengajuan |
| POST | `/api/reqs-advance` | Petugas memajukan status |
| GET/POST | `/api/file` | Unduh / unggah berkas |
| POST | `/api/outdoc`, `/api/outdoc-delete` | Dokumen hasil dari petugas |
| POST | `/api/fonnte-status` | Status perangkat Fonnte (untuk `cek-wa.html`) |

## Menjalankan secara lokal

```bash
npm install
npx netlify-cli dev
```

Isi variabel di file `.env` (salin dari `.env.example`). File `.env` tidak ikut ke GitHub.

## Masalah umum

- **Kode OTP tidak masuk** → buka `cek-wa.html`. Biasanya token salah (pakai token perangkat),
  perangkat terputus (scan ulang QR di Fonnte), atau kuota habis. Jangan menguji dengan nomor
  yang sama dengan nomor pengirim.
- **"Server API belum terpasang (404)"** → pastikan folder `netlify/functions` ikut ter-push dan
  deploy terakhir berhasil.

---
© 2026 Kecamatan Slahung, Kabupaten Ponorogo
