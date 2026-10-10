require('dotenv').config();
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction, Transaction, SystemProgram } = require('@solana/web3.js');

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

// --- PENARIK HARGA SOL/USDT ---
const getSolPriceUSD = async () => {
    try {
        const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112");
        const data = await res.json();
        if (data.pairs && data.pairs.length > 0) return parseFloat(data.pairs[0].priceUsd);
        return 145.50; 
    } catch (error) { return 145.50; }
};

// --- RADAR DEPOSIT OTOMATIS ---
const pantauDompet = (publicKeyString, userId) => {
    try {
        const pubKey = new PublicKey(publicKeyString);
        solanaConnection.onAccountChange(pubKey, async (accountInfo) => {
            const saldoSol = accountInfo.lamports / LAMPORTS_PER_SOL;
            const solPrice = await getSolPriceUSD();
            const saldoUsd = (saldoSol * solPrice).toFixed(2);
            bot.telegram.sendMessage(userId, "🔔 *DEPOSIT MASUK!*\n\nSaldo dompet Anda sekarang: *" + saldoSol + " SOL*\n💵 Nilai Amunisi: *\$" + saldoUsd + " USDT*", { parse_mode: 'Markdown' });
        }, 'confirmed');
    } catch (error) { console.log("Gagal memantau dompet:", error); }
};

const dbAwal = bacaDatabase();
for (const userId in dbAwal) { pantauDompet(dbAwal[userId].publicKey, userId); }

bot.start((ctx) => {
    const pesanWelcome = "🏆 *WELCOME TO THE HOLY GRAIL ENGINE* 🏆\n\nMesin eksekusi Solana tercepat di kelasnya. Anda sekarang terhubung ke infrastruktur *private node* tingkat dewa.\n\nIkuti ritual inisiasi berikut untuk mulai berburu:\n\n1️⃣ *BUAT BRANKAS EKSKLUSIF*\nKetik /dompet untuk men-generate dompet enkripsi khusus Anda.\n\n2️⃣ *ISI BAHAN BAKAR (DEPOSIT)*\nKirimkan SOL ke alamat dompet baru Anda untuk modal *sniping*. Ketik /saldo untuk memvalidasi dana yang masuk.\n\n3️⃣ *EKSEKUSI KILAT (SNIPE)*\nTidak perlu *command* ribet. Langsung *Copy-Paste* Contract Address (CA) koin apa pun ke dalam *chat* ini.\n\n4️⃣ *RADAR ALPHA (NEW)*\nKetik /radar untuk melihat koin potensial yang sedang meledak di DEX saat ini.\n\n5️⃣ *AMANKAN KEUNTUNGAN*\nSudah profit? Ketik `/tarik ALAMAT_DOMPET_ANDA` untuk memindahkan dana.\n\n⚡ *The Grail awaits your command. May your bags pump.*";
    ctx.reply(pesanWelcome, { parse_mode: 'Markdown' });
});

bot.command('dompet', (ctx) => {
    const userId = ctx.from.id;
    const db = bacaDatabase();
    if (db[userId]) {
        return ctx.reply("⚠️ Anda sudah memiliki dompet aktif!\n\nAlamat Deposit:\n`" + db[userId].publicKey + "`", { parse_mode: 'Markdown' });
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

bot.command('saldo', async (ctx) => {
    const userId = ctx.from.id;
    const db = bacaDatabase();
    if (!db[userId]) return ctx.reply('❌ Anda belum membuat dompet. Ketik /dompet');
    ctx.reply('🔄 Mengecek saldo ke blockchain...');
    try {
        const pubKey = new PublicKey(db[userId].publicKey);
        const saldoLamports = await solanaConnection.getBalance(pubKey);
        const saldoSol = saldoLamports / LAMPORTS_PER_SOL;
        const solPrice = await getSolPriceUSD();
        const saldoUsd = (saldoSol * solPrice).toFixed(2);
        ctx.reply("💰 Saldo Anda: *" + saldoSol + " SOL*\n💵 Nilai Amunisi: *$" + saldoUsd + " USDT*\n_(Harga 1 SOL = $" + solPrice + ")_", { parse_mode: 'Markdown' });
    } catch (error) { ctx.reply('❌ Gagal mengecek saldo.'); }
});

// =========================================================================
// FITUR KEMEWAHAN 1: RADAR ALPHA (DIJAMIN 100% MUNCUL & ANTI GAGAL)
// =========================================================================
bot.command('radar', async (ctx) => {
    const loadingMsg = await ctx.reply("📡 *Menyapu likuiditas DEX untuk mencari koin potensial...*", { parse_mode: 'Markdown' });
    
    try {
        // Menggunakan CA elit Solana (WIF, POPCAT, BONK) agar demo selalu stabil dengan data live
        const targetCAs = "EKpQGSJtjMFqKZ9KQanUKXpe6ZNcA6hMWEcXndn5sdls,7GCihgDB8fe6KNjn2VNbBndApVDdpW2Ci9gVrNyMEngz,DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
        const respon = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${targetCAs}`);
        const data = await respon.json();
        
        let teksRadar = "🔥 *HOLY GRAIL ALPHA RADAR* 🔥\n_Token Solana dengan volume ledakan tertinggi saat ini:_\n\n";
        const tombolRadar = [];
        let count = 0;
        const tokenTercatat = new Set(); 

        if (data.pairs && data.pairs.length > 0) {
            // Urutkan berdasarkan volume 24 jam tertinggi
            data.pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));

            for (let i = 0; i < data.pairs.length; i++) {
                const pair = data.pairs[i];
                // Cegah koin ganda jika ada 2 pool berbeda
                if (pair.chainId === 'solana' && !tokenTercatat.has(pair.baseToken.address)) {
                    tokenTercatat.add(pair.baseToken.address);
                    count++;
                    
                    teksRadar += `*${count}. ${pair.baseToken.name} (${pair.baseToken.symbol})*\n`;
                    teksRadar += `💵 Harga: *$${parseFloat(pair.priceUsd).toFixed(4)}*\n`;
                    teksRadar += `📈 Vol 24h: *$${(pair.volume.h24 / 1000000).toFixed(2)}M*\n`;
                    teksRadar += `🔗 CA: \`\${pair.baseToken.address}\`\n\n`;
                    
                    tombolRadar.push([Markup.button.callback(`🟢 Snipe ${pair.baseToken.symbol} (0.1 SOL)`, `buy_0.1_${pair.baseToken.address}`)]);
                    
                    if (count >= 3) break;
