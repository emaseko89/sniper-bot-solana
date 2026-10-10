require('dotenv').config();
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction, Transaction, SystemProgram } = require('@solana/web3.js');

// 1. Panggil Kamus Bahasa
const locales = require('./locales');

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

// 2. Fungsi Ekstraktor Teks Dinamis (Text Engine)
const t = (lang, key, params = {}) => {
    // Ambil string dari kamus (default ke 'en' jika bahasa target tidak punya string)
    let text = locales[lang][key] || locales['en'][key] || key;
    // Timpa semua variabel dinamis {variabel}
    for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`{${k}}`, 'g'), v);
    }
    return text;
};

// 3. Fungsi Pendeteksi Bahasa Otomatis
const getUserLang = (ctx) => {
    let lang = ctx.from.language_code?.substring(0, 2) || 'en';
    if (!locales[lang]) {
        lang = 'en'; 
    }
    return lang;
};

const getSolPriceUSD = async () => {
    try {
        const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112");
        const data = await res.json();
        if (data.pairs && data.pairs.length > 0) return parseFloat(data.pairs[0].priceUsd);
        return 145.50; 
    } catch (error) { return 145.50; }
};

const pantauDompet = (publicKeyString, userId) => {
    try {
        const pubKey = new PublicKey(publicKeyString);
        solanaConnection.onAccountChange(pubKey, async (accountInfo) => {
            const saldoSol = accountInfo.lamports / LAMPORTS_PER_SOL;
            const solPrice = await getSolPriceUSD();
            const saldoUsd = (saldoSol * solPrice).toFixed(2);
            
            // Tarik bahasa preferensi user dari database (Default 'en')
            const db = bacaDatabase();
            const lang = db[userId]?.lang || 'en';
            
            bot.telegram.sendMessage(
                userId, 
                t(lang, 'deposit_alert', { sol: saldoSol, usd: saldoUsd }), 
                { parse_mode: 'Markdown' }
            );
        }, 'confirmed');
    } catch (error) { console.log("Gagal memantau dompet:", error); }
};

const dbAwal = bacaDatabase();
for (const userId in dbAwal) { pantauDompet(dbAwal[userId].publicKey, userId); }

bot.start((ctx) => {
    const lang = getUserLang(ctx);
    
    // Simpan bahasa preferensi pengguna ke database
    const userId = ctx.from.id;
    const db = bacaDatabase();
    if (!db[userId]) {
        db[userId] = {}; // Jika belum punya database wallet, set objek kosong sementara
    }
    db[userId].lang = lang; // Simpan memori bahasa
    simpanDatabase(db);
    
    ctx.reply(t(lang, 'welcome'), { parse_mode: 'Markdown' });
});

bot.command('dompet', (ctx) => {
    const lang = getUserLang(ctx);
    const userId = ctx.from.id;
    const db = bacaDatabase();
    
    if (db[userId] && db[userId].publicKey) {
        return ctx.reply(t(lang, 'wallet_exists', { address: db[userId].publicKey }), { parse_mode: 'Markdown' });
    }
    
    const newWallet = Keypair.generate();
    db[userId] = {
        publicKey: newWallet.publicKey.toString(),
        privateKey: Array.from(newWallet.secretKey),
        lang: lang
    };
    simpanDatabase(db);
    pantauDompet(db[userId].publicKey, userId);
    
    ctx.reply(t(lang, 'wallet_created', { address: db[userId].publicKey }), { parse_mode: 'Markdown' });
});

bot.command('saldo', async (ctx) => {
    const lang = getUserLang(ctx);
    const userId = ctx.from.id;
    const db = bacaDatabase();
    
    if (!db[userId] || !db[userId].publicKey) return ctx.reply(t(lang, 'no_wallet'));
    
    ctx.reply(t(lang, 'check_balance'));
    try {
        const pubKey = new PublicKey(db[userId].publicKey);
        const saldoLamports = await solanaConnection.getBalance(pubKey);
        const saldoSol = saldoLamports / LAMPORTS_PER_SOL;
        const solPrice = await getSolPriceUSD();
        const saldoUsd = (saldoSol * solPrice).toFixed(2);
        
        ctx.reply(t(lang, 'balance_info', { sol: saldoSol, usd: saldoUsd, price: solPrice }), { parse_mode: 'Markdown' });
    } catch (error) { ctx.reply(t(lang, 'balance_error')); }
});

bot.command('radar', async (ctx) => {
    const lang = getUserLang(ctx);
    const loadingMsg = await ctx.reply(t(lang, 'radar_scanning'), { parse_mode: 'Markdown' });
    
    try {
        const targetCAs = "EKpQGSJtjMFqKZ9KQanUKXpe6ZNcA6hMWEcXndn5sdls,7GCihgDB8fe6KNjn2VNbBndApVDdpW2Ci9gVrNyMEngz,DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
        const respon = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + targetCAs);
        const data = await respon.json();
        
        let teksRadar = t(lang, 'radar_header');
        const tombolRadar = [];
        let count = 0;
        const tokenTercatat = new Set(); 
        
        if (data.pairs && data.pairs.length > 0) {
            data.pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
            for (let i = 0; i < data.pairs.length; i++) {
                const pair = data.pairs[i];
                if (pair.chainId === 'solana' && !tokenTercatat.has(pair.baseToken.address)) {
                    tokenTercatat.add(pair.baseToken.address);
                    count++;
                    teksRadar += t(lang, 'radar_item', {
                        count: count,
                        name: pair.baseToken.name,
                        symbol: pair.baseToken.symbol,
                        price: parseFloat(pair.priceUsd).toFixed(4),
                        vol: (pair.volume.h24 / 1000000).toFixed(2),
                        ca: pair.baseToken.address
                    });
                    
                    tombolRadar.push([Markup.button.callback(t(lang, 'radar_btn_snipe', { symbol: pair.baseToken.symbol }), "buy_0.1_" + pair.baseToken.address)]);
                    if (count >= 3) break; 
                }
            }
        }
        tombolRadar.push([Markup.button.callback(t(lang, 'radar_btn_close'), 'batal_aksi')]);
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, teksRadar, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(tombolRadar) });
    } catch (error) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, t(lang, 'radar_error'));
    }
});

bot.command('tarik', async (ctx) => {
    const lang = getUserLang(ctx);
    const userId = ctx.from.id;
    const db = bacaDatabase();
    
    if (!db[userId] || !db[userId].publicKey) return ctx.reply(t(lang, 'no_wallet'));

    const pesan = ctx.message.text.split(' ');
    if (pesan.length !== 2) return ctx.reply(t(lang, 'withdraw_format'), { parse_mode: 'Markdown' });

    const alamatTujuan = pesan[1];
    const pesanProses = await ctx.reply(t(lang, 'withdraw_process'), { parse_mode: 'Markdown' });

    try {
        const pubKeyTujuan = new PublicKey(alamatTujuan);
        const secretKey = Uint8Array.from(db[userId].privateKey);
        const userKeypair = Keypair.fromSecretKey(secretKey);

        const saldoLamports = await solanaConnection.getBalance(userKeypair.publicKey);
        const biayaTransfer = 5000; 
        
        if (saldoLamports <= biayaTransfer) {
            return ctx.telegram.editMessageText(ctx.chat.id, pesanProses.message_id, null, t(lang, 'withdraw_insufficient'), { parse_mode: 'Markdown' });
        }

        const lamportsKirim = saldoLamports - biayaTransfer;

        const tarikTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: userKeypair.publicKey,
                toPubkey: pubKeyTujuan,
                lamports: lamportsKirim,
            })
        );

        tarikTx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash;
        tarikTx.feePayer = userKeypair.publicKey;
        tarikTx.sign(userKeypair);

        const txid = await solanaConnection.sendTransaction(tarikTx);
        const saldoTerkirim = (lamportsKirim / LAMPORTS_PER_SOL).toFixed(4);
        
        const teksSukses = t(lang, 'withdraw_success', { amount: saldoTerkirim, address: alamatTujuan, txid: txid });
        await ctx.telegram.editMessageText(ctx.chat.id, pesanProses.message_id, null, teksSukses, { parse_mode: 'Markdown', disable_web_page_preview: true });

    } catch (error) {
        await ctx.telegram.editMessageText(ctx.chat.id, pesanProses.message_id, null, t(lang, 'withdraw_fail'), { parse_mode: 'Markdown' });
    }
});

bot.command('export', (ctx) => {
    const lang = getUserLang(ctx);
    const userId = ctx.from.id;
    const db = bacaDatabase();
    
    if (!db[userId] || !db[userId].publicKey) return ctx.reply(t(lang, 'no_wallet'));
    
    ctx.reply(t(lang, 'export_warn', { pkey: db[userId].privateKey.join(',') }), { parse_mode: 'Markdown' });
});

const eksekusiBeli = async (ctx, ca, nominalSol, isMax = false) => {
    const lang = getUserLang(ctx);
    const userId = ctx.from.id;
    const db = bacaDatabase();
    
    if (!db[userId] || !db[userId].publicKey) return ctx.reply(t(lang, 'no_wallet'));

    const pesanProses = await ctx.reply(t(lang, 'buy_process_1'), { parse_mode: 'Markdown' });

    try {
        const secretKey = Uint8Array.from(db[userId].privateKey);
        const userKeypair = Keypair.fromSecretKey(secretKey);
        
        const saldoLamports = await solanaConnection.getBalance(userKeypair.publicKey);
        const saldoSol = saldoLamports / LAMPORTS_PER_SOL;
        
        const estimasiGas = 0.0035;
        let eksekusiSol = isMax ? (saldoSol - estimasiGas) : parseFloat(nominalSol);
        const totalDibutuhkan = eksekusiSol + estimasiGas;

        if (eksekusiSol <= 0 || saldoSol < totalDibutuhkan) {
            return ctx.telegram.editMessageText(ctx.chat.id, pesanProses.message_id, null, t(lang, 'buy_insufficient', { balance: saldoSol.toFixed(4), needed: totalDibutuhkan.toFixed(4) }), { parse_mode: 'Markdown' });
        }

        await ctx.telegram.editMessageText(ctx.chat.id, pesanProses.message_id, null, t(lang, 'buy_confirmed'), { parse_mode: 'Markdown' });

        const totalLamportsBuy = Math.floor(eksekusiSol * LAMPORTS_PER_SOL);
        const feeLamports = Math.floor(totalLamportsBuy * 0.01);
        const swapLamports = totalLamportsBuy - feeLamports;

        await ctx.reply(t(lang, 'buy_step_1'), { parse_mode: 'Markdown' });

        const jupQuoteUrl = "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=" + ca + "&amount=" + swapLamports + "&slippageBps=1500"; 
        const quoteRes = await fetch(jupQuoteUrl);
        const quoteData = await quoteRes.json();
        if (quoteData.error) throw new Error(quoteData.error);

        const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quoteResponse: quoteData,
                userPublicKey: userKeypair.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: 100000 
            })
        });
        const swapData = await swapRes.json();
        if (swapData.error) throw new Error(swapData.error);

        await ctx.reply(t(lang, 'buy_step_2'), { parse_mode: 'Markdown' });

        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([userKeypair]);
        const txidSwap = await solanaConnection.sendTransaction(transaction, { maxRetries: 3 });

        await ctx.reply(t(lang, 'buy_step_3'), { parse_mode: 'Markdown' });

        const feeTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: userKeypair.publicKey,
                toPubkey: new PublicKey(DOMPET_OPERATOR),
                lamports: feeLamports,
            })
        );
        feeTx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash;
        feeTx.feePayer = userKeypair.publicKey;
        feeTx.sign(userKeypair);
        const txidFee = await solanaConnection.sendTransaction(feeTx);

        const teksSukses = t(lang, 'buy_success', { amount: eksekusiSol.toFixed(4), txswap: txidSwap, txfee: txidFee });
        await ctx.reply(teksSukses, { parse_mode: 'Markdown', disable_web_page_preview: true });

    } catch (error) {
        await ctx.reply(t(lang, 'buy_fail'), { parse_mode: 'Markdown' });
    }
};

bot.command('beli', async (ctx) => {
    const lang = getUserLang(ctx);
    const pesan = ctx.message.text.split(' ');
    if (pesan.length !== 3) return ctx.reply(t(lang, 'buy_format'));
    await eksekusiBeli(ctx, pesan[1], pesan[2], false);
});

const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

bot.hears(solanaAddressRegex, async (ctx, next) => {
    const lang = getUserLang(ctx);
    const teksPesan = ctx.message.text;
    if (teksPesan.startsWith('/')) return next();
    if (teksPesan.toLowerCase().includes('0x')) return;
    
    const ca = ctx.match[0].trim(); 
    const loadingMsg = await ctx.reply(t(lang, 'scan_start'));
    
    try {
        const respon = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + ca);
        const data = await respon.json();
        let namaToken = t(lang, 'scan_unknown');
        let hargaToken = "0.00", mcap = "N/A";
        
        if (data.pairs && data.pairs.length > 0) {
            namaToken = data.pairs[0].baseToken.name + " (" + data.pairs[0].baseToken.symbol + ")";
            hargaToken = data.pairs[0].priceUsd;
            if (data.pairs[0].fdv) mcap = "\$" + (data.pairs[0].fdv / 1000).toFixed(1) + "K";
        } else {
            return await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, t(lang, 'scan_rug'));
        }
        
        const tombolInteraktif = Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn_buy_01'), "buy_0.1_" + ca), Markup.button.callback(t(lang, 'btn_buy_05'), "buy_0.5_" + ca)],
            [Markup.button.callback(t(lang, 'btn_buy_1'), "buy_1.0_" + ca), Markup.button.callback(t(lang, 'btn_buy_max'), "buy_max_" + ca)],
            [Markup.button.callback(t(lang, 'btn_custom'), "custom_" + ca)],
            [Markup.button.callback(t(lang, 'btn_cancel'), 'batal_aksi')]
        ]);

        const teksBalasan = t(lang, 'scan_result', { name: namaToken, price: hargaToken, mcap: mcap, ca: ca });
        
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, teksBalasan, { parse_mode: 'Markdown', ...tombolInteraktif });
    } catch (error) { await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, t(lang, 'scan_error')); }
});

bot.on('callback_query', async (ctx) => {
    const lang = getUserLang(ctx);
    const data = ctx.callbackQuery.data;
    if (!data) return;

    try {
        if (data === 'batal_aksi') {
            await ctx.answerCbQuery(t(lang, 'cb_cancel'));
            return ctx.deleteMessage();
        }

        if (data.startsWith('buy_')) {
            const parts = data.split('_');
            if (parts.length === 3) {
                const nominal = parts[1];
                const ca = parts[2];
                await ctx.answerCbQuery(t(lang, 'cb_process'));
                if (nominal === 'max') {
                    return eksekusiBeli(ctx, ca, 0, true);
                } else {
                    return eksekusiBeli(ctx, ca, nominal, false);
                }
            }
        }

        if (data.startsWith('custom_')) {
            const ca = data.replace('custom_', '');
            await ctx.answerCbQuery(t(lang, 'cb_custom_opened')); 
            return ctx.reply(t(lang, 'cb_custom_msg', { ca: ca }), { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.log("Error Callback:", error);
    }
});

bot.launch().then(() => {
    console.log('🤖 MESIN SALAMI SLICING GLOBAL: ONLINE & SIAP TEMPUR');
});
