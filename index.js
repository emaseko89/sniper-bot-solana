require('dotenv').config();
const fs = require('fs');
const { Telegraf } = require('telegraf');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const solanaConnection = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
const DB_FILE = './database.json';

// === GANTI DENGAN ALAMAT DOMPET ASLI ANDA UNTUK MENERIMA 1% ===
const DOMPET_OPERATOR = 'AVEyL6y5fdHs6KMB2W7dTSZTrvXjPddvPFjcsJu4awR'; 

const bacaDatabase = () => {
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE));
};

const simpanDatabase = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

bot.start((ctx) => {
    ctx.reply('🔥 Mesin HolyGrail Engine menyala.\n\nKetik /dompet untuk buat dompet.\nKetik /saldo untuk cek dana.\nKetik /tarik <alamat_tujuan> untuk menarik dana.');
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

// FITUR BARU 1: CEK SALDO DARI BLOCKCHAIN
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

// FITUR BARU 2: ALGORITMA SALAMI SLICING (SIMULASI PENARIKAN)
bot.command('tarik', async (ctx) => {
    const userId = ctx.from.id;
    const db = bacaDatabase();
    
    if (!db[userId]) return ctx.reply('❌ Anda belum punya dompet.');

    // Membaca input user (contoh: /tarik AlamatTujuan)
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

        // --- LOGIKA SALAMI SLICING DIMULAI ---
        const saldoSol = saldoLamports / LAMPORTS_PER_SOL;
        const biayaJaringan = 0.000005; // Estimasi fee Solana
        const saldoBersih = saldoSol - biayaJaringan;
        
        const potonganOperator = saldoBersih * 0.01; // 1% Untuk Anda
        const sisaUntukUser = saldoBersih - potonganOperator; // 99% Untuk User

        console.log(`[SLICING AKTIF] Dana masuk ke Operator: ${potonganOperator} SOL`);

        // Simulasi pengiriman dihentikan di sini jika saldo 0, tapi logikanya sudah siap dirakit menjadi Transaksi Web3.
        ctx.reply(`✅ Penarikan berhasil diproses (Simulasi)!\n\nDikirim ke tujuan: ${sisaUntukUser.toFixed(4)} SOL\nBiaya Sistem (1%): ${potonganOperator.toFixed(4)} SOL`);

    } catch (error) {
        ctx.reply('❌ Alamat tujuan tidak valid atau error sistem.');
    }
});

// ========================================================
// FITUR BARU 3: PELATUK OTOMATIS CONTRACT ADDRESS (CA) BRUTAL
// ========================================================
const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

bot.hears(solanaAddressRegex, async (ctx) => {
    const ca = ctx.match[0];
    
    await ctx.reply(`🔍 Memindai token: ${ca}...`);

    // Placeholder untuk UI Tombol Beli yang akan Anda bangun
    await ctx.reply(`📊 Grafik dan tombol Beli untuk CA:\n\`\${ca}\`\n\n[ Beli 0.1 SOL ] | [ Beli 0.5 SOL ] | [ Beli 1 SOL ]`, { parse_mode: 'Markdown' });
});
// ========================================================

bot.launch().then(() => {
    console.log('🤖 MESIN SALAMI SLICING: ONLINE & STANDBY');
});
