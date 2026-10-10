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

// --- FITUR BARU 3: PENARIK HARGA SOL/USDT REAL-TIME (BINANCE) ---
const getSolPriceUSD = async () => {
    try {
        const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
        const data = await res.json();
        return parseFloat(data.price);
    } catch (error) {
        return 0;
    }
};

// --- UPDATE RADAR DEPOSIT (DENGAN ESTIMASI USDT) ---
const pantauDompet = (publicKeyString, userId) => {
    try {
        const pubKey = new PublicKey(publicKeyString);
        solanaConnection.onAccountChange(pubKey, async (accountInfo) => {
            const saldoSol = accountInfo.lamports / LAMPORTS_PER_SOL;
            const solPrice = await getSolPriceUSD();
            const saldoUsd = (saldoSol * solPrice).toFixed(2);
            
            const teksUsd = solPrice > 0 ? "\n💵 Nilai Amunisi: *\$" + saldoUsd + " USDT*" : "";
            
            bot.telegram.sendMessage(userId, "🔔 *DEPOSIT MASUK!*\n\nSaldo dompet Anda sekarang: *" + saldoSol + " SOL*" + teksUsd, { parse_mode: 'Markdown' });
        }, 'confirmed');
    } catch (error) {
        console.log("Gagal memantau dompet:", error);
    }
};

const dbAwal = bacaDatabase();
for (const userId in dbAwal) {
    pantauDompet(dbAwal[userId].publicKey, userId);
}

bot.start((ctx) => {
    const pesanWelcome = "🏆 *WELCOME TO THE HOLY GRAIL ENGINE* 🏆\n\nMesin eksekusi Solana tercepat di kelasnya. Anda sekarang terhubung ke infrastruktur *private node* tingkat dewa.\n\nIkuti ritual inisiasi berikut untuk mulai berburu:\n\n1️⃣ *BUAT BRANKAS EKSKLUSIF*\nKetik /dompet untuk men-generate dompet enkripsi khusus Anda.\n\n2️⃣ *ISI BAHAN BAKAR (DEPOSIT)*\nKirimkan SOL ke alamat dompet baru Anda untuk modal *sniping*. Ketik /saldo untuk memvalidasi dana yang masuk.\n\n3️⃣ *EKSEKUSI KILAT (SNIPE)*\nTidak perlu *command* ribet. Langsung *Copy-Paste* Contract Address (CA) koin apa pun ke dalam *chat* ini. Holy Grail akan otomatis mendeteksi dan memunculkan panel *1-Click Buy* dalam hitungan milidetik.\n\n4️⃣ *AMANKAN KEUNTUNGAN*\nSudah profit? Ketik `/tarik ALAMAT_DOMPET_ANDA` untuk memindahkan dana ke dompet pribadi Anda.\n\n⚡ *The Grail awaits your command. May your bags pump.*";
    ctx.reply(pesanWelcome, { parse_mode: 'Markdown' });
});

bot.command('dompet', (ctx) => {
    const userId = ctx.from.id;
    const db = bacaDatabase();

    if (db[userId]) {
        ctx.reply("⚠️ Anda sudah memiliki dompet aktif!\n\nAlamat Deposit:\n`" + db[userId].publicKey + "`", { parse_mode: 'Markdown' });
        return;
    }

    const newWallet = Keypair.generate();
    db[userId] = {
        publicKey: newWallet.publicKey.toString(),
        privateKey: Array.from(newWallet.secretKey)
    };
    simpanDatabase(db);
    
    pantauDompet(db[userId].publicKey, userId);

    ctx.reply("🏦 *DOMPET BARU DIBUAT*\n\nAlamat Deposit Anda:\n`" + db[userId].publicKey + "`", { parse_mode: 'Markdown' });
});

// --- UPDATE CEK SALDO (DENGAN ESTIMASI USDT) ---
bot.command('saldo', async (ctx) => {
    const userId = ctx.from.id;
    const db = bacaDatabase();
    if (!db[userId]) return ctx.reply('❌ Anda belum membuat dompet. Ketik /dompet');
    
    ctx.reply('🔄 Mengecek saldo ke blockchain...');
    try {
        const pubKey = new PublicKey(db[userId].publicKey);
        const saldoLamports = await solanaConnection.getBalance(pubKey);
        const saldoSol = saldoLamports / LAMPORTS_PER_SOL;
        
        // Tarik harga USDT
        const solPrice = await getSolPriceUSD();
        const saldoUsd = (saldoSol * solPrice).toFixed(2);
        const teksUsd = solPrice > 0 ? "\n💵 Nilai: *\$" + saldoUsd + " USDT*" : "";

        ctx.reply("💰 Saldo Anda: *" + saldoSol + " SOL*" + teksUsd, { parse_mode: 'Markdown' });
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
    ctx.reply('⚙️ Memproses penarikan...');
    try {
        const pubKey = new PublicKey(db[userId].publicKey);
        const saldoLamports = await solanaConnection.getBalance(pubKey);
        if (saldoLamports === 0) return ctx.reply('❌ Saldo Anda 0 SOL. Deposit terlebih dahulu.');
        const saldoSol = saldoLamports / LAMPORTS_PER_SOL;
        const saldoBersih = saldoSol - 0.000005; 
        const potonganOperator = saldoBersih * 0.01; 
        const sisaUntukUser = saldoBersih - potonganOperator; 
        ctx.reply("✅ Penarikan berhasil diproses (Simulasi)!\n\nDikirim ke tujuan: " + sisaUntukUser.toFixed(4) + " SOL\nBiaya Sistem (1%): " + potonganOperator.toFixed(4) + " SOL");
    } catch (error) {
        ctx.reply('❌ Alamat tujuan tidak valid atau error sistem.');
    }
});

const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

bot.hears(solanaAddressRegex, async (ctx) => {
    const teksPesan = ctx.message.text;
    if (teksPesan.toLowerCase().includes('0x')) return;
    
    const ca = ctx.match[0].trim(); 
    const loadingMsg = await ctx.reply("🔍 Memindai data token di DEX...");

    try {
        const respon = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + ca);
        const data = await respon.json();

        let namaToken = "Token Tidak Dikenal";
        let hargaToken = "0.00";

        if (data.pairs && data.pairs.length > 0) {
            const pair = data.pairs[0]; 
            namaToken = pair.baseToken.name + " (" + pair.baseToken.symbol + ")";
            hargaToken = pair.priceUsd;
        } else {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, "⚠️ Token belum terdaftar di DEX atau likuiditas kosong.");
            return;
        }

        const tombolInteraktif = Markup.inlineKeyboard([
            [Markup.button.callback('🟢 Beli 0.1 SOL', "buy_0.1_" + ca), Markup.button.callback('🟢 Beli 0.5 SOL', "buy_0.5_" + ca)],
            [Markup.button.callback('🟢 Beli 1 SOL', "buy_1.0_" + ca), Markup.button.callback('🔵 Beli MAX', "buy_max_" + ca)],
            [Markup.button.callback('✏️ Pilih Sendiri', "custom_" + ca)],
            [Markup.button.callback('❌ Batal', 'batal_aksi')]
        ]);

        const teksBalasan = "📊 *Token Ditemukan!*\n\n💎 Koin: *" + namaToken + "*\n💵 Harga: *\$" + hargaToken + "*\n🔗 CA: `" + ca + "`\n\nPilih nominal eksekusi instan di bawah ini:";

        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, teksBalasan, {
            parse_mode: 'Markdown',
            ...tombolInteraktif
        });

    } catch (error) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, "❌ Gagal terhubung ke jaringan API DexScreener.");
    }
});

bot.action(/^buy_([0-9.]+)_(.+)\$/, async (ctx) => {
    const nominal = ctx.match[1];
    const ca = ctx.match[2];
    await ctx.answerCbQuery("Mengeksekusi " + nominal + " SOL..."); 
    await ctx.reply("⚡ (Simulasi) Mengeksekusi Beli:\n🔗 CA: `" + ca + "`\n💰 Nominal: *" + nominal + " SOL*\n⚙️ Status: Memanggil Helius RPC...", { parse_mode: 'Markdown' });
});

bot.action(/^buy_max_(.+)\$/, async (ctx) => {
    const ca = ctx.match[1];
    await ctx.answerCbQuery('Menghitung saldo maksimal...');
    await ctx.reply("⚡ (Simulasi) Mengeksekusi Beli MAX untuk:\n🔗 CA: `" + ca + "`", { parse_mode: 'Markdown' });
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
    await ctx.reply("⚡ (Simulasi) Eksekusi Custom Beli...\n🔗 CA: `" + ca + "`\n💰 Nominal: *" + nominal + " SOL*", { parse_mode: 'Markdown' });
});

bot.launch().then(() => {
    console.log('🤖 MESIN SALAMI SLICING: ONLINE & STANDBY');
});
