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
// 1. KONFIGURASI & VALIDASI ENV
// =====================================================================
const env = process.env;
const fatal = (m) => { console.error('🚨 FATAL: ' + m); process.exit(1); };

['TELEGRAM_TOKEN', 'HELIUS_RPC_URL', 'ENCRYPTION_KEY'].forEach((k) => {
    if (!env[k]) fatal(`${k} belum diisi di environment variables.`);
});
if (!/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY)) fatal('ENCRYPTION_KEY harus 64 karakter hex (32 byte).');

const OPERATOR_WALLET = env.OPERATOR_WALLET || 'AVEyL6y5fdHs6KMB2W7dTSZTrvXjPddvPFjcsJu4awR';
let OPERATOR_PK;
try { OPERATOR_PK = new PublicKey(OPERATOR_WALLET); } catch (e) { fatal('OPERATOR_WALLET bukan alamat Solana yang valid.'); }

const ENC_KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

const numEnv = (name, def, min, max) => {
    if (env[name] === undefined || env[name] === '') return def;
    const n = Number(env[name]);
    if (!Number.isFinite(n) || n < min || n > max) fatal(`${name} harus angka antara ${min} dan ${max}.`);
    return n;
};

const FEE_BPS = Math.round(numEnv('FEE_BPS', 70, 0, 500));               
const SLIPPAGE_BPS = Math.round(numEnv('SLIPPAGE_BPS', 500, 1, 3000));   
const PRIORITY_LAMPORTS = Math.round(numEnv('PRIORITY_LAMPORTS', 100000, 0, 5000000));
const MAX_DEVIATION_PCT = numEnv('MAX_DEVIATION_PCT', 30, 1, 100);
const FEE_PCT_TEXT = (FEE_BPS / 100).toString();
const JUP_BASE = env.JUPITER_BASE_URL || 'https://api.jup.ag/swap/v2';
const JUP_KEY = env.JUPITER_API_KEY || '';
const ADMIN_ID = env.ADMIN_ID ? String(env.ADMIN_ID) : '';
const RADAR_CAS = (env.RADAR_CAS || 'EKpQGSJtjMFqKZ9KQanUKXpe6ZNcA6hMWEcXndn5sdls,7GCihgDB8fe6KNjn2VNbBndApVDdpW2Ci9gVrNyMEngz,DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')
    .split(',').map((s) => s.trim()).filter(Boolean);

const DATA_DIR = env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || './data';
const DB_FILE = path.join(DATA_DIR, 'database.json');

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const GAS_BUFFER_LAMPORTS = 4_600_000;   
const MIN_SELL_LAMPORTS = 3_000_000;     
const MIN_BUY_LAMPORTS = 1_000_000;      
const WITHDRAW_FEE = 5000;
const ORDER_TTL_MS = 60_000;

let solanaConnection = new Connection(env.HELIUS_RPC_URL, 'confirmed');
const bot = new Telegraf(env.TELEGRAM_TOKEN);

// =====================================================================
// 2. ENKRIPSI (AES-256-GCM)
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
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, iv);
    return Buffer.concat([decipher.update(Buffer.from(parts.join(':'), 'hex')), decipher.final()]).toString('utf8');
};

const loadKeypair = (user) => {
    if (!user || !user.privateKey || typeof user.privateKey !== 'string') throw new Error('Kunci user tidak ada');
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(decrypt(user.privateKey))));
    if (kp.publicKey.toBase58() !== user.publicKey) throw new Error('Kunci tidak cocok');
    return kp;
};

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
// 3. DATABASE (Anti-Race Condition)
// =====================================================================
const loadDb = () => {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tryRead = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!fs.existsSync(DB_FILE)) {
        if (fs.existsSync(DB_FILE + '.bak')) return tryRead(DB_FILE + '.bak');
        return {};
    }
    try { return tryRead(DB_FILE); } catch (e) {
        try { return tryRead(DB_FILE + '.bak'); } catch (e2) { }
        return fatal('database.json korup. Bot dihentikan.');
    }
};

let db = loadDb();
let saveChain = Promise.resolve();

const writeDbFile = async () => {
    const tmp = DB_FILE + '.tmp';
    await fsPromises.writeFile(tmp, JSON.stringify(db, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { await fsPromises.copyFile(DB_FILE, DB_FILE + '.bak'); } catch (e) { }
    await fsPromises.rename(tmp, DB_FILE);
};

const persist = () => {
    const p = saveChain.then(writeDbFile);
    saveChain = p.catch((e) => console.error('Gagal menyimpan DB:', e.message));
    return p;
};

const migrateDb = async () => {
    let changed = false;
    for (const [id, u] of Object.entries(db)) {
        if (!u || !u.privateKey) continue;
        try {
            if (Array.isArray(u.privateKey)) {
                u.privateKey = encrypt(JSON.stringify(u.privateKey));
                changed = true;
            } else if (typeof u.privateKey === 'string' && !u.privateKey.startsWith('v2:')) {
                u.privateKey = encrypt(decrypt(u.privateKey));
                changed = true;
            }
        } catch (e) { }
    }
    if (changed) { await persist(); await persist(); } 
};

// =====================================================================
// 4. TEKS & HELPER
// =====================================================================
const t = (lang, key, params = {}) => {
    let text = locales[lang]?.[key] || locales['en']?.[key] || key;
    for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`{${k}}`, 'g'), v);
    }
    return text;
};

const getUserLang = (ctx) => {
    let lang = ctx.from?.language_code?.substring(0, 2) || 'en';
    if (!locales[lang]) lang = 'en';
    return lang;
};

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
// 5. DATA PASAR & AUDIT RISIKO
// =====================================================================
const getJson = async (url, opts = {}) => {
    const { timeout = 10000, ...rest } = opts;
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
};
const dexPairs = async (cas) => {
    const data = await getJson('https://api.dexscreener.com/latest/dex/tokens/' + cas.join(','));
    return (data.pairs || []).filter((p) => p.chainId === 'solana');
};
const bestPair = (pairs, ca) => pairs.filter((p) => p.baseToken?.address === ca).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;

let solPriceCache = { v: null, t: 0 };
const getSolPriceUSD = async () => {
    if (solPriceCache.v && Date.now() - solPriceCache.t < 30_000) return solPriceCache.v;
    try {
        const v = parseFloat(bestPair(await dexPairs([WSOL]), WSOL)?.priceUsd);
        if (Number.isFinite(v) && v > 0) { solPriceCache = { v, t: Date.now() }; return v; }
    } catch (e) { }
    return solPriceCache.v; 
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

const DANGEROUS_EXT = ['permanentDelegate', 'transferHook', 'nonTransferable', 'defaultAccountState', 'pausableConfig', 'transferFeeConfig', 'mintCloseAuthority'];

const buildAudit = (lang, { mint, holders, pair }) => {
    const flags = [];
    const add = (lvl, text) => flags.push({ lvl, text });
    const icon = { red: '🔴', yellow: '🟡', green: '🟢', gray: '⚪' };

    if (!mint) {
        add('gray', t(lang, 'audit_no_data'));
    } else {
        add(mint.mintAuthority ? 'red' : 'green', mint.mintAuthority ? t(lang, 'audit_mint_active') : t(lang, 'audit_mint_revoked'));
        add(mint.freezeAuthority ? 'red' : 'green', mint.freezeAuthority ? t(lang, 'audit_freeze_active') : t(lang, 'audit_freeze_revoked'));
        if (mint.extensions.length) {
            const bad = mint.extensions.filter((e) => DANGEROUS_EXT.includes(e));
            add(bad.length ? 'red' : 'yellow', t(lang, 'audit_ext', { ext: mint.extensions.join(', ') }));
        }
    }
    if (holders) {
        const lvl1 = holders.top1 > 30 ? 'yellow' : 'green';
        const lvl10 = holders.top10 > 60 ? 'yellow' : 'green';
        add(lvl1 === 'yellow' || lvl10 === 'yellow' ? 'yellow' : 'green', t(lang, 'audit_holders', { top1: holders.top1.toFixed(1), top10: holders.top10.toFixed(1) }));
    }
    const liq = pair?.liquidity?.usd;
    if (Number.isFinite(liq)) {
        add(liq < 1000 ? 'red' : liq < 5000 ? 'yellow' : 'green', t(lang, 'audit_liq', { liq: fmtUsd(liq) }));
    }

    const hasRed = flags.some((f) => f.lvl === 'red');
    const hasYellow = flags.some((f) => f.lvl === 'yellow' || f.lvl === 'gray');
    const verdict = hasRed ? t(lang, 'audit_high_risk') : hasYellow ? t(lang, 'audit_caution') : t(lang, 'audit_safe');
    
    return flags.map((f) => `${icon[f.lvl]} ${f.text}`).join('\n') + '\n\n' + verdict;
};

// =====================================================================
// 6. JUPITER & TRANSAKSI
// =====================================================================
const jupBuild = async ({ inputMint, outputMint, amount, taker }) => {
    const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount), taker, slippageBps: String(SLIPPAGE_BPS) });
    const j = await getJson(`${JUP_BASE}/build?${q}`, { headers: JUP_KEY ? { 'x-api-key': JUP_KEY } : {}, timeout: 12000 });
    if (!j || !j.swapInstruction || j.outAmount === undefined) throw new Error('Respons Jupiter tidak valid');
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
    if (Array.isArray(j.addressLookupTableAddresses)) {
        for (const key of j.addressLookupTableAddresses) await fetchAlt(key);
    }
    return out;
};

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
    if (sim.value.err) throw new Error('SIM_FAIL ' + JSON.stringify(sim.value.err));
    
    const units = Math.min(1_400_000, Math.ceil((sim.value.unitsConsumed || 200_000) * 1.25) + 2000);
    const micro = Math.max(1, Math.floor((PRIORITY_LAMPORTS * 1e6) / units));
    const tx = compile(units, micro);
    tx.sign([keypair]);

    const signature = await solanaConnection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    try {
        const conf = await solanaConnection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (conf.value.err) throw new Error('TX_FAILED');
    } catch (e) {
        const status = await solanaConnection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        if (status && status.value && status.value[0] && status.value[0].confirmationStatus) {
            return { signature }; 
        }
        e.signature = signature; 
        e.unconfirmed = true; 
        throw e; 
    }
    return { signature };
};

// =====================================================================
// 7. STATE & RATE LIMITER
// =====================================================================
const orders = new Map();
const busy = new Set();
const newOrder = (o) => {
    const id = crypto.randomBytes(4).toString('hex');
    orders.set(id, { ...o, createdAt: Date.now() });
    return id;
};
const orderCleaner = setInterval(() => { const n = Date.now(); for (const [k, v] of orders) if (n - v.createdAt > ORDER_TTL_MS * 5) orders.delete(k); }, 60_000);

const hits = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) { const f = v.filter(x => n - x < 10000); if(f.length) hits.set(k, f); else hits.delete(k); } }, 60000);

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

// =====================================================================
// 8. PERINTAH BOT
// =====================================================================
bot.command(['start', 'help'], async (ctx) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    if (!db[uid]) { db[uid] = { lang }; await persist(); }
    else if (db[uid].lang !== lang) { db[uid].lang = lang; await persist(); }
    await reply(ctx, t(lang, 'welcome', { fee: FEE_PCT_TEXT }));
});

bot.command('dompet', async (ctx) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    if (db[uid]?.publicKey) return reply(ctx, t(lang, 'wallet_exists', { address: db[uid].publicKey }));

    const kp = Keypair.generate();
    db[uid] = { publicKey: kp.publicKey.toBase58(), privateKey: encrypt(JSON.stringify(Array.from(kp.secretKey))), lang };
    await persist(); 
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
        const sol = (lamports / LAMPORTS_PER_SOL).toFixed(4);
        const usdLine = price ? `\n💵 ≈ *$${(sol * price).toFixed(2)}* (1 SOL = $${price.toFixed(2)})` : '';
        await reply(ctx, t(lang, 'balance_info', { sol, usdLine }));
    } catch (e) { await ctx.reply(t(lang, 'balance_error')); }
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
            rows.push([Markup.button.callback(t(lang, 'radar_btn_snipe', { symbol: clean(p.baseToken.symbol, 12) }), 'preview_0.1_' + p.baseToken.address)]);
            if (seen.size >= 5) break;
        }
        rows.push([Markup.button.callback(t(lang, 'radar_btn_close'), 'batal_aksi')]);
        await edit(ctx, loading, text, Markup.inlineKeyboard(rows));
    } catch (e) { await edit(ctx, loading, t(lang, 'radar_error')).catch(() => {}); }
});

// ---------- ALUR BELI ----------
const previewBuy = async (ctx, ca, nominal) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    const user = db[uid];
    if (!user?.publicKey) return reply(ctx, t(lang, 'no_wallet'));
    if (!isPubkey(ca)) return reply(ctx, t(lang, 'err_invalid_ca'));
    if (busy.has(uid)) return reply(ctx, t(lang, 'err_busy'));

    let msg = await ctx.reply(t(lang, 'buy_fetching'));
    try {
        const bal = await solanaConnection.getBalance(new PublicKey(user.publicKey));
        const total = nominal === 'max' ? bal - GAS_BUFFER_LAMPORTS : Math.round(parseFloat(nominal) * LAMPORTS_PER_SOL);
        if (total < MIN_BUY_LAMPORTS || bal < total + GAS_BUFFER_LAMPORTS) {
            return edit(ctx, msg, t(lang, 'buy_insufficient', { balance: solStr(bal), needed: solStr(total + GAS_BUFFER_LAMPORTS) }));
        }

        const [pairsR, mintR] = await Promise.allSettled([dexPairs([ca]), getMintInfo(ca)]);
        const mint = mintR.status === 'fulfilled' ? mintR.value : null;
        const pair = pairsR.status === 'fulfilled' ? bestPair(pairsR.value, ca) : null;
        let holders = null;
        if (mint && !mint.notMint) { try { holders = await getHolderStats(ca, mint.supply); } catch (e) {} }
        
        const audit = buildAudit(lang, { mint, holders, pair });

        const fee = Math.floor((total * FEE_BPS) / 10000);
        const swapLamports = total - fee;
        const jup = await jupBuild({ inputMint: WSOL, outputMint: ca, amount: swapLamports, taker: user.publicKey });
        const out = BigInt(jup.outAmount);
        if (out <= 0n) return await edit(ctx, msg, t(lang, 'buy_no_route'));

        const id = newOrder({ type: 'buy', userId: uid, ca, total, fee, swapLamports, outAmount: out.toString() });
        const text = t(lang, 'buy_audit_header', {
            name: pair ? clean(pair.baseToken.name) : 'Unknown',
            ca: ca,
            audit: audit,
            total: solStr(total),
            feePct: FEE_PCT_TEXT,
            fee: solStr(fee, 5),
            receive: mint ? fmtTokens(out, mint.decimals) : out
        });
        
        await edit(ctx, msg, text, Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'buy_btn_confirm', { total: solStr(total) }), 'cf_' + id)],
            [Markup.button.callback(t(lang, 'btn_cancel'), 'batal_aksi')]
        ]));
    } catch (e) {
        await edit(ctx, msg, t(lang, 'err_tx_fail', { err: e.message })).catch(() => {});
    }
};

const runBuy = async (ctx, order) => {
    const lang = getUserLang(ctx);
    const user = db[order.userId];
    const kp = loadKeypair(user);
    const prog = await ctx.reply(t(lang, 'buy_sending'));
    try {
        const jup = await jupBuild({ inputMint: WSOL, outputMint: order.ca, amount: order.swapLamports, taker: user.publicKey });
        const { signature } = await buildAndSend({ keypair: kp, jup, feeLamports: order.fee, feePosition: 'before' });
        await edit(ctx, prog, t(lang, 'buy_success_tx', { total: solStr(order.total), link: solscan(signature) }));
    } catch (e) {
        await edit(ctx, prog, t(lang, 'err_tx_fail', { err: e.message }));
    }
};

// ---------- ALUR JUAL ----------
bot.command('jual', async (ctx) => {
    const lang = getUserLang(ctx);
    const user = db[ctx.from.id];
    if (!user?.publicKey) return reply(ctx, t(lang, 'no_wallet'));
    const loading = await ctx.reply(t(lang, 'sell_read_wallet'));
    try {
        const holds = await getHoldings(new PublicKey(user.publicKey));
        if (!holds.length) return await edit(ctx, loading, t(lang, 'sell_empty'));
        
        const pairs = await dexPairs(holds.map(h => h.mint));
        const holdsWithUsd = holds.map(h => {
            const p = bestPair(pairs, h.mint);
            const price = p ? parseFloat(p.priceUsd) : 0;
            const amount = Number(h.raw) / 10 ** h.decimals;
            return { ...h, usdValue: price * amount, symbol: p ? clean(p.baseToken.symbol, 12) : shortAddr(h.mint) };
        }).sort((a, b) => b.usdValue - a.usdValue).slice(0, 8);

        let text = t(lang, 'sell_header');
        const rows = [];
        for (const h of holdsWithUsd) {
            text += `• *${h.symbol}*: ${fmtTokens(h.raw, h.decimals)} (≈ ${fmtUsd(h.usdValue)})\n  \`${h.mint}\`\n`;
            rows.push([
                Markup.button.callback(t(lang, 'sell_btn_50', { symbol: h.symbol }), `sl_50_${h.mint}`), 
                Markup.button.callback(t(lang, 'sell_btn_100', { symbol: h.symbol }), `sl_100_${h.mint}`)
            ]);
        }
        rows.push([Markup.button.callback(t(lang, 'btn_cancel'), 'batal_aksi')]);
        await edit(ctx, loading, text, Markup.inlineKeyboard(rows));
    } catch (e) { await edit(ctx, loading, t(lang, 'err_tx_fail', { err: e.message })).catch(() => {}); }
});

const previewSell = async (ctx, ca, pct) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    const user = db[uid];
    if (busy.has(uid)) return reply(ctx, t(lang, 'err_busy'));
    let msg = await ctx.reply(t(lang, 'sell_quote'));
    try {
        const pk = new PublicKey(user.publicKey);
        const [bal, holds] = await Promise.all([solanaConnection.getBalance(pk), getHoldings(pk)]);
        const h = holds.find((x) => x.mint === ca);
        if (!h) return edit(ctx, msg, t(lang, 'sell_not_found'));
        if (bal < MIN_SELL_LAMPORTS) return edit(ctx, msg, t(lang, 'sell_min_sol', { min: solStr(MIN_SELL_LAMPORTS) }));
        
        const raw = (h.raw * BigInt(pct)) / 100n;
        const jup = await jupBuild({ inputMint: ca, outputMint: WSOL, amount: raw.toString(), taker: user.publicKey });
        const out = BigInt(jup.outAmount);
        const fee = (out * BigInt(FEE_BPS)) / 10000n;
        
        const id = newOrder({ type: 'sell', userId: uid, ca, raw: raw.toString(), outAmount: out.toString() });
        const text = t(lang, 'sell_confirm', { pct: pct, ca: ca, net: solStr(out - fee, 5) });
        await edit(ctx, msg, text, Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'sell_btn_confirm'), 'cf_' + id)], 
            [Markup.button.callback(t(lang, 'btn_cancel'), 'batal_aksi')]
        ]));
    } catch (e) { await edit(ctx, msg, t(lang, 'err_tx_fail', { err: e.message })).catch(() => {}); }
};

const runSell = async (ctx, order) => {
    const lang = getUserLang(ctx);
    const user = db[order.userId];
    const kp = loadKeypair(user);
    const prog = await ctx.reply(t(lang, 'sell_sending'));
    try {
        const jup = await jupBuild({ inputMint: order.ca, outputMint: WSOL, amount: order.raw, taker: user.publicKey });
        const out = BigInt(jup.outAmount);
        const fee = Number((out * BigInt(FEE_BPS)) / 10000n);
        const { signature } = await buildAndSend({ keypair: kp, jup, feeLamports: fee, feePosition: 'after' });
        await edit(ctx, prog, t(lang, 'sell_success', { gross: solStr(out, 5), link: solscan(signature) }));
    } catch (e) { await edit(ctx, prog, t(lang, 'err_tx_fail', { err: e.message })); }
};

// ---------- TARIK & EXPORT ----------
bot.command('tarik', async (ctx) => {
    const lang = getUserLang(ctx);
    const uid = ctx.from.id;
    const user = db[uid];
    if (!user?.publicKey) return reply(ctx, t(lang, 'no_wallet'));
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length !== 2) return reply(ctx, t(lang, 'withdraw_format'));
    
    try {
        const dest = new PublicKey(parts[1]);
        const bal = await solanaConnection.getBalance(new PublicKey(user.publicKey));
        const amount = bal - WITHDRAW_FEE;
        if (amount <= 0) return reply(ctx, t(lang, 'withdraw_insufficient'));
        
        const id = newOrder({ type: 'withdraw', userId: uid, dest: dest.toBase58() });
        await reply(ctx, `🧾 *KONFIRMASI TARIK*\nKe: \`${dest.toBase58()}\`\nJumlah: *≈ ${solStr(amount, 5)} SOL*\n\n⏱ Berlaku 60 detik.`, 
            Markup.inlineKeyboard([[Markup.button.callback('✅ Konfirmasi Tarik', 'cf_' + id)], [Markup.button.callback(t(lang, 'btn_cancel'), 'batal_aksi')]]));
    } catch (e) { reply(ctx, t(lang, 'err_invalid_ca')); }
});

const runWithdraw = async (ctx, order) => {
    const lang = getUserLang(ctx);
    const kp = loadKeypair(db[order.userId]);
    const bal = await solanaConnection.getBalance(kp.publicKey);
    const amount = bal - WITHDRAW_FEE;
    const prog = await ctx.reply(t(lang, 'withdraw_process'));
    try {
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(order.dest), lamports: amount }));
        const { blockhash } = await solanaConnection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = kp.publicKey;
        tx.sign(kp);
        const signature = await solanaConnection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
        await edit(ctx, prog, t(lang, 'withdraw_success', { amount: solStr(amount, 4), address: order.dest, txid: signature }));
    } catch (e) { await edit(ctx, prog, t(lang, 'err_tx_fail', { err: e.message })); }
};

bot.command('export', async (ctx) => {
    const lang = getUserLang(ctx);
    if (!db[ctx.from.id]?.publicKey) return reply(ctx, t(lang, 'no_wallet'));
    await reply(ctx, t(lang, 'export_warn', { pkey: 'HIDDEN' }),
        Markup.inlineKeyboard([[Markup.button.callback('✅ Saya paham, tampilkan', 'ex_ok')], [Markup.button.callback(t(lang, 'btn_cancel'), 'batal_aksi')]]));
});

// ---------- LISTENER & CALLBACK ----------
const seedRe = /^([a-zA-Z]+\s){11,23}[a-zA-Z]+$/;
const secretRe = /^\s*(\[?\s*(?:\d{1,3}\s*,\s*){60,}\d{1,3}\s*\]?|[1-9A-HJ-NP-Za-km-z]{80,90})\s*$/;
bot.hears([secretRe, seedRe], async (ctx) => {
    const lang = getUserLang(ctx);
    try { await ctx.deleteMessage(); } catch (e) {}
    await reply(ctx, t(lang, 'warn_seed'));
});

const caRe = /^\s*([1-9A-HJ-NP-Za-km-z]{32,44})\s*$/;
bot.hears(caRe, async (ctx) => {
    const ca = ctx.match[1];
    if (isPubkey(ca)) await previewBuy(ctx, ca, '0.1'); 
});

bot.on('callback_query', async (ctx) => {
    const lang = getUserLang(ctx);
    const data = ctx.callbackQuery.data;
    if (!data) return;
    try {
        if (data === 'batal_aksi') { await ack(ctx, t(lang, 'info_cancelled')); return await ctx.deleteMessage().catch(() => {}); }
        if (data === 'ex_ok') {
            const kp = loadKeypair(db[ctx.from.id]);
            await ack(ctx, '');
            try { await ctx.deleteMessage(); } catch (e) {}
            const sent = await reply(ctx, `🔑 *PRIVATE KEY*\n\`${b58encode(kp.secretKey)}\`\n_Dihapus dalam 60 detik._`, { protect_content: true });
            setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {}), 60_000);
            return;
        }
        if (data.startsWith('preview_')) {
            const [, nominal, ca] = data.split('_');
            await ack(ctx, t(lang, 'info_processing'));
            return await previewBuy(ctx, ca, nominal);
        }
        if (data.startsWith('sl_')) {
            const [, pct, ca] = data.split('_');
            await ack(ctx, t(lang, 'info_processing'));
            return await previewSell(ctx, ca, Number(pct));
        }
        if (data.startsWith('cf_')) {
            const id = data.slice(3);
            const uid = ctx.from.id;
            const order = orders.get(id);
            if (!order || order.userId !== uid) return ack(ctx, t(lang, 'err_expired'), true);
            if (busy.has(uid)) return ack(ctx, t(lang, 'err_wait'), true);
            
            orders.delete(id);   
            busy.add(uid);
            ack(ctx, t(lang, 'info_executing'));
            ctx.editMessageReplyMarkup(undefined).catch(() => {});
            
            const execute = async () => {
                try {
                    if (order.type === 'buy') await runBuy(ctx, order);
                    else if (order.type === 'sell') await runSell(ctx, order);
                    else if (order.type === 'withdraw') await runWithdraw(ctx, order);
                } finally { busy.delete(uid); }
            };
            execute(); 
        }
    } catch (e) { console.error('[callback]', e.message); }
});

// =====================================================================
// 9. STARTUP & SHUTDOWN
// =====================================================================
bot.catch((err) => console.error(`[bot.catch]:`, err.message));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));

const shutdown = async (sig) => {
    console.log(`Menerima ${sig}, menunggu transaksi selesai...`);
    try { bot.stop(sig); } catch (e) {}
    
    let waitCount = 0;
    while (busy.size > 0 && waitCount < 10) {
        await new Promise(r => setTimeout(r, 1000));
        waitCount++;
    }
    try { await saveChain; } catch (e) {}
    process.exit(0);
};

const main = async () => {
    await migrateDb();
    console.log(`📦 Database: ${DB_FILE} (${Object.keys(db).length} user)`);
    
    try {
        const opBal = await solanaConnection.getBalance(OPERATOR_PK);
        if (opBal < 10000000) { 
            console.error('\n🚨 ================================================== 🚨');
            console.error('🚨 FATAL WARNING: SALDO DOMPET OPERATOR ANDA KOSONG! 🚨');
            console.error(`🚨 Segera isi ${OPERATOR_PK.toBase58()} minimal 0.01 SOL.`);
            console.error('🚨 Jika tidak, semua pemotongan fee 0.7% akan GAGAL TOTAL.');
            console.error('🚨 ================================================== 🚨\n');
        } else {
            console.log(`💸 Fee ${FEE_PCT_TEXT}% -> ${OPERATOR_PK.toBase58()} (Saldo Aman)`);
        }
    } catch (e) { console.log("Gagal mengecek saldo operator saat startup."); }

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    await bot.launch({ dropPendingUpdates: false }, () => console.log('🤖 HOLY GRAIL ENGINE (ENTERPRISE V2) online'));
};

if (require.main === module) {
    main().catch((e) => { console.error('Gagal start:', e); process.exit(1); });
}
