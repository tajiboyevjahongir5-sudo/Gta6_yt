# Lahza — stream'lardan avtomatik YouTube kanal

**Lahza** uzun jonli efir yozuvlarini (GTA 6 va boshqa o'yinlar) oladi, eng qiziq lahzalarni o'zi topadi, montaj qiladi
va YouTube kanalingizga **prevyu, nom, tavsif, teglar va taym-kodlar** bilan yuklaydi. Hammasi Telegram bot va
Telegram Web App orqali boshqariladi.

```
Havola / kuzatilgan kanal ─► yuklab olish (yt-dlp) ─► tahlil: ovoz + harakat ─► AI kadrlarni baholaydi
   ─► montaj (ffmpeg): 10 daqiqalik kompilyatsiya + Shorts'lar + prevyu
   ─► botga "✅ Tasdiqlash" ─► jadval bo'yicha YouTube'ga yuklash ─► statistika
```

## Nima qila oladi

| Bo'lim | Imkoniyat |
|---|---|
| **Lahza qidirish** | Har soniyaning ovoz balandligi (qichqiriq, kulgi, portlash) va sahna o'zgarishlari (quvish, avariya) bo'yicha ball. 6 soatlik efir ham bir necha daqiqada tahlil qilinadi |
| **AI** (ixtiyoriy) | Claude har bir nomzod lahzadan kadrlarni ko'rib 0–10 baho beradi (menyu, yuklanish ekrani, AFK — past ball), izoh, nom, tavsif, 12–20 teg va prevyu yozuvini yozadi. Til: o'zbek / rus / ingliz |
| **Montaj** | 16:9 kompilyatsiya (raqamlangan lahzalar, silliq o'tishlar, ovoz −14 LUFS ga tenglashtiriladi), 9:16 Shorts (xira fon, kattalashtirilgan o'yin, katta sarlavha) |
| **Subtitr** (Shorts) | Nutq so'zma-so'z yoziladi (faster-whisper, o'zbek/rus/ingliz), aytilayotgan so'z sariq bo'lib ajralib turadi. Joylashuvi YouTube interfeysiga moslangan — pastga qarang |
| **Prevyu** | 1280×720, eng kuchli kadr, to'yingan ranglar, katta qalin yozuv, "GTA 6" belgisi. Panelda yozuvni o'zgartirib qayta chizish mumkin |
| **Tavsif** | AI matni + avtomatik taym-kodlar (YouTube bo'limlari) + original stream muallifi havolasi + sizning doimiy oxiringiz |
| **Nashr** | Tasdiqlab yoki avto-rejimda; belgilangan vaqtlarda (masalan 13:00 va 19:00), kunlik limit bilan |
| **Manbalar** | YouTube / Twitch / Kick kanallarini kuzatadi: efir tugab yozuvi chiqqach (sarlavhada "GTA" bo'lsa, 30+ daqiqa) o'zi navbatga qo'yadi |
| **Statistika** | Obunachilar, kunlik ko'rishlar, Video vs Shorts, eng ko'p ko'rilganlar |

### Shorts maketi va xavfsiz zona
YouTube Shorts ekranining bir qismini o'z tugmalari bilan yopadi. Manbalar har xil raqam beradi, shuning uchun eng ehtiyotkor
qiymatlar olingan (1080×1920 kadrda, `src/subtitles.js` → `SAFE`):

| Zona | Nima turadi | Chegara |
|---|---|---|
| Pastki 672px | kanal nomi, Obuna, nom/tavsif, musiqa | subtitr shundan **yuqorida** tugaydi |
| O'ng 192px | layk, dizlayk, koment, ulashish, remiks | subtitr va sarlavha shundan **chapda**, bo'sh joy markazida (x≈468) |
| Yuqori 288px | qidiruv, menyu | sarlavha shundan **pastda** boshlanadi |

Tartib: sarlavha (tepada) → o'yin kadri (o'rtada, kattalashtirilgan) → subtitr (pastda, tavsif ustida).
Panel → Kliplar → Shorts → **"📐 YouTube interfeysini ko'rsatish"** — tasdiqlashdan oldin tugmalar va tavsif qayerga tushishini
video ustida ko'rasiz.

### Web App sahifalari
- **Asosiy** — kanal ko'rsatkichlari, havola qo'shish, hozir ishlanayotganlar, keyingi yuklashlar, hodisalar
- **Navbat** — har bir video holati (yuklanmoqda / tahlil / montaj), foiz, qayta urinish
- **Kliplar** — videoni ko'rish, nom/tavsif/teg/prevyu tahriri, tasdiqlash, "hozir yuklash", rad etish
- **Statistika** — 7/30/90 kunlik grafiklar va top videolar
- **Manbalar** — kuzatiladigan kanallar, filtr, mualliflik
- **Sozlamalar** (⚙️) — YouTube ulash, jadval, montaj, til, teglar, prevyu rangi

### Bot buyruqlari
Havola yuborish — navbatga qo'shadi · `/navbat` · `/kliplar` · `/stat` · `/yordam`.
Har bir tayyor klip prevyu bilan keladi: **✅ Tasdiqlash / 🚀 Hozir yuklash / ❌ Rad etish**.

## O'rnatish

### 1. Server
Video montaj kuchli protsessor va disk talab qiladi, shuning uchun bepul hostinglar (Render free va h.k.) **yaramaydi**.
Tavsiya: 4 vCPU / 8 GB RAM / 160 GB disk VPS (Hetzner CX32 / CPX31 ~ 8–15 €/oy) + Docker.

```bash
git clone <repo> && cd <repo>/lahza
cp .env.example .env   # va to'ldiring (pastda)
docker compose up -d --build
```
HTTPS kerak (Telegram Web App va Google buni talab qiladi): domen + Caddy/Nginx yoki Cloudflare Tunnel.
Docker'siz: Node 22.13+, `ffmpeg`, `yt-dlp`, subtitr uchun `pip install faster-whisper` o'rnating, keyin `npm install && npm start`.

### 2. Telegram bot
1. @BotFather → `/newbot` → tokenni `BOT_TOKEN` ga yozing.
2. O'z ID'ingizni `ADMIN_IDS` ga yozing (bilmasangiz botga yozing — u ID'ingizni aytadi).
3. `PUBLIC_URL` to'g'ri bo'lsa bot menyusida "Panel" tugmasi o'zi paydo bo'ladi.

### 3. YouTube API
1. [Google Cloud Console](https://console.cloud.google.com/) → yangi loyiha → **YouTube Data API v3** ni yoqing.
2. **OAuth consent screen**: External, o'z emailingizni *Test users* ga qo'shing.
3. **Credentials → OAuth client ID → Web application**, redirect URI: `https://SIZNING-DOMEN/oauth/google/callback`.
4. Client ID / Secret ni `.env` ga yozing, Panel → ⚙️ → **YouTube kanalni ulash**.
5. Kanalni telefon orqali tasdiqlang (youtube.com/verify) — aks holda maxsus prevyu va 15 daqiqadan uzun video yuklab bo'lmaydi.

> **Muhim:** Google API limiti kuniga 10 000 birlik, bitta yuklash ≈ 1600 → **kuniga ~6 video**. Ko'proq kerak bo'lsa
> Google'dan limit oshirishni so'rang (YouTube API Services audit formasi). Ilova "Testing" holatida bo'lsa
> ulanish 7 kunda eskiradi — ilovani **Publish** qiling.
> **Eng muhimi:** auditdan o'tmagan (unverified) API loyihasi orqali yuklangan videolar YouTube tomonidan **yopiq (private)**
> holatda qulflanadi. Ochiq yuklash uchun loyihani **YouTube API Services audit**dan o'tkazing (bepul, odatda bir necha hafta).
> Audit tugaguncha bot videolarni tayyorlab beradi, siz ularni Panel'dan yuklab olib qo'lda joylashingiz mumkin.

### 4. AI (tavsiya etiladi)
[console.anthropic.com](https://console.anthropic.com) dan kalit oling → `ANTHROPIC_API_KEY`. Bitta stream uchun bitta so'rov
(~32 kichik kadr + matn), taxminan $0.05–0.15. Kalitsiz ham ishlaydi: lahzalar faqat ovoz/harakat bo'yicha, matnlar shablondan.

## ⚠️ Mualliflik huquqi — daromad uchun eng muhim qism
Boshqa streamerning videosini ruxsatsiz qayta yuklash — mualliflik huquqi buzilishi. Natijada: Content ID da'volari,
**strike** (3 ta = kanal o'chadi) va YouTube Partner dasturiga **"reused content"** sababli qabul qilinmaslik.
Barqaror daromad uchun:
- **Streamerlardan ruxsat oling.** Ko'p streamerlar klipchilarni xush ko'radi (ularga reklama). Ko'pchilik daromadni bo'lishishni taklif qiladi.
  Manbalar'da "ruxsat bor" belgisini qo'ying, muallif nomi har tavsifga avtomatik yoziladi.
- **O'z streamlaringiz** — eng xavfsiz variant.
- **Qo'shimcha qiymat qo'shing:** o'z izohingiz, ovozingiz, reaksiyangiz — YouTube "transformativ" kontentni monetizatsiya qiladi,
  shunchaki kesib qo'yilganini emas.
- Rockstar o'yin videolarini (gameplay) monetizatsiya qilishga ruxsat beradi, lekin bu **streamerning** yozuviga (yuzi, ovozi) huquq bermaydi.

## Tuzilishi
```
lahza/
  server.js        HTTP API, Web App, bot buyruqlari, OAuth callback
  src/pipeline.js  navbat, ishlov berish, jadval, yuklash, statistika, manbalarni kuzatish
  src/analyze.js   ovoz/harakat bo'yicha lahzalarni topish
  src/render.js    ffmpeg: kompilyatsiya, Shorts, prevyu
  src/ai.js        Claude: baholash + metadata (kalitsiz — shablon)
  src/youtube.js   OAuth, yuklash, prevyu, statistika
  src/telegram.js  bot (long polling), initData tekshiruvi
  src/db.js        SQLite (node:sqlite) va sozlamalar
  public/          Web App (index.html, app.js, style.css)
```
Ma'lumotlar `DATA_DIR` da: `lahza.db`, `work/` (vaqtinchalik), `out/` (tayyor kliplar). Yuklangan kliplarni vaqti-vaqti bilan tozalang.

## Keyingi qadamlar (g'oyalar)
- Twitch chat faolligi bo'yicha lahza topish (chat "LUL/KEKW" bilan portlagan joylar — eng aniq signal)
- Subtitr matnini AI bilan tuzatish (Whisper o'zbek tilida ba'zan adashadi)
- Bir nechta kanal (o'zbekcha va ruscha) va TikTok / Instagram Reels'ga ham yuklash
- Prevyu A/B test (YouTube "Test & Compare")
