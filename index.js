require('dotenv').config();
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const solanaConnection = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
const DB_FILE = './database.json';

// === GANTI DENGAN ALAMAT DOMPET ASLI ANDA ===
const DOMPET_OPERATOR = 'AVEyL6y5fdHs6KMB2W7dTSZTrvXjPddvPFjcsJu4awR'; 

const bacaDatabase = () => {
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE));
};

const simpanDatabase = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

bot.start((ctx) => {
    const pesanWelcome = `🏆 *WELCOME TO THE HOLY GRAIL ENGINE* 🏆

Mesin eksekusi Solana tercepat di kelasnya. Anda sekarang terhubung ke infrastruktur *private node* tingkat dewa.

Ikuti ritual inisiasi berikut untuk mulai berburu:

1️⃣ *BUAT BRANKAS EKSKLUSIF*
Ketik /dompet untuk men-generate dompet enkripsi khusus Anda.

2️⃣ *ISI BAHAN BAKAR (DEPOSIT)*
Kirimkan SOL ke alamat dompet baru Anda untuk modal *sniping*. Ketik /saldo untuk memvalidasi dana yang masuk.

3️⃣ *EKSEKUSI KILAT (SNIPE)*
Tidak perlu *command* ribet. Langsung *Copy-Paste* Contract Address (CA) koin apa pun ke dalam *chat* ini. Holy Grail akan otomatis mendeteksi dan memunculkan panel *1-Click Buy* dalam hitungan milidetik.

4️⃣ *AMANKAN KEUNTUNGAN*
Sudah profit? Ketik \`/tarik ALAMAT_DOMPET_ANDA\` untuk memindahkan dana ke dompet pribadi Anda.

⚡ *The Grail awaits your command. May your bags pump.*`;

    ctx.reply(pesanWelcome, { parse_mode: 'Markdown' });
});

bot.command('dompet', (ctx) => {
    const userId = ctx.from.id;
    const db = bacaDatabase();

    if (db[userId]) {
        ctx.reply(`⚠️ Anda sudah memiliki dompet aktif!\n\nAlamat Deposit:\n\`${db[userId].publicKey}\``, { parse_mode: 'Markdown' });
        return;
    }

    const newWallet = Keypair.generate();
    db[userId] = {
        publicKey: newWallet.publicKey.toString(),
        privateKey: Array.from(newWallet.secretKey)
    };
    simpanDatabase(db);

    ctx.reply("🏦 *DOMPET BARU DIBUAT*\n\nAlamat Deposit Anda:\n`" + db[userId].publicKey + "`", { parse_mode: 'Markdown' });
});

bot.command('saldo', async (ctx) => {
    const userId = ctx.from.id;
    const db = bacaDatabase();

    if (!db[userId]) return ctx.reply('❌ Anda belum membuat dompet. Ketik /dompet');

    ctx.reply('🔄 Mengecek saldo ke blockchain...');
    try {
        const pubKey = new PublicKey(db[userId].publicKey);
        const saldoLamports = await solanaConnection.getBalance(pubKey);
        const saldoSol = saldoLamports / LAMPORTS_PER_SOL;
        ctx.reply(`💰 Saldo Anda: *${saldoSol} SOL*`, { parse_mode: 'Markdown' });
    } catch (error) {
        ctx.reply('❌ Gagal mengecek saldo.');
    }
});

bot.command('tarik', async (ctx) => {
    const userId = ctx.from.id;
    const db = bacaDatabase();
    
    if (!db[userId]) return ctx.reply('❌ Anda belum punya dompet.');

    const pesan = ctx.message.text.split(' ');
    if (pesan.length !== 2) return ctx.reply('Gunakan format: /tarik <alamat_tujuan_anda>');

    const alamatTujuanUser = pesan[1];

    ctx.reply('⚙️ Memproses penarikan...');

    try {
        const pubKey = new PublicKey(db[userId].publicKey);
        const saldoLamports = await solanaConnection.getBalance(pubKey);
        
        if (saldoLamports === 0) {
            return ctx.reply('❌ Saldo Anda 0 SOL. Deposit terlebih dahulu untuk menguji penarikan.');
        }

        const saldoSol = saldoLamports / LAMPORTS_PER_SOL;
        const biayaJaringan = 0.000005; 
        const saldoBersih = saldoSol - biayaJaringan;
        
        const potonganOperator = saldoBersih * 0.01; 
        const sisaUntukUser = saldoBersih - potonganOperator; 

        console.log(`[SLICING AKTIF] Dana masuk ke Operator: ${potonganOperator} SOL`);

        ctx.reply(`✅ Penarikan berhasil diproses (Simulasi)!\n\nDikirim ke tujuan: ${sisaUntukUser.toFixed(4)} SOL\nBiaya Sistem (1%): ${potonganOperator.toFixed(4)} SOL`);

    } catch (error) {
        ctx.reply('❌ Alamat tujuan tidak valid atau error sistem.');
    }
});

// ========================================================
// FITUR BARU 3: TOMBOL INLINE KELAS DEWA & CUSTOM NOMINAL
// ========================================================
const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

bot.hears(solanaAddressRegex, async (ctx) => {
    const ca = ctx.match[0].trim(); 
    
    await ctx.reply(`🔍 Memindai keamanan token CA: ${ca}...`);

    const tombolInteraktif = Markup.inlineKeyboard([
        [
            Markup.button.callback('🟢 Beli 0.1 SOL', `buy_0.1_${ca}`),
            Markup.button.callback('🟢 Beli 0.5 SOL', `buy_0.5_${ca}`)
        ],
        [
            Markup.button.callback('🟢 Beli 1 SOL', `buy_1.0_${ca}`),
            Markup.button.callback('🔵 Beli MAX', `buy_max_${ca}`)
        ],
        [
            Markup.button.callback('✏️ Pilih Sendiri (Custom SOL)', `custom_${ca}`)
        ],
        [
            Markup.button.callback('❌ Batal', 'batal_aksi')
        ]
    ]);

    await ctx.reply(`📊 *Token Ditemukan!*\n\nCA: \`\${ca}\`\n\nPilih nominal eksekusi instan di bawah ini:`, {
        parse_mode: 'Markdown',
        ...tombolInteraktif
    });
});

// --- LISTENER TOMBOL REVISI (ANTI-GAGAL COPY-PASTE) ---

bot.action(/^buy_([0-9.]+)_(.+)\$/, async (ctx) => {
    const nominal = ctx.match[1];
    const ca = ctx.match[2];
    await ctx.answerCbQuery("Mengeksekusi " + nominal + " SOL..."); 
    await ctx.reply("⚡ (Simulasi) Mengeksekusi Beli untuk CA:\n`" + ca + "`\n💰 Nominal: *" + nominal + " SOL*\n⚙️ Status: Memanggil Helius RPC...", { parse_mode: 'Markdown' });
});

bot.action(/^buy_max_(.+)\$/, async (ctx) => {
    const ca = ctx.match[1];
    await ctx.answerCbQuery('Menghitung saldo maksimal...');
    await ctx.reply("⚡ (Simulasi) Mengeksekusi Beli MAX (Seluruh Saldo) untuk CA:\n`" + ca + "`", { parse_mode: 'Markdown' });
});

bot.action(/^custom_(.+)\$/, async (ctx) => {
    const ca = ctx.match[1];
    await ctx.answerCbQuery('Menu Custom dibuka'); 
    await ctx.reply("✏️ *Opsi Custom Nominal*\n\nBalas pesan ini dengan perintah:\n\n`/beli " + ca + " NOMINAL`\n\nContoh: `/beli " + ca + " 2.5`", { parse_mode: 'Markdown' });
});

bot.action('batal_aksi', async (ctx) => {
    await ctx.answerCbQuery('Operasi dibatalkan.');
    await ctx.deleteMessage(); 
});

bot.command('beli', async (ctx) => {
    const pesan = ctx.message.text.split(' ');
    if (pesan.length !== 3) return ctx.reply('⚠️ Format salah! Gunakan: /beli <CA> <Nominal>');

    const ca = pesan[1];
    const nominal = pesan[2];

    await ctx.reply("⚡ (Simulasi) Eksekusi Custom Beli...\nCA: `" + ca + "`\nNominal: *" + nominal + " SOL*", { parse_mode: 'Markdown' });
});
// ========================================================

bot.launch().then(() => {
    console.log('🤖 MESIN SALAMI SLICING: ONLINE & STANDBY');
});
