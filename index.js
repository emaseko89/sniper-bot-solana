'use strict';
require('dotenv').config();
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const {
    Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction, Transaction,
    SystemProgram, TransactionInstruction, TransactionMessage, ComputeBudgetProgram,
    AddressLookupTableAccount,
} = require('@solana/web3.js');

const locales = require('./locales');

// =====================================================================
// 1. KONFIGURASI & VALIDASI ENV (bot menolak start kalau ada yang salah)
// =====================================================================
const env = process.env;
const fatal = (m) => { console.error('🚨 FATAL: ' + m); process.exit(1); };

['TELEGRAM_TOKEN', 'HELIUS_RPC_URL', 'ENCRYPTION_KEY', 'OPERATOR_WALLET'].forEach((k) => {
    if (!env[k]) fatal(`${k} belum diisi di environment variables.`);
});
if (!/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY)) fatal('ENCRYPTION_KEY harus 64 karakter hex (32 byte).');

let OPERATOR_PK;
try { OPERATOR_PK = new PublicKey(env.OPERATOR_WALLET); } catch (e) { fatal('OPERATOR_WALLET bukan alamat Solana yang valid.'); }

const ENC_KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

const numEnv = (name, def, min, max) => {
    if (env[name] === undefined || env[name] === '') return def;
    const n = Number(env[name]);
    if (!Number.isFinite(n) || n < min || n > max) fatal(`${name} harus angka antara ${min} dan ${max}.`);
    return n;
};
const FEE_BPS = Math.round(numEnv('FEE_BPS', 70, 0, 500));               // 70 = 0.7%
const SLIPPAGE_BPS = Math.round(numEnv('SLIPPAGE_BPS', 500, 1, 3000));   // 500 = 5%
const PRIORITY_LAMPORTS = Math.round(numEnv('PRIORITY_LAMPORTS', 100000, 0, 5000000));
const MAX_DEVIATION_PCT = numEnv('MAX_DEVIATION_PCT', 30, 1, 100);
const FEE_PCT_TEXT = (FEE_BPS / 100).toString();
const JUP_BASE = env.JUPITER_BASE_URL || 'https://api.jup.ag/swap/v2';
const JUP_KEY = env.JUPITER_API_KEY || '';
const ADMIN_ID = env.ADMIN_ID ? String(env.ADMIN_ID) : '';
const RADAR_CAS = (env.RADAR_CAS || 'EKpQGSJtjMFqKZ9KQanUKXpe6ZNcA6hMWEcXndn5sdls,7GCihgDB8fe6KNjn2VNbBndApVDdpW2Ci9gVrNyMEngz,DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')
    .split(',').map((s) => s.trim()).filter(Boolean);

const DATA_DIR = env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const onRailway = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID);
if (onRailway && DATA_DIR === '.' && env.ALLOW_EPHEMERAL !== '1') {
    fatal('Berjalan di Railway tanpa Volume: database akan HILANG setiap redeploy. Pasang Railway Volume lalu set DATA_DIR ke mount path-nya (mis. /data). (Hanya untuk uji coba: ALLOW_EPHEMERAL=1)');
}
const DB_FILE = path.join(DATA_DIR, 'database.json');

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const GAS_BUFFER_LAMPORTS = 4_600_000;   // 2x rent ATA (wSOL sementara + token) + priority + fee dasar, dibulatkan ke atas
const MIN_SELL_LAMPORTS = 3_000_000;     // butuh rent wSOL sementara saat jual
const MIN_BUY_LAMPORTS = 1_000_000;      // 0.001 SOL
const WITHDRAW_FEE = 5000;
const ORDER_TTL_MS = 60_000;

let solanaConnection = new Connection(env.HELIUS_RPC_URL, 'confirmed');
const bot = new Telegraf(env.TELEGRAM_TOKEN);

// =====================================================================
// 2. ENKRIPSI (AES-256-GCM baru; format lama AES-256-CBC tetap bisa dibaca)
// =====================================================================
const encrypt = (text) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return ['v2', iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
};

const decrypt = (text) => {
    if (text.startsWith('v2:')) {
        const [, ivHex, tagHex, dataHex] = text.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
    }
    // format lama: iv:ciphertext (AES-256-CBC)
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, iv);
    return Buffer.concat([decipher.update(Buffer.from(parts.join(':'), 'hex')), decipher.final()]).toString('utf8');
};

// Ambil Keypair user + pastikan cocok dengan alamat publik yang tersimpan.
const loadKeypair = (user) => {
    if (!user || !user.privateKey || typeof user.privateKey !== 'string') throw new Error('Kunci user tidak ada / belum dimigrasi');
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(decrypt(user.privateKey))));
    if (kp.publicKey.toBase58() !== user.publicKey) throw new Error('Kunci tidak cocok dengan alamat publik');
    return kp;
};

// Base58 (format yang diminta Phantom saat Import Private Key)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58encode = (buf) => {
    const bytes = Buffer.from(buf);
    let n = BigInt('0x' + (bytes.toString('hex') || '0'));
    let s = '';
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
    return s;
};

// =====================================================================
// 3. DATABASE: in-memory + tulis atomik + antrian tulis (anti-race)
// =====================================================================
const loadDb = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tryRead = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!fs.existsSync(DB_FILE)) {
        if (fs.existsSync(DB_FILE + '.bak')) {
            try { console.warn('⚠️ database.json tidak ada, memulihkan dari .bak'); return tryRead(DB_FILE + '.bak'); } catch (e) { /* lanjut */ }
        }
        console.warn(`ℹ️ Database baru dibuat di ${DB_FILE}`);
        return {};
    }
    try { return tryRead(DB_FILE); } catch (e) {
        console.error('🚨 database.json korup:', e.message);
        try { const d = tryRead(DB_FILE + '.bak'); console.warn('⚠️ Dipulihkan dari database.json.bak'); return d; } catch (e2) { /* lanjut */ }
        // JANGAN lanjut dengan {} — itu akan menimpa dan menghapus semua dompet.
        return fatal('database.json korup dan backup tidak bisa dibaca. Bot dihentikan supaya data tidak tertimpa. Perbaiki file secara manual.');
    }
};

let db = loadDb();
let saveChain = Promise.resolve();

const writeDbFile = async () => {
    const tmp = DB_FILE + '.tmp';
    await fsPromises.writeFile(tmp, JSON.stringify(db, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { await fsPromises.copyFile(DB_FILE, DB_FILE + '.bak'); } catch (e) { /* belum ada file lama */ }
    await fsPromises.rename(tmp, DB_FILE);
};
// Mengembalikan promise yang reject jika gagal menyimpan, tapi antrian tetap jalan.
const persist = () => {
    const p = saveChain.then(writeDbFile);
    saveChain = p.catch((e) => console.error('Gagal menyimpan database:', e.message));
    return p;
};

// Migrasi: kunci polos (array) -> terenkripsi; format CBC lama -> GCM.
const migrateDb = async () => {
    let changed = false;
    for (const [id, u] of Object.entries(db)) {
        if (!u || !u.privateKey) continue;
        try {
            if (Array.isArray(u.privateKey)) {
                const kp = Keypair.fromSecretKey(Uint8Array.from(u.privateKey));
                if (kp.publicKey.toBase58() !== u.publicKey) throw new Error('alamat tidak cocok');
                u.privateKey = encrypt(JSON.stringify(u.privateKey));
                changed = true;
                console.warn(`🔐 Migrasi kunci POLOS -> terenkripsi untuk user ${id} (anggap kunci itu sudah pernah terekspos).`);
            } else if (typeof u.privateKey === 'string' && !u.privateKey.startsWith('v2:')) {
                const plain = decrypt(u.privateKey);
                const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(plain)));
                if (kp.publicKey.toBase58() !== u.publicKey) throw new Error('alamat tidak cocok');
                u.privateKey = encrypt(plain);
                changed = true;
            }
        } catch (e) {
            console.error(`⚠️ Migrasi user ${id} dilewati: ${e.message}`);
        }
    }
    if (changed) { await persist(); await persist(); } // 2x supaya .bak juga berisi versi yang sudah dimigrasi
};

// =====================================================================
// 4. TEKS, BAHASA & HELPER TAMPILAN
// =====================================================================
const OV = {
    id: {
        welcome: '🏆 *HOLY GRAIL ENGINE*\n\nBot trading Solana lewat Telegram.\n\n⚠️ *Baca dulu:*\n• Bot ini *kustodian*: server menyimpan kunci dompet Anda (terenkripsi) dan dapat menandatangani transaksi atas perintah Anda.\n• Trading memecoin berisiko sangat tinggi. Anda bisa kehilangan seluruh dana. Bukan saran keuangan.\n• Biaya layanan: *{fee}%* per transaksi beli/jual, ditampilkan di layar konfirmasi.\n\n*Cara pakai:*\n1️⃣ /dompet - buat dompet\n2️⃣ Kirim SOL ke alamat dompet, cek dengan /saldo\n3️⃣ Tempel alamat kontrak (CA) token untuk melihat cek risiko, lalu beli\n4️⃣ /jual - jual token yang ada di dompet\n5️⃣ /radar - daftar token pantauan\n6️⃣ `/tarik ALAMAT_DOMPET_PHANTOM` - tarik SOL\n7️⃣ /export - cadangkan private key (hati-hati)\n\nMulai dengan nominal kecil.',
        balance_info: '💰 Saldo Anda: *{sol} SOL*{usdLine}',
        radar_header: '📡 *DAFTAR PANTAUAN*\n_Token pilihan operator, diurutkan volume 24 jam. Ini bukan rekomendasi beli._\n\n',
    },
    en: {
        welcome: '🏆 *HOLY GRAIL ENGINE*\n\nA Solana trading bot on Telegram.\n\n⚠️ *Read first:*\n• This bot is *custodial*: the server stores your wallet key (encrypted) and can sign transactions on your command.\n• Memecoin trading is extremely risky. You can lose all your funds. Not financial advice.\n• Service fee: *{fee}%* per buy/sell, shown on the confirmation screen.\n\n*How to use:*\n1️⃣ /dompet - create a wallet\n2️⃣ Send SOL to the wallet address, check with /saldo\n3️⃣ Paste a token contract address (CA) to see the risk check, then buy\n4️⃣ /jual - sell tokens held in the wallet\n5️⃣ /radar - watchlist\n6️⃣ `/tarik YOUR_PHANTOM_ADDRESS` - withdraw SOL\n7️⃣ /export - back up your private key (be careful)\n\nStart with small amounts.',
        balance_info: '💰 Balance: *{sol} SOL*{usdLine}',
        radar_header: '📡 *WATCHLIST*\n_Tokens picked by the operator, sorted by 24h volume. Not a buy recommendation._\n\n',
    },
};

const t = (lang, key, params = {}) => {
    const ov = OV[lang] || OV.en;
    const text = ov[key] ?? locales[lang]?.[key] ?? locales.en?.[key] ?? key;
    // satu kali lewat: nilai yang disisipkan tidak akan diproses ulang
    return text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
};
const tr = (lang, id, en) => (lang === 'id' ? id : en);

const getUserLang = (ctx) => {
    let lang = ctx.from?.language_code?.substring(0, 2) || 'en';
    if (!locales[lang]) lang = 'en';
    return lang;
};

// Bersihkan teks dari luar (nama token, dll.) sebelum masuk pesan Markdown.
const clean = (s, max = 32) => (String(s ?? '').replace(/[*_`\[\]\\{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || '?');
const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const solStr = (lamports, d = 4) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(d);
const fmtNum = (n) => {
    if (!Number.isFinite(n)) return 'n/a';
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (n >= 1) return n.toFixed(2);
    if (n === 0) return '0';
    return n.toPrecision(3);
};
const fmtUsd = (n) => {
    if (!Number.isFinite(n)) return 'n/a';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(0);
};
const fmtTokens = (raw, decimals) => fmtNum(Number(raw) / 10 ** decimals);
const solscan = (sig) => `https://solscan.io/tx/${sig}`;
const isPubkey = (s) => { try { new PublicKey(s); return true; } catch (e) { return false; } };

// Kirim/edit pesan Markdown; kalau Telegram gagal mem-parse, kirim ulang sebagai teks biasa.
const isParseErr = (e) => /parse entities|can't find end/i.test(e?.description || e?.message || '');
const reply = async (ctx, text, extra = {}) => {
    try { return await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra }); } catch (e) {
        if (isParseErr(e)) return ctx.reply(text.replace(/[*_`]/g, ''), { disable_web_page_preview: true, ...extra, parse_mode: undefined });
        throw e;
    }
};
const edit = async (ctx, msg, text, extra = {}) => {
    try { return await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra }); } catch (e) {
        if (isParseErr(e)) return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, text.replace(/[*_`]/g, ''), { disable_web_page_preview: true, ...extra, parse_mode: undefined }).catch(() => {});
        if (/not modified/i.test(e?.description || '')) return null;
        throw e;
    }
};
const ack = (ctx, text, alert = false) => ctx.answerCbQuery(text, { show_alert: alert }).catch(() => {});

// =====================================================================
// 5. DATA PASAR: DexScreener, harga SOL, info mint, pemegang token
// =====================================================================
const getJson = async (url, opts = {}) => {
    const { timeout = 10000, ...rest } = opts;
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} dari ${url.split('?')[0]}: ${body.slice(0, 200)}`);
    }
    return res.json();
};
const dexPairs = async (cas) => {
    const data = await getJson('https://api.dexscreener.com/latest/dex/tokens/' + cas.join(','));
    return (data.pairs || []).filter((p) => p.chainId === 'solana');
};
const bestPair = (pairs, ca) => pairs
    .filter((p) => p.baseToken?.address === ca)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;

let solPriceCache = { v: null, t: 0 };
const getSolPriceUSD = async () => {
    if (solPriceCache.v && Date.now() - solPriceCache.t < 30_000) return solPriceCache.v;
    try {
        const v = parseFloat(bestPair(await dexPairs([WSOL]), WSOL)?.priceUsd);
        if (Number.isFinite(v) && v > 0) { solPriceCache = { v, t: Date.now() }; return v; }
    } catch (e) { /* pakai cache jika masih segar */ }
    return solPriceCache.v && Date.now() - solPriceCache.t < 600_000 ? solPriceCache.v : null; // tidak ada harga cadangan palsu
};

const mintCache = new Map();
const getMintInfo = async (ca) => {
    const c = mintCache.get(ca);
    if (c && Date.now() - c.t < 60_000) return c.v;
    const res = await solanaConnection.getParsedAccountInfo(new PublicKey(ca));
    const acc = res.value;
    let v;
    if (!acc) v = null;
    else if (!acc.data || !acc.data.parsed || acc.data.parsed.type !== 'mint') v = { notMint: true };
    else {
        const i = acc.data.parsed.info;
        v = {
            decimals: i.decimals, supply: i.supply,
            mintAuthority: i.mintAuthority || null, freezeAuthority: i.freezeAuthority || null,
            program: acc.owner.toBase58(), extensions: (i.extensions || []).map((e) => e.extension),
        };
    }
    mintCache.set(ca, { v, t: Date.now() });
    return v;
};

const getHolderStats = async (ca, supplyStr) => {
    const supply = BigInt(supplyStr);
    if (supply === 0n) return null;
    const res = await solanaConnection.getTokenLargestAccounts(new PublicKey(ca));
    const amts = res.value.map((x) => BigInt(x.amount));
    const pct = (x) => Number((x * 10000n) / supply) / 100;
    return { top1: pct(amts[0] ?? 0n), top10: pct(amts.slice(0, 10).reduce((a, b) => a + b, 0n)) };
};

const getHoldings = async (ownerPk) => {
    const results = await Promise.all([TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((p) => solanaConnection.getParsedTokenAccountsByOwner(ownerPk, { programId: p })));
    const map = new Map();
    for (const r of results) {
        for (const { account } of r.value) {
            const i = account.data.parsed.info;
            const amt = BigInt(i.tokenAmount.amount);
            if (amt <= 0n || i.mint === WSOL) continue;
            const cur = map.get(i.mint) || { mint: i.mint, raw: 0n, decimals: i.tokenAmount.decimals };
            cur.raw += amt;
            map.set(i.mint, cur);
        }
    }
    return [...map.values()];
};

// =====================================================================
// 6. CEK RISIKO TOKEN (data on-chain nyata; BUKAN jaminan keamanan)
// =====================================================================
const DANGEROUS_EXT = ['permanentDelegate', 'transferHook', 'nonTransferable', 'defaultAccountState', 'pausableConfig'];

const buildAudit = (lang, { mint, holders, pair }) => {
    const flags = [];
    const add = (lvl, text) => flags.push({ lvl, text });
    const icon = { red: '🔴', yellow: '🟡', green: '🟢', gray: '⚪' };

    if (!mint) {
        add('gray', tr(lang, 'Data on-chain tidak bisa diambil (RPC bermasalah).', 'On-chain data unavailable (RPC problem).'));
    } else {
        add(mint.mintAuthority ? 'red' : 'green', mint.mintAuthority
            ? tr(lang, 'Mint authority AKTIF: pembuat bisa mencetak token baru.', 'Mint authority ACTIVE: creator can mint new tokens.')
            : tr(lang, 'Mint authority dicabut.', 'Mint authority revoked.'));
        add(mint.freezeAuthority ? 'red' : 'green', mint.freezeAuthority
            ? tr(lang, 'Freeze authority AKTIF: dompet Anda bisa dibekukan.', 'Freeze authority ACTIVE: your tokens can be frozen.')
            : tr(lang, 'Freeze authority dicabut.', 'Freeze authority revoked.'));
        if (mint.extensions.length) {
            const bad = mint.extensions.filter((e) => DANGEROUS_EXT.includes(e));
            add(bad.length ? 'red' : 'yellow', tr(lang, `Token-2022 dengan ekstensi: ${mint.extensions.map((e) => clean(e, 30)).join(', ')}.`, `Token-2022 with extensions: ${mint.extensions.map((e) => clean(e, 30)).join(', ')}.`));
        }
    }
    if (holders) {
        const lvl1 = holders.top1 > 30 ? 'yellow' : 'green';
        const lvl10 = holders.top10 > 60 ? 'yellow' : 'green';
        add(lvl1 === 'yellow' || lvl10 === 'yellow' ? 'yellow' : 'green',
            tr(lang, `Pemegang terbesar: ${holders.top1.toFixed(1)}%, 10 teratas: ${holders.top10.toFixed(1)}% (termasuk akun pool/kurva).`,
                `Largest holder: ${holders.top1.toFixed(1)}%, top 10: ${holders.top10.toFixed(1)}% (includes pool/curve accounts).`));
    }
    const liq = pair?.liquidity?.usd;
    if (Number.isFinite(liq)) {
        add(liq < 1000 ? 'red' : liq < 5000 ? 'yellow' : 'green', tr(lang, `Likuiditas ${fmtUsd(liq)} (tipis = harga mudah anjlok saat jual).`, `Liquidity ${fmtUsd(liq)} (thin = price drops hard when selling).`));
    }
    if (pair?.pairCreatedAt) {
        const mins = (Date.now() - pair.pairCreatedAt) / 60000;
        if (mins < 60) add('yellow', tr(lang, `Pool baru dibuat ${Math.max(1, Math.round(mins))} menit lalu.`, `Pool created ${Math.max(1, Math.round(mins))} min ago.`));
    }

    const hasRed = flags.some((f) => f.lvl === 'red');
    const hasYellow = flags.some((f) => f.lvl === 'yellow' || f.lvl === 'gray');
    const verdict = hasRed
        ? tr(lang, '🔴 *RISIKO TINGGI*', '🔴 *HIGH RISK*')
        : hasYellow ? tr(lang, '🟡 *WASPADA*', '🟡 *CAUTION*')
            : tr(lang, '🟢 *Tidak ada bendera merah dari cek otomatis*', '🟢 *No red flags from the automated check*');
    return flags.map((f) => `${icon[f.lvl]} ${f.text}`).join('\n') + '\n\n' + verdict;
};

const scanToken = async (ctx, ca) => {
    const lang = getUserLang(ctx);
    const loading = await ctx.reply(t(lang, 'scan_start'));
    try {
        const [pairsR, mintR] = await Promise.allSettled([dexPairs([ca]), getMintInfo(ca)]);
        const mint = mintR.status === 'fulfilled' ? mintR.value : undefined;
        if (mint === null || (mint && mint.notMint)) {
            return await edit(ctx, loading, tr(lang, '❌ Alamat ini bukan token SPL yang valid.', '❌ This address is not a valid SPL token.'));
        }
        const pair = pairsR.status === 'fulfilled' ? bestPair(pairsR.value, ca) : null;
        if (!pair) {
            return await edit(ctx, loading, tr(lang,
                '⚠️ Belum ada pasangan perdagangan terdeteksi di DexScreener (token baru, belum ada likuiditas, atau tidak valid). Pembelian dinonaktifkan.',
                '⚠️ No trading pair found on DexScreener (new token, no liquidity, or invalid). Buying is disabled.'));
        }
        let holders = null;
        if (mint) { try { holders = await getHolderStats(ca, mint.supply); } catch (e) { /* tampil tanpa data holder */ } }

        const audit = buildAudit(lang, { mint: mint || null, holders, pair });
        const text = tr(lang,
            `📊 *TOKEN DITEMUKAN*\n\n💎 *${clean(pair.baseToken.name)}* (${clean(pair.baseToken.symbol, 12)})\n💵 Harga: *$${fmtNum(parseFloat(pair.priceUsd))}*\n📊 FDV: *${fmtUsd(pair.fdv)}*\n💧 Likuiditas: *${fmtUsd(pair.liquidity?.usd)}*\n🔗 CA: \`${ca}\`\n\n🛡️ *CEK RISIKO OTOMATIS* (data on-chain & DexScreener)\n${audit}\n\n_Ini bukan jaminan. Honeypot, kontrak berbahaya, dan penarikan likuiditas tidak sepenuhnya terdeteksi. Anda bisa kehilangan seluruh dana._\n\nPilih nominal (akan ada layar konfirmasi):`,
            `📊 *TOKEN FOUND*\n\n💎 *${clean(pair.baseToken.name)}* (${clean(pair.baseToken.symbol, 12)})\n💵 Price: *$${fmtNum(parseFloat(pair.priceUsd))}*\n📊 FDV: *${fmtUsd(pair.fdv)}*\n💧 Liquidity: *${fmtUsd(pair.liquidity?.usd)}*\n🔗 CA: \`${ca}\`\n\n🛡️ *AUTOMATED RISK CHECK* (on-chain & DexScreener data)\n${audit}\n\n_This is not a guarantee. Honeypots, malicious contracts and liquidity pulls are not fully detectable. You can lose all your funds._\n\nChoose an amount (a confirmation screen follows):`);

        const kb = Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn_buy_01'), 'buy_0.1_' + ca), Markup.button.callback(t(lang, 'btn_buy_05'), 'buy_0.5_' + ca)],
            [Markup.button.callback(t(lang, 'btn_buy_1'), 'buy_1.0_' + ca), Markup.button.callback(t(lang, 'btn_buy_max'), 'buy_max_' + ca)],
            [Markup.button.callback(t(lang, 'btn_custom'), 'custom_' + ca)],
            [Markup.button.callback(t(lang, 'btn_cancel'), 'batal_aksi')],
        ]);
        await edit(ctx, loading, text, kb);
    } catch (e) {
        console.error('[scan]', e.message);
        await edit(ctx, loading, t(lang, 'scan_error')).catch(() => {});
    }
};

// =====================================================================
// 7. JUPITER + PEMBUATAN TRANSAKSI
// =====================================================================
const jupBuild = async ({ inputMint, outputMint, amount, taker }) => {
    const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount), taker, slippageBps: String(SLIPPAGE_BPS) });
    const j = await getJson(`${JUP_BASE}/build?${q}`, { headers: JUP_KEY ? { 'x-api-key': JUP_KEY } : {}, timeout: 12000 });
    if (!j || !j.swapInstruction || j.outAmount === undefined) {
        throw new Error('Respons Jupiter tidak valid: ' + JSON.stringify(j).slice(0, 300));
    }
    return j;
};

const toIx = (ix) => new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data, 'base64'),
});

const loadAlts = async (j) => {
    const out = [];
    const fetchAlt = async (key) => { const r = await solanaConnection.getAddressLookupTable(new PublicKey(key)); if (r.value) out.push(r.value); };
    const map = j.addressesByLookupTableAddress;
    if (map && typeof map === 'object' && !Array.isArray(map)) {
        for (const [key, addrs] of Object.entries(map)) {
            if (Array.isArray(addrs) && addrs.length && typeof addrs[0] === 'string') {
                out.push(new AddressLookupTableAccount({
                    key: new PublicKey(key),
                    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: addrs.map((a) => new PublicKey(a)) },
                }));
            } else await fetchAlt(key);
        }
    } else if (Array.isArray(j.addressLookupTableAddresses)) {
        for (const key of j.addressLookupTableAddresses) await fetchAlt(key);
    }
    return out;
};

// Susun tx -> simulasi -> set compute limit & priority fee -> kirim -> TUNGGU konfirmasi.
const buildAndSend = async ({ keypair, jup, feeLamports, feePosition }) => {
    const owner = keypair.publicKey;
    const feeIx = feeLamports > 0 ? SystemProgram.transfer({ fromPubkey: owner, toPubkey: OPERATOR_PK, lamports: feeLamports }) : null;
    const ixs = [];
    if (feeIx && feePosition === 'before') ixs.push(feeIx);
    for (const ix of [...(jup.otherInstructions || []), ...(jup.setupInstructions || [])]) if (ix) ixs.push(toIx(ix));
    ixs.push(toIx(jup.swapInstruction));
    if (jup.cleanupInstruction) ixs.push(toIx(jup.cleanupInstruction));
    if (feeIx && feePosition === 'after') ixs.push(feeIx);

    const alts = await loadAlts(jup);
    const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash('confirmed');
    const compile = (units, microLamports) => new VersionedTransaction(new TransactionMessage({
        payerKey: owner, recentBlockhash: blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...ixs],
    }).compileToV0Message(alts));

    const sim = await solanaConnection.simulateTransaction(compile(1_400_000, 0), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    if (sim.value.err) {
        const e = new Error('SIM_FAIL ' + JSON.stringify(sim.value.err));
        e.logs = sim.value.logs;
        throw e;
    }
    const units = Math.min(1_400_000, Math.ceil((sim.value.unitsConsumed || 200_000) * 1.25) + 2000);
    const micro = Math.max(1, Math.floor((PRIORITY_LAMPORTS * 1e6) / units));
    const tx = compile(units, micro);
    tx.sign([keypair]);

    const signature = await solanaConnection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    try {
        const conf = await solanaConnection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (conf.value.err) { const e = new Error('TX_FAILED ' + JSON.stringify(conf.value.err)); e.signature = signature; throw e; }
    } catch (e) {
        e.signature = e.signature || signature;
        if (!/TX_FAILED/.test(e.message)) e.unconfirmed = true;
        throw e;
    }
    return { signature };
};

const friendlyError = (lang, e) => {
    const m = String(e.message || '');
    const sent = !!e.signature;
    const link = sent ? `\n🔗 ${solscan(e.signature)}` : '';
    if (e.unconfirmed) {
        return tr(lang, `⚠️ Transaksi terkirim tetapi belum terkonfirmasi sebelum kedaluwarsa. Kemungkinan besar TIDAK terjadi. Cek Solscan dan /saldo sebelum mengulang.${link}`,
            `⚠️ Transaction was sent but not confirmed before it expired. It most likely did NOT happen. Check Solscan and /saldo before retrying.${link}`);
    }
    if (/Slippage|0x1771|6001/i.test(m)) {
        return tr(lang, `❌ Harga bergeser melebihi batas slippage. ${sent ? 'Biaya jaringan mungkin terpotong.' : 'Dana tidak terpotong.'} Coba lagi.${link}`,
            `❌ Price moved beyond the slippage limit. ${sent ? 'Network fee may be charged.' : 'No funds were spent.'} Try again.${link}`);
    }
    if (/InsufficientFunds|insufficient lamports|0x1\b/i.test(m)) {
        return tr(lang, '❌ Saldo SOL tidak cukup untuk nominal + biaya jaringan + rent akun token. Kurangi nominal atau tambah saldo. Dana tidak terpotong.',
            '❌ Not enough SOL for amount + network fees + token account rent. Lower the amount or top up. No funds were spent.');
    }
    if (/^HTTP (401|403|429)|Jupiter/i.test(m)) {
        return tr(lang, '❌ Layanan swap sedang menolak/membatasi permintaan. Coba beberapa saat lagi. Dana tidak terpotong.',
            '❌ The swap service is rejecting/limiting requests. Try again shortly. No funds were spent.');
    }
    return sent
        ? tr(lang, `❌ Transaksi gagal di jaringan. Biaya jaringan mungkin terpotong.${link}`, `❌ The transaction failed on-chain. Network fee may be charged.${link}`)
        : tr(lang, '❌ Gagal menyiapkan transaksi. Dana tidak terpotong. Detail dicatat di log server.', '❌ Could not prepare the transaction. No funds were spent. Details are in the server log.');
};

// =====================================================================
// 8. ORDER SEMENTARA (layar konfirmasi) & KUNCI PER-USER
// =====================================================================
const orders = new Map();
const busy = new Set();
const newOrder = (o) => {
    const id = crypto.randomBytes(4).toString('hex');
    orders.set(id, { ...o, createdAt: Date.now() });
    return id;
};
const orderCleaner = setInterval(() => { const n = Date.now(); for (const [k, v] of orders) if (n - v.createdAt > ORDER_TTL_MS * 5) orders.delete(k); }, 60_000);
orderCleaner.unref();

const confirmKb = (lang, id, label) => Markup.inlineKeyboard([
    [Markup.button.callback(label, 'cf_' + id)],
    [Markup.button.callback(t(lang, 'btn_cancel'), 'batal_aksi')],
]);

// =====================================================================
// 9. PERINTAH-PERINTAH BOT
// =====================================================================
// Hanya chat pribadi, dan batas laju per user.
const hits = new Map();
bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    const uid = ctx.from?.id;
    if (uid) {
        const now = Date.now();
        const arr = (hits.get(uid) || []).filter((x) => now - x < 10_000);
        arr.push(now);
        hits.set(uid, arr);
        if (arr.length > 20) return;
    }
    return next();
});

bot.command(['start', 'help'], async (ctx) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    if (!db[uid]) db[uid] = {};
    db[uid].lang = lang;
    await persist().catch(() => {});
    await reply(ctx, t(lang, 'welcome', { fee: FEE_PCT_TEXT }));
});

bot.command('dompet', async (ctx) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    if (db[uid]?.publicKey) return reply(ctx, t(lang, 'wallet_exists', { address: db[uid].publicKey }));

    const kp = Keypair.generate();
    const previous = db[uid];
    db[uid] = { publicKey: kp.publicKey.toBase58(), privateKey: encrypt(JSON.stringify(Array.from(kp.secretKey))), lang };
    try {
        await persist(); // alamat baru ditampilkan HANYA setelah tersimpan di disk
    } catch (e) {
        if (previous) db[uid] = previous; else delete db[uid];
        console.error('[dompet] gagal simpan:', e.message);
        return reply(ctx, tr(lang, '❌ Gagal menyimpan dompet. Coba lagi nanti.', '❌ Could not save the wallet. Try again later.'));
    }
    await reply(ctx, t(lang, 'wallet_created', { address: db[uid].publicKey }));
});

bot.command('saldo', async (ctx) => {
    const lang = getUserLang(ctx);
    const user = db[ctx.from.id];
    if (!user?.publicKey) return reply(ctx, t(lang, 'no_wallet'));
    await ctx.reply(t(lang, 'check_balance'));
    try {
        const lamports = await solanaConnection.getBalance(new PublicKey(user.publicKey));
        const price = await getSolPriceUSD();
        const sol = lamports / LAMPORTS_PER_SOL;
        const usdLine = price ? `\n💵 ≈ *$${(sol * price).toFixed(2)}* (1 SOL = $${price.toFixed(2)})` : '';
        await reply(ctx, t(lang, 'balance_info', { sol, usdLine }));
    } catch (e) { console.error('[saldo]', e.message); await ctx.reply(t(lang, 'balance_error')); }
});

bot.command('radar', async (ctx) => {
    const lang = getUserLang(ctx);
    const loading = await reply(ctx, t(lang, 'radar_scanning'));
    try {
        const pairs = await dexPairs(RADAR_CAS);
        let text = t(lang, 'radar_header');
        const rows = [];
        const seen = new Set();
        pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
        for (const p of pairs) {
            if (seen.has(p.baseToken.address) || !RADAR_CAS.includes(p.baseToken.address)) continue;
            seen.add(p.baseToken.address);
            text += t(lang, 'radar_item', {
                count: seen.size, name: clean(p.baseToken.name), symbol: clean(p.baseToken.symbol, 12),
                price: fmtNum(parseFloat(p.priceUsd)), vol: ((p.volume?.h24 || 0) / 1e6).toFixed(2), ca: p.baseToken.address,
            });
            rows.push([Markup.button.callback(t(lang, 'radar_btn_snipe', { symbol: clean(p.baseToken.symbol, 12) }), 'buy_0.1_' + p.baseToken.address)]);
            if (seen.size >= 5) break;
        }
        rows.push([Markup.button.callback(t(lang, 'radar_btn_close'), 'batal_aksi')]);
        await edit(ctx, loading, text, Markup.inlineKeyboard(rows));
    } catch (e) { console.error('[radar]', e.message); await edit(ctx, loading, t(lang, 'radar_error')).catch(() => {}); }
});

// ---------- BELI ----------
const previewBuy = async (ctx, ca, nominal) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    const user = db[uid];
    if (!user?.publicKey) return reply(ctx, t(lang, 'no_wallet'));
    if (!isPubkey(ca)) return reply(ctx, tr(lang, '❌ Alamat token tidak valid.', '❌ Invalid token address.'));
    if (busy.has(uid)) return reply(ctx, tr(lang, '⏳ Masih ada transaksi yang berjalan. Tunggu selesai.', '⏳ A transaction is still in progress. Please wait.'));

    let msg;
    try {
        const bal = await solanaConnection.getBalance(new PublicKey(user.publicKey));
        const total = nominal === 'max' ? bal - GAS_BUFFER_LAMPORTS : Math.round(parseFloat(nominal) * LAMPORTS_PER_SOL);
        if (!Number.isSafeInteger(total) || total < MIN_BUY_LAMPORTS || bal < total + GAS_BUFFER_LAMPORTS) {
            const needed = Math.max(total, MIN_BUY_LAMPORTS) + GAS_BUFFER_LAMPORTS;
            return reply(ctx, t(lang, 'buy_insufficient', { balance: solStr(bal), needed: solStr(needed) }));
        }
        msg = await ctx.reply(tr(lang, '⏳ Mengambil kuotasi...', '⏳ Fetching quote...'));

        const mint = await getMintInfo(ca);
        if (!mint || mint.notMint) return await edit(ctx, msg, tr(lang, '❌ Alamat ini bukan token SPL yang valid.', '❌ This address is not a valid SPL token.'));

        const fee = Math.floor((total * FEE_BPS) / 10000);
        const swapLamports = total - fee;
        const jup = await jupBuild({ inputMint: WSOL, outputMint: ca, amount: swapLamports, taker: user.publicKey });
        const out = BigInt(jup.outAmount);
        const minOut = jup.otherAmountThreshold !== undefined ? BigInt(jup.otherAmountThreshold) : null;
        if (out <= 0n) return await edit(ctx, msg, tr(lang, '❌ Tidak ada rute swap untuk token ini.', '❌ No swap route for this token.'));

        // Cek silang: harga implisit dari kuotasi vs harga DexScreener
        let devLine = '';
        try {
            const [pairs, solUsd] = await Promise.all([dexPairs([ca]), getSolPriceUSD()]);
            const pair = bestPair(pairs, ca);
            const dexPrice = parseFloat(pair?.priceUsd);
            const tokens = Number(out) / 10 ** mint.decimals;
            if (solUsd && Number.isFinite(dexPrice) && dexPrice > 0 && tokens > 0) {
                const implied = ((swapLamports / LAMPORTS_PER_SOL) * solUsd) / tokens;
                const dev = (implied / dexPrice - 1) * 100;
                if (dev > MAX_DEVIATION_PCT) {
                    return await edit(ctx, msg, tr(lang,
                        `🛑 Dibatalkan: harga eksekusi ${dev.toFixed(1)}% lebih mahal dari harga DexScreener (batas ${MAX_DEVIATION_PCT}%). Likuiditas kemungkinan terlalu tipis.`,
                        `🛑 Cancelled: execution price is ${dev.toFixed(1)}% above the DexScreener price (limit ${MAX_DEVIATION_PCT}%). Liquidity is probably too thin.`));
                }
                devLine = tr(lang, `\nSelisih vs harga DexScreener: *${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%*${dev > 10 ? ' ⚠️' : ''}`, `\nDiff vs DexScreener price: *${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%*${dev > 10 ? ' ⚠️' : ''}`);
            }
        } catch (e) { /* cek silang opsional */ }

        const id = newOrder({ type: 'buy', userId: uid, ca, total, fee, swapLamports, outAmount: out.toString() });
        const text = tr(lang,
            `🧾 *KONFIRMASI BELI*\n\nToken: \`${ca}\`\nAnda bayar: *${solStr(total)} SOL*\n• Biaya layanan (${FEE_PCT_TEXT}%): ${solStr(fee, 5)} SOL\n• Masuk ke swap: ${solStr(swapLamports, 5)} SOL\n\nEstimasi diterima: *≈ ${fmtTokens(out, mint.decimals)}*\n${minOut !== null ? `Minimum (slippage ${(SLIPPAGE_BPS / 100).toFixed(1)}%): ${fmtTokens(minOut, mint.decimals)}\n` : ''}${devLine}\nBiaya jaringan: ± ${solStr(PRIORITY_LAMPORTS + 5000, 4)} SOL + rent akun token ± 0.002 SOL (satu kali per token).\n\n⏱ Berlaku 60 detik. Harga bisa bergeser.`,
            `🧾 *CONFIRM BUY*\n\nToken: \`${ca}\`\nYou pay: *${solStr(total)} SOL*\n• Service fee (${FEE_PCT_TEXT}%): ${solStr(fee, 5)} SOL\n• Goes into the swap: ${solStr(swapLamports, 5)} SOL\n\nEstimated receive: *≈ ${fmtTokens(out, mint.decimals)}*\n${minOut !== null ? `Minimum (slippage ${(SLIPPAGE_BPS / 100).toFixed(1)}%): ${fmtTokens(minOut, mint.decimals)}\n` : ''}${devLine}\nNetwork fee: ~${solStr(PRIORITY_LAMPORTS + 5000, 4)} SOL + token account rent ~0.002 SOL (once per token).\n\n⏱ Valid for 60 seconds. Price may move.`);
        await edit(ctx, msg, text, confirmKb(lang, id, tr(lang, `✅ Konfirmasi beli ${solStr(total)} SOL`, `✅ Confirm buy ${solStr(total)} SOL`)));
    } catch (e) {
        console.error('[preview beli]', e.message);
        const text = friendlyError(lang, e);
        if (msg) await edit(ctx, msg, text).catch(() => {}); else await reply(ctx, text);
    }
};

const runBuy = async (ctx, order) => {
    const lang = getUserLang(ctx);
    const user = db[order.userId];
    const kp = loadKeypair(user);
    const bal = await solanaConnection.getBalance(kp.publicKey);
    if (bal < order.total + GAS_BUFFER_LAMPORTS) return reply(ctx, t(lang, 'buy_insufficient', { balance: solStr(bal), needed: solStr(order.total + GAS_BUFFER_LAMPORTS) }));

    const jup = await jupBuild({ inputMint: WSOL, outputMint: order.ca, amount: order.swapLamports, taker: user.publicKey });
    if (BigInt(jup.outAmount) * 100n < BigInt(order.outAmount) * 97n) {
        return reply(ctx, tr(lang, '🛑 Dibatalkan: harga bergeser lebih dari 3% sejak layar konfirmasi. Dana tidak terpotong. Ulangi pembelian.', '🛑 Cancelled: price moved more than 3% since the confirmation screen. No funds were spent. Please retry.'));
    }
    const prog = await ctx.reply(tr(lang, '⏳ Mengirim transaksi dan menunggu konfirmasi jaringan...', '⏳ Sending transaction and waiting for network confirmation...'));
    const { signature } = await buildAndSend({ keypair: kp, jup, feeLamports: order.fee, feePosition: 'before' });
    await edit(ctx, prog, tr(lang,
        `✅ *Transaksi terkonfirmasi di jaringan*\n\nBayar: ${solStr(order.total)} SOL (termasuk biaya layanan ${solStr(order.fee, 5)} SOL)\n🔗 [Lihat di Solscan](${solscan(signature)})\n\nCek token di dompet dengan /jual.`,
        `✅ *Transaction confirmed on-chain*\n\nPaid: ${solStr(order.total)} SOL (including ${solStr(order.fee, 5)} SOL service fee)\n🔗 [View on Solscan](${solscan(signature)})\n\nSee your tokens with /jual.`));
};

bot.command('beli', async (ctx) => {
    const lang = getUserLang(ctx);
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length !== 3) return ctx.reply(t(lang, 'buy_format'));
    const [, ca, amt] = parts;
    if (!/^\d+(\.\d{1,9})?$/.test(amt) || Number(amt) <= 0) return ctx.reply(tr(lang, '⚠️ Nominal tidak valid. Contoh: /beli CA 0.05', '⚠️ Invalid amount. Example: /beli CA 0.05'));
    await previewBuy(ctx, ca, amt);
});

// ---------- JUAL ----------
bot.command('jual', async (ctx) => {
    const lang = getUserLang(ctx);
    const user = db[ctx.from.id];
    if (!user?.publicKey) return reply(ctx, t(lang, 'no_wallet'));
    const loading = await ctx.reply(tr(lang, '🔄 Membaca token di dompet...', '🔄 Reading tokens in your wallet...'));
    try {
        const holds = (await getHoldings(new PublicKey(user.publicKey))).sort((a, b) => Number(b.raw) / 10 ** b.decimals - Number(a.raw) / 10 ** a.decimals).slice(0, 8);
        if (!holds.length) return await edit(ctx, loading, tr(lang, 'ℹ️ Tidak ada token di dompet Anda.', 'ℹ️ No tokens in your wallet.'));
        let names = new Map();
        try { for (const p of await dexPairs(holds.map((h) => h.mint))) if (!names.has(p.baseToken.address)) names.set(p.baseToken.address, clean(p.baseToken.symbol, 12)); } catch (e) { /* nama opsional */ }
        let text = tr(lang, '💼 *TOKEN DI DOMPET ANDA*\n_(maks. 8 teratas)_\n\n', '💼 *TOKENS IN YOUR WALLET*\n_(top 8)_\n\n');
        const rows = [];
        for (const h of holds) {
            const sym = names.get(h.mint) || shortAddr(h.mint);
            text += `• *${sym}*: ${fmtTokens(h.raw, h.decimals)}\n  \`${h.mint}\`\n`;
            rows.push([Markup.button.callback(`🔴 50% ${sym}`, `sl_50_${h.mint}`), Markup.button.callback(`🔴 100% ${sym}`, `sl_100_${h.mint}`)]);
        }
        rows.push([Markup.button.callback(t(lang, 'btn_cancel'), 'batal_aksi')]);
        await edit(ctx, loading, text, Markup.inlineKeyboard(rows));
    } catch (e) { console.error('[jual]', e.message); await edit(ctx, loading, tr(lang, '❌ Gagal membaca dompet. Coba lagi.', '❌ Could not read the wallet. Try again.')).catch(() => {}); }
});

const previewSell = async (ctx, ca, pct) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    const user = db[uid];
    if (!user?.publicKey) return reply(ctx, t(lang, 'no_wallet'));
    if (!isPubkey(ca)) return reply(ctx, tr(lang, '❌ Alamat token tidak valid.', '❌ Invalid token address.'));
    if (busy.has(uid)) return reply(ctx, tr(lang, '⏳ Masih ada transaksi yang berjalan. Tunggu selesai.', '⏳ A transaction is still in progress. Please wait.'));
    let msg;
    try {
        const pk = new PublicKey(user.publicKey);
        const [bal, holds] = await Promise.all([solanaConnection.getBalance(pk), getHoldings(pk)]);
        const h = holds.find((x) => x.mint === ca);
        if (!h) return reply(ctx, tr(lang, '❌ Token ini tidak ada di dompet Anda.', '❌ This token is not in your wallet.'));
        if (bal < MIN_SELL_LAMPORTS) return reply(ctx, tr(lang, `❌ Menjual butuh minimal ${solStr(MIN_SELL_LAMPORTS)} SOL di dompet untuk biaya jaringan dan rent sementara. Saldo: ${solStr(bal)} SOL.`, `❌ Selling needs at least ${solStr(MIN_SELL_LAMPORTS)} SOL in the wallet for network fees and temporary rent. Balance: ${solStr(bal)} SOL.`));
        const raw = (h.raw * BigInt(pct)) / 100n;
        if (raw <= 0n) return reply(ctx, tr(lang, '❌ Jumlah terlalu kecil.', '❌ Amount too small.'));
        msg = await ctx.reply(tr(lang, '⏳ Mengambil kuotasi...', '⏳ Fetching quote...'));
        const jup = await jupBuild({ inputMint: ca, outputMint: WSOL, amount: raw.toString(), taker: user.publicKey });
        const out = BigInt(jup.outAmount);
        if (out <= 0n) return await edit(ctx, msg, tr(lang, '❌ Tidak ada rute swap untuk token ini.', '❌ No swap route for this token.'));
        const fee = (out * BigInt(FEE_BPS)) / 10000n;
        const minOut = jup.otherAmountThreshold !== undefined ? BigInt(jup.otherAmountThreshold) : null;
        const id = newOrder({ type: 'sell', userId: uid, ca, raw: raw.toString(), outAmount: out.toString() });
        const text = tr(lang,
            `🧾 *KONFIRMASI JUAL ${pct}%*\n\nToken: \`${ca}\`\nDijual: *${fmtTokens(raw, h.decimals)}*\n\nEstimasi hasil kotor: *≈ ${solStr(out, 5)} SOL*\n• Biaya layanan (${FEE_PCT_TEXT}%): ${solStr(fee, 5)} SOL\n• Estimasi bersih: *≈ ${solStr(out - fee, 5)} SOL*\n${minOut !== null ? `Minimum kotor (slippage ${(SLIPPAGE_BPS / 100).toFixed(1)}%): ${solStr(minOut, 5)} SOL\n` : ''}\nBiaya jaringan: ± ${solStr(PRIORITY_LAMPORTS + 5000, 4)} SOL.\n\n⏱ Berlaku 60 detik.`,
            `🧾 *CONFIRM SELL ${pct}%*\n\nToken: \`${ca}\`\nSelling: *${fmtTokens(raw, h.decimals)}*\n\nEstimated gross: *≈ ${solStr(out, 5)} SOL*\n• Service fee (${FEE_PCT_TEXT}%): ${solStr(fee, 5)} SOL\n• Estimated net: *≈ ${solStr(out - fee, 5)} SOL*\n${minOut !== null ? `Minimum gross (slippage ${(SLIPPAGE_BPS / 100).toFixed(1)}%): ${solStr(minOut, 5)} SOL\n` : ''}\nNetwork fee: ~${solStr(PRIORITY_LAMPORTS + 5000, 4)} SOL.\n\n⏱ Valid for 60 seconds.`);
        await edit(ctx, msg, text, confirmKb(lang, id, tr(lang, `✅ Konfirmasi jual ${pct}%`, `✅ Confirm sell ${pct}%`)));
    } catch (e) {
        console.error('[preview jual]', e.message);
        const text = friendlyError(lang, e);
        if (msg) await edit(ctx, msg, text).catch(() => {}); else await reply(ctx, text);
    }
};

const runSell = async (ctx, order) => {
    const lang = getUserLang(ctx);
    const user = db[order.userId];
    const kp = loadKeypair(user);
    const jup = await jupBuild({ inputMint: order.ca, outputMint: WSOL, amount: order.raw, taker: user.publicKey });
    const out = BigInt(jup.outAmount);
    if (out * 100n < BigInt(order.outAmount) * 97n) {
        return reply(ctx, tr(lang, '🛑 Dibatalkan: harga bergeser lebih dari 3% sejak layar konfirmasi. Tidak ada yang dijual. Ulangi.', '🛑 Cancelled: price moved more than 3% since the confirmation screen. Nothing was sold. Please retry.'));
    }
    const fee = Number((out * BigInt(FEE_BPS)) / 10000n);
    const prog = await ctx.reply(tr(lang, '⏳ Mengirim transaksi dan menunggu konfirmasi jaringan...', '⏳ Sending transaction and waiting for network confirmation...'));
    const { signature } = await buildAndSend({ keypair: kp, jup, feeLamports: fee, feePosition: 'after' });
    await edit(ctx, prog, tr(lang,
        `✅ *Penjualan terkonfirmasi di jaringan*\n\nEstimasi hasil kotor: ≈ ${solStr(out, 5)} SOL (biaya layanan ${solStr(fee, 5)} SOL)\n🔗 [Lihat di Solscan](${solscan(signature)})\n\nCek saldo dengan /saldo.`,
        `✅ *Sale confirmed on-chain*\n\nEstimated gross: ≈ ${solStr(out, 5)} SOL (service fee ${solStr(fee, 5)} SOL)\n🔗 [View on Solscan](${solscan(signature)})\n\nCheck your balance with /saldo.`));
};

// ---------- TARIK ----------
bot.command('tarik', async (ctx) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    const user = db[uid];
    if (!user?.publicKey) return reply(ctx, t(lang, 'no_wallet'));
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length !== 2) return reply(ctx, t(lang, 'withdraw_format'));
    if (busy.has(uid)) return reply(ctx, tr(lang, '⏳ Masih ada transaksi yang berjalan. Tunggu selesai.', '⏳ A transaction is still in progress. Please wait.'));

    let dest;
    try { dest = new PublicKey(parts[1]); } catch (e) { return reply(ctx, tr(lang, '❌ Alamat tujuan tidak valid.', '❌ Invalid destination address.')); }
    if (!PublicKey.isOnCurve(dest.toBytes())) return reply(ctx, tr(lang, '❌ Alamat tujuan bukan dompet biasa (mungkin alamat akun token/program). Mengirim ke sana bisa menghilangkan dana, jadi ditolak.', '❌ The destination is not a normal wallet (possibly a token/program account). Sending there could lose funds, so it was refused.'));
    if (dest.toBase58() === user.publicKey) return reply(ctx, tr(lang, '❌ Alamat tujuan sama dengan dompet bot Anda.', '❌ The destination is your own bot wallet.'));

    try {
        const pk = new PublicKey(user.publicKey);
        const bal = await solanaConnection.getBalance(pk);
        const amount = bal - WITHDRAW_FEE;
        if (amount <= 0) return reply(ctx, t(lang, 'withdraw_insufficient'));
        const dstInfo = await solanaConnection.getAccountInfo(dest);
        if (dstInfo && !dstInfo.owner.equals(SystemProgram.programId)) return reply(ctx, tr(lang, '❌ Alamat tujuan dimiliki program lain, bukan dompet biasa. Ditolak.', '❌ The destination is owned by another program, not a normal wallet. Refused.'));
        if (!dstInfo) {
            const minRent = await solanaConnection.getMinimumBalanceForRentExemption(0);
            if (amount < minRent) return reply(ctx, tr(lang, `❌ Alamat tujuan belum pernah dipakai; jumlah minimal ${solStr(minRent, 6)} SOL agar akun bisa dibuat.`, `❌ The destination is a new account; the minimum is ${solStr(minRent, 6)} SOL so the account can be created.`));
        }
        let tokenNote = '';
        try { const n = (await getHoldings(pk)).length; if (n > 0) tokenNote = tr(lang, `\n\n⚠️ Dompet masih menyimpan *${n} token*. Jika semua SOL ditarik, tidak ada SOL tersisa untuk menjual atau memindahkannya.`, `\n\n⚠️ The wallet still holds *${n} token(s)*. If all SOL is withdrawn, nothing is left to sell or move them.`); } catch (e) { /* opsional */ }

        const id = newOrder({ type: 'withdraw', userId: uid, dest: dest.toBase58() });
        await reply(ctx, tr(lang,
            `🧾 *KONFIRMASI TARIK*\n\nKe: \`${dest.toBase58()}\`\nJumlah: *≈ ${solStr(amount, 5)} SOL* (seluruh saldo dikurangi biaya jaringan ${solStr(WITHDRAW_FEE, 6)} SOL)\n\nPeriksa alamat. Transaksi tidak bisa dibatalkan.${tokenNote}\n\n⏱ Berlaku 60 detik.`,
            `🧾 *CONFIRM WITHDRAWAL*\n\nTo: \`${dest.toBase58()}\`\nAmount: *≈ ${solStr(amount, 5)} SOL* (entire balance minus ${solStr(WITHDRAW_FEE, 6)} SOL network fee)\n\nCheck the address. This cannot be undone.${tokenNote}\n\n⏱ Valid for 60 seconds.`),
        confirmKb(lang, id, tr(lang, '✅ Konfirmasi tarik', '✅ Confirm withdrawal')));
    } catch (e) { console.error('[tarik]', e.message); await reply(ctx, t(lang, 'withdraw_fail')); }
});

const runWithdraw = async (ctx, order) => {
    const lang = getUserLang(ctx);
    const kp = loadKeypair(db[order.userId]);
    const bal = await solanaConnection.getBalance(kp.publicKey);
    const amount = bal - WITHDRAW_FEE;
    if (amount <= 0) return reply(ctx, t(lang, 'withdraw_insufficient'));
    const prog = await ctx.reply(t(lang, 'withdraw_process'));
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(order.dest), lamports: amount }));
    const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = kp.publicKey;
    tx.sign(kp);
    const signature = await solanaConnection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    try {
        const conf = await solanaConnection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (conf.value.err) { const e = new Error('TX_FAILED ' + JSON.stringify(conf.value.err)); e.signature = signature; throw e; }
    } catch (e) { e.signature = e.signature || signature; if (!/TX_FAILED/.test(e.message)) e.unconfirmed = true; throw e; }
    await edit(ctx, prog, t(lang, 'withdraw_success', { amount: solStr(amount, 4), address: order.dest, txid: signature }));
};

// ---------- EXPORT ----------
bot.command('export', async (ctx) => {
    const lang = getUserLang(ctx);
    if (!db[ctx.from.id]?.publicKey) return reply(ctx, t(lang, 'no_wallet'));
    await reply(ctx, tr(lang,
        '⚠️ *EKSPOR PRIVATE KEY*\n\nSiapa pun yang memegang kunci ini bisa menguras seluruh dompet Anda. Jangan kirim ke siapa pun (termasuk "admin"), jangan screenshot, dan jangan tempel ke chat AI.\n\nPesan berisi kunci akan *dihapus otomatis setelah 60 detik*. Simpan di tempat aman (password manager / catatan offline). Lanjutkan?',
        '⚠️ *EXPORT PRIVATE KEY*\n\nAnyone holding this key can drain your entire wallet. Never share it (not even with "admins"), never screenshot it, never paste it into an AI chat.\n\nThe message containing the key is *deleted automatically after 60 seconds*. Store it somewhere safe (password manager / offline note). Continue?'),
        Markup.inlineKeyboard([[Markup.button.callback(tr(lang, '✅ Saya paham, tampilkan', '✅ I understand, show it'), 'ex_ok')], [Markup.button.callback(t(lang, 'btn_cancel'), 'batal_aksi')]]));
});

const revealKey = async (ctx) => {
    const lang = getUserLang(ctx);
    const msgDate = ctx.callbackQuery.message?.date;
    if (!msgDate || Date.now() / 1000 - msgDate > 300) return ack(ctx, tr(lang, 'Kedaluwarsa. Ketik /export lagi.', 'Expired. Type /export again.'), true);
    const user = db[ctx.from.id];
    if (!user?.publicKey) return ack(ctx, '...');
    let kp;
    try { kp = loadKeypair(user); } catch (e) { console.error('[export] kunci tidak bisa dibuka:', e.message); return ack(ctx, tr(lang, 'Kunci tidak bisa dibuka. Hubungi admin.', 'Key cannot be opened. Contact the admin.'), true); }
    await ack(ctx, '');
    try { await ctx.deleteMessage(); } catch (e) { /* abaikan */ }
    const sent = await reply(ctx, tr(lang,
        `🔑 *PRIVATE KEY (base58)*\n\n\`${b58encode(kp.secretKey)}\`\n\nDi Phantom: Tambah Dompet → Impor Private Key → tempel kode ini.\n_Pesan ini dihapus otomatis dalam 60 detik. Jangan screenshot._`,
        `🔑 *PRIVATE KEY (base58)*\n\n\`${b58encode(kp.secretKey)}\`\n\nIn Phantom: Add Wallet → Import Private Key → paste this code.\n_This message is deleted automatically in 60 seconds. Do not screenshot._`),
        { protect_content: true });
    const chatId = ctx.chat.id;
    setTimeout(() => ctx.telegram.deleteMessage(chatId, sent.message_id).catch(() => {}), 60_000);
};

// ---------- ADMIN ----------
bot.command('status', async (ctx) => {
    if (!ADMIN_ID || String(ctx.from.id) !== ADMIN_ID) return;
    const wallets = Object.values(db).filter((u) => u && u.publicKey).length;
    await ctx.reply([
        `DB: ${DB_FILE}`, `Dompet tersimpan: ${wallets}`, `Uptime: ${Math.round(process.uptime())} dtk`,
        `Operator: ${shortAddr(OPERATOR_PK.toBase58())}`, `Fee: ${FEE_PCT_TEXT}% | Slippage: ${SLIPPAGE_BPS / 100}%`,
        `Jupiter key: ${JUP_KEY ? 'ada' : 'TIDAK ADA'} | Volume: ${DATA_DIR === '.' ? 'TIDAK (disk sementara)' : 'ya'}`,
    ].join('\n'));
});

// ---------- PASTE CA / PERLINDUNGAN SALAH-PASTE KUNCI ----------
const secretRe = /^\s*(\[?\s*(?:\d{1,3}\s*,\s*){60,}\d{1,3}\s*\]?|[1-9A-HJ-NP-Za-km-z]{80,90})\s*$/;
bot.hears(secretRe, async (ctx) => {
    const lang = getUserLang(ctx);
    try { await ctx.deleteMessage(); } catch (e) { /* abaikan */ }
    await reply(ctx, tr(lang, '🛑 Pesan Anda tampak seperti *private key*, jadi saya hapus. JANGAN tempel kunci ke chat mana pun. Jika itu kunci dompet yang berisi dana, pindahkan dana ke dompet baru sekarang.', '🛑 Your message looks like a *private key*, so I deleted it. NEVER paste keys into any chat. If it is a funded wallet, move the funds to a new wallet now.'));
});

const caRe = /^\s*([1-9A-HJ-NP-Za-km-z]{32,44})\s*$/;
bot.hears(caRe, async (ctx) => {
    const ca = ctx.match[1];
    if (!isPubkey(ca)) return;
    await scanToken(ctx, ca);
});

// ---------- TOMBOL ----------
bot.on('callback_query', async (ctx) => {
    const lang = getUserLang(ctx);
    const data = ctx.callbackQuery.data;
    if (!data) return;
    try {
        if (data === 'batal_aksi') { await ack(ctx, t(lang, 'cb_cancel')); return await ctx.deleteMessage().catch(() => {}); }
        if (data === 'ex_ok') return await revealKey(ctx);

        if (data.startsWith('buy_')) {
            const [, nominal, ca] = data.split('_');
            if (!['0.1', '0.5', '1.0', 'max'].includes(nominal) || !ca) return ack(ctx, '...');
            await ack(ctx, t(lang, 'cb_process'));
            return await previewBuy(ctx, ca, nominal);
        }
        if (data.startsWith('sl_')) {
            const [, pct, ca] = data.split('_');
            if (!['50', '100'].includes(pct) || !ca) return ack(ctx, '...');
            await ack(ctx, t(lang, 'cb_process'));
            return await previewSell(ctx, ca, Number(pct));
        }
        if (data.startsWith('custom_')) {
            const ca = data.replace('custom_', '');
            await ack(ctx, t(lang, 'cb_custom_opened'));
            return await reply(ctx, t(lang, 'cb_custom_msg', { ca }));
        }
        if (data.startsWith('cf_')) return await confirmOrder(ctx, data.slice(3));
    } catch (e) { console.error('[callback]', e.message); }
});

const confirmOrder = async (ctx, id) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    const order = orders.get(id);
    if (!order || order.userId !== uid) return ack(ctx, tr(lang, 'Konfirmasi tidak ditemukan / sudah dipakai.', 'Confirmation not found / already used.'), true);
    if (Date.now() - order.createdAt > ORDER_TTL_MS) {
        orders.delete(id);
        await ack(ctx, tr(lang, 'Kedaluwarsa. Ulangi dari awal.', 'Expired. Please start again.'), true);
        return ctx.deleteMessage().catch(() => {});
    }
    if (busy.has(uid)) return ack(ctx, tr(lang, 'Masih ada transaksi berjalan.', 'A transaction is still in progress.'), true);

    orders.delete(id);   // sekali pakai: ketukan ganda tidak bisa mengeksekusi dua kali
    busy.add(uid);
    try {
        await ack(ctx, t(lang, 'cb_process'));
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});
        if (order.type === 'buy') await runBuy(ctx, order);
        else if (order.type === 'sell') await runSell(ctx, order);
        else if (order.type === 'withdraw') await runWithdraw(ctx, order);
    } catch (e) {
        console.error(`[${order.type}]`, e.message, e.logs ? e.logs.slice(-6).join(' | ') : '');
        await reply(ctx, order.type === 'withdraw'
            ? (e.signature ? friendlyError(lang, e) : t(lang, 'withdraw_fail'))
            : friendlyError(lang, e)).catch(() => {});
    } finally { busy.delete(uid); }
};

// =====================================================================
// 10. JALANKAN
// =====================================================================
bot.catch((err, ctx) => console.error(`[bot.catch] update ${ctx?.update?.update_id}:`, err.message));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message ? e.message : e));

const shutdown = async (sig) => {
    console.log(`Menerima ${sig}, berhenti...`);
    try { bot.stop(sig); } catch (e) { /* belum jalan */ }
    try { await saveChain; } catch (e) { /* sudah dilaporkan */ }
    process.exit(0);
};

const main = async () => {
    await migrateDb();
    console.log(`📦 Database: ${DB_FILE} (${Object.keys(db).length} user)${DATA_DIR === '.' ? ' ⚠️ DISK SEMENTARA' : ''}`);
    console.log(`💸 Fee ${FEE_PCT_TEXT}% -> operator ${OPERATOR_PK.toBase58()} (PERIKSA alamat ini sama dengan dompet Phantom Anda)`);
    if (!JUP_KEY) console.warn('⚠️ JUPITER_API_KEY kosong: Jupiter mensyaratkan API key (header x-api-key). Buat di developers.jup.ag/portal.');
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    await bot.launch({ dropPendingUpdates: false }, () => console.log('🤖 HOLY GRAIL ENGINE online'));
};

if (require.main === module) {
    main().catch((e) => { console.error('Gagal start:', e); process.exit(1); });
} else {
    module.exports = {
        bot, encrypt, decrypt, b58encode, loadKeypair, migrateDb, persist, t, clean, buildAudit, buildAndSend, jupBuild,
        hits, getDb: () => db, setConnection: (c) => { solanaConnection = c; }, orders, busy, DB_FILE,
    };
}
