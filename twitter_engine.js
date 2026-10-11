require('dotenv').config();
const fs = require('fs');
const { TwitterApi } = require('twitter-api-v2');
const { OpenAI } = require('openai');

// === INISIALISASI API ===
const twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
});
const rwClient = twitterClient.readWrite;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// === DATABASE ANTI-SPAM (Mencegah balas cuitan yang sama 2x) ===
const REPLIED_DB = './replied_tweets.json';

const getRepliedTweets = () => {
    if (!fs.existsSync(REPLIED_DB)) return [];
    return JSON.parse(fs.readFileSync(REPLIED_DB, 'utf8'));
};

const saveRepliedTweet = (tweetId) => {
    const replied = getRepliedTweets();
    replied.push(tweetId);
    // Simpan maksimal 5000 ID terakhir agar file tidak bengkak
    if (replied.length > 5000) replied.shift(); 
    fs.writeFileSync(REPLIED_DB, JSON.stringify(replied));
};

// === FUNGSI DELAY (Mencegah Banned Twitter) ===
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// === OTAK AI (OPENAI) ===
const generateReply = async (tweetText, username) => {
    try {
        const prompt = `
        Kamu adalah seorang trader kripto Solana yang ramah dan suka membantu di Twitter.
        Seseorang dengan username @${username} baru saja ngetwit: "${tweetText}"
        
        Tugasmu:
        Balas twit tersebut dengan gaya bahasa santai, natural, ala anak kripto (degen/bro), tapi tetap sopan.
        Beri tahu dia bahwa cara paling cepat dan aman untuk membeli koin di Solana adalah menggunakan bot Telegram.
        
        ATURAN MUTLAK:
        1. Kamu WAJIB memasukkan link ini di dalam balasanmu: t.me/holygrailengine_bot
        2. Jangan gunakan hashtag (#).
        3. Panjang balasan maksimal 250 karakter.
        4. Jangan terlihat seperti bot robotik. Gunakan bahasa Inggris atau Indonesia tergantung bahasa twit aslinya.
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", // Gunakan 3.5 untuk kecepatan dan biaya murah
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7, // Membuat balasan bervariasi
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error("❌ OpenAI Error:", error.message);
        return null;
    }
};

// === MESIN PENCARI & PENJAWAB UTAMA ===
const runTwitterEngine = async () => {
    console.log("🔍 [TWITTER ENGINE] Memulai pemindaian cuitan...");
    
    try {
        // KATA KUNCI PENCARIAN (Bisa disesuaikan)
        const searchQuery = '("where to buy" OR "how to buy" OR "dimana beli" OR "cara beli") (solana OR memecoin OR token) -is:retweet -is:reply';
        
        // Cari 10 cuitan terbaru
        const searchResult = await rwClient.v2.search(searchQuery, {
            'tweet.fields': ['created_at', 'author_id', 'lang'],
            'expansions': ['author_id'],
            max_results: 10
        });

        const tweets = searchResult.tweets;
        const includes = searchResult.includes;

        if (!tweets || tweets.length === 0) {
            console.log("🤷‍♂️ Tidak ada cuitan target baru saat ini.");
            return;
        }

        const repliedTweets = getRepliedTweets();

        for (const tweet of tweets) {
            // 1. Cek apakah sudah pernah dibalas
            if (repliedTweets.includes(tweet.id)) continue;

            // 2. Dapatkan username penulis
            const author = includes.users.find(user => user.id === tweet.author_id);
            const username = author ? author.username : "bro";

            console.log(`\n🎯 TARGET DITEMUKAN: @${username} - "${tweet.text}"`);

            // 3. Generate balasan menggunakan AI
            const aiReply = await generateReply(tweet.text, username);
            
            if (aiReply) {
                console.log(`🤖 AI Menjawab: "${aiReply}"`);
                
                // 4. Kirim balasan ke Twitter
                await rwClient.v2.reply(aiReply, tweet.id);
                console.log(`✅ Berhasil membalas @${username}`);
                
                // 5. Simpan ID ke database agar tidak dispam 2x
                saveRepliedTweet(tweet.id);

                // 6. JEDA ACAK (30 - 90 detik) UNTUK MENGHINDARI BANNED TWITTER
                const delay = Math.floor(Math.random() * (90000 - 30000 + 1)) + 30000;
                console.log(`⏳ Menunggu ${delay / 1000} detik sebelum target berikutnya...`);
                await sleep(delay);
            }
        }
        console.log("🏁 [TWITTER ENGINE] Siklus pemindaian selesai.");

    } catch (error) {
        console.error("❌ Twitter API Error:", error.message);
    }
};

// === JALANKAN MESIN SECARA BERKALA ===
// Jalankan pertama kali saat script dihidupkan
runTwitterEngine();

// Ulangi setiap 15 Menit (900.000 ms)
// Jangan terlalu cepat agar API Twitter tidak limit
setInterval(runTwitterEngine, 900000);

console.log('🦅 MESIN AKUISISI TWITTER (PIVOT 3): ONLINE & MENGUDARA');
