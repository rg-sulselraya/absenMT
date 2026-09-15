# Master Teacher Attendance

Aplikasi pilot absensi Master Teacher berbasis QR Code, GPS, device binding, dan server timestamp. Aplikasi ini dibuat tanpa dependency runtime eksternal: backend menggunakan Node.js built-in dan penyimpanan lokal JSON. Adapter Google Sheets tersedia dan hanya berjalan di backend.

## Jalankan lokal

```bash
cp .env.example .env
npm start
```

Buka <http://localhost:3000>. Data pilot tersimpan di `data/store.json`. Akun awal:

- Master Teacher: `MT001` / `1234`
- Admin: `admin` / `admin123`

PIN awal langsung di-hash dengan `scrypt` saat store pertama dibuat. Ganti nilai seed di `.env` sebelum menjalankan pertama kali di lingkungan baru. Jangan menghapus atau membagikan `data/store.json` karena berisi data operasional.

## Setup Google Sheets via Google Apps Script

1. Buka spreadsheet `Master Teacher Attendance` yang sudah dibuat dan pastikan tiga tab bernama persis `Master Teacher`, `Branches`, dan `Attendance`.
2. Buka **Extensions → Apps Script** dari spreadsheet tersebut.
3. Salin isi [google-apps-script/Code.gs](/Users/fa-13744/Documents/Codex/2026-09-11/files-pasted-by-the-user-buatkan/google-apps-script/Code.gs) ke editor Apps Script.
4. Di Apps Script buka **Project Settings → Script Properties**, tambahkan:
   - `SPREADSHEET_ID` = ID spreadsheet dari URL.
   - `MTA_API_TOKEN` = opsional. Kosongkan untuk pilot publik; isi token acak panjang untuk keamanan tambahan.
5. Klik **Deploy → New deployment → Web app**, pilih execute as akun Anda dan akses sesuai kebijakan organisasi. Salin URL Web App.
6. Isi `.env` backend (token hanya di server):

```env
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
# Opsional; harus sama dengan MTA_API_TOKEN jika dipakai.
GOOGLE_APPS_SCRIPT_TOKEN=
GOOGLE_SHEETS_TAB=Attendance
```

Apps Script memakai akses spreadsheet dari akun pemilik/deployment, sehingga tidak membutuhkan Service Account. Jika `MTA_API_TOKEN` dikosongkan, backend memakai `doGet` bridge dengan parameter ter-encode agar redirect Web App tetap kompatibel; URL Web App menjadi kunci aksesnya. Mode ini cocok untuk pilot yang memang sengaja membuka akses; untuk produksi gunakan token.

Endpoint Admin untuk koneksi Google Sheets:

- `GET /api/google-sheets/test` — menguji bridge Apps Script dan membaca tiga tab.
- `GET /api/master-teachers` — membaca tab `Master Teacher`.
- `GET /api/branches?source=google` — membaca tab `Branches` melalui route existing.
- `GET /api/attendance?source=google` — membaca tab `Attendance` melalui route existing.
- `POST /api/attendance` — append record ke `Attendance` (khusus Admin; dipakai untuk test/integrasi).

Panel **Pengaturan → Google Sheets → Uji koneksi** menampilkan status tiga tab tanpa mengungkap credential. Apps Script dapat diuji lebih dulu dengan membuka URL Web App di browser; endpoint `doGet` harus mengembalikan pesan bridge aktif.

## Tahap source of truth Master Teacher dan Cabang

Menu **Master Teacher** membaca tab `Master Teacher` melalui `GET /api/master-teachers`, sedangkan menu **Cabang** membaca tab `Branches` melalui `GET /api/branches?source=google`. Jika pembacaan gagal, menu menampilkan error dan tidak diam-diam beralih ke `data/store.json`. Authentication/PIN, Dashboard, Attendance, History, dan proses scan tetap memakai backend/cache lokal pada tahap ini sesuai scope migrasi.

## QR Code cabang

QR statis cukup berisi payload persis ID cabang, contoh `CAB-HRT`. QR dapat dibuat menggunakan generator QR tepercaya lalu dicetak. Backend tetap memvalidasi payload terhadap data cabang aktif; QR bukan sumber koordinat.

## Konfigurasi pilot

Masuk sebagai Admin, buka menu `Cabang`, lalu isi latitude, longitude resmi, alamat, dan radius. Jangan mengisi koordinat perkiraan. `CAB-HRT` adalah seed pilot dan `ACTIVE_BRANCH_ID` dapat dipindahkan ke ID cabang lain melalui `.env` untuk deployment baru.

## Master Teacher dan device

Admin dapat menambah Master Teacher melalui menu `Master Teacher`. PIN hanya dikirim saat membuat/mengubah akun dan disimpan sebagai hash.

Saat login pertama dari perangkat baru, aplikasi mencatat device sebagai `Menunggu otorisasi`. Admin buka menu `Pengaturan`, lalu klik `Otorisasi` pada device tersebut. Admin juga dapat mereset device (kembali ke pending), atau mencabutnya.

## Deploy

Gunakan host Node.js dengan HTTPS/reverse proxy (misalnya Nginx, Render, Railway, Fly.io, atau VPS). Set environment variables di secret manager host, mount penyimpanan persisten untuk `data/store.json`, dan gunakan backup berkala. Untuk produksi sebaiknya ganti store JSON dengan PostgreSQL/SQLite terkelola, tambahkan CSRF protection, logging terpusat, dan rate limiting berbasis Redis.

```bash
NODE_ENV=production npm start
```

Geolocation browser mensyaratkan HTTPS kecuali `localhost`. Kamera juga meminta permission browser. Aplikasi tidak menggunakan selfie pada versi pilot.
