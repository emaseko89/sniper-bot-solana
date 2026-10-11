require('dotenv').config();
const fs = require('fs');
const { OpenAI } = require('openai');

// === DATABASE ANTI-SPAM ===
const REPLIED_DB = './replied_tweets.json';

const getRepliedTweets = () => {
    if (!fs.existsSync(REPLIED_DB)) return [];
    return JSON.parse(fs.readFileSync(REPLIED_DB, 'utf8'));
};

const saveRepliedTweet = (tweetId) => {
    const replied = getRepliedTweets();
    replied.push(tweetId);
    if (replied.length > 5000) replied.shift(); 
    fs.writeFileSync(REPLIED_DB, JSON.stringify(replied));
};

// === FUNGSI DELAY MANUSIAWI ===
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// === OTAK AI (OPENAI) ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const generateReply = async (tweetText, username) => {
    try {
        const prompt = `
        Kamu adalah seorang trader kripto Solana yang ramah di Twitter.
        Seseorang dengan username @${username} baru saja ngetwit: "${tweetText}"
        
        Tugasmu:
        Balas twit tersebut dengan gaya bahasa santai, natural, ala anak kripto (bro/ngab), tapi tetap sopan.
        Beri tahu dia bahwa cara paling cepat dan aman untuk membeli koin di Solana adalah menggunakan bot Telegram.
        
        ATURAN MUTLAK:
        1. Kamu WAJIB memasukkan link ini di dalam balasanmu: t.me/holygrailengine_bot
        2. Jangan gunakan hashtag (#).
        3. Panjang balasan maksimal 200 karakter.
        4. Jangan terlihat seperti bot. Gunakan bahasa yang sama dengan twit aslinya.
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.8, 
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error("❌ OpenAI Error:", error.message);
        return null;
    }
};

// === MESIN GHOST SCRAPER ===
const runTwitterEngine = async () => {
    console.log("🔍 [TWITTER GHOST] Memulai pemindaian siluman...");
    
    try {
        // Import modul scraper secara dinamis
        const { Scraper, SearchMode } = await import('agent-twitter-client');
        const scraper = new Scraper();

        // 1. LOGIN SEBAGAI MANUSIA
        console.log("🔑 Mencoba login ke Twitter...");
        await scraper.login(
            process.env.TWITTER_USERNAME,
            process.env.TWITTER_PASSWORD,
            process.env.TWITTER_EMAIL
        );
        
        const isLoggedIn = await scraper.isLoggedIn();
        if (!isLoggedIn) {
            console.log("❌ Gagal Login. Periksa Username/Password/Email di Railway.");
            return;
        }
        console.log("✅ Login Berhasil!");

        // 2. MENCARI TARGET (Maksimal ambil 5 twit terbaru agar tidak dicurigai)
        const searchQuery = '("where to buy" OR "how to buy" OR "dimana beli") (solana OR memecoin) -filter:replies';
        console.log(`📡 Mencari kata kunci: ${searchQuery}`);
        
        const searchResults = scraper.searchTweets(searchQuery, 5, SearchMode.Latest);
        const repliedTweets = getRepliedTweets();
        let replyCount = 0;

        for await (const tweet of searchResults) {
            // Batasi maksimal balas 2 orang per siklus (SANGAT PENTING UNTUK ANTI-BANNED)
            if (replyCount >= 2) {
                console.log("🛑 Batas aman tercapai (2 balasan). Berhenti mencari.");
                break;
            }

            // Lewati jika sudah pernah dibalas atau twit dari diri sendiri
            if (repliedTweets.includes(tweet.id) || tweet.username === process.env.TWITTER_USERNAME) continue;

            console.log(`\n🎯 TARGET DITEMUKAN: @${tweet.username} - "${tweet.text}"`);

            // 3. GENERATE BALASAN AI
            const aiReply = await generateReply(tweet.text, tweet.username);
            
            if (aiReply) {
                console.log(`🤖 AI Mengetik: "${aiReply}"`);
                
                // Jeda sebelum membalas (seolah-olah sedang mengetik)
                await sleep(Math.floor(Math.random() * (15000 - 5000 + 1)) + 5000);
                
                // 4. KIRIM BALASAN
                await scraper.sendTweet(aiReply, tweet.id);
                console.log(`✅ Berhasil membalas @${tweet.username}`);
                
                saveRepliedTweet(tweet.id);
                replyCount++;

                // Jeda panjang antar balasan (30 - 60 detik)
                const delay = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
                console.log(`⏳ Menunggu ${delay / 1000} detik...`);
                await sleep(delay);
            }
        }
        console.log("🏁 [TWITTER GHOST] Siklus selesai. Tidur panjang...");

    } catch (error) {
        console.error("❌ Twitter Ghost Error:", error.message);
    }
};

// === JALANKAN MESIN SECARA BERKALA ===
// Jalankan pertama kali
runTwitterEngine();

// Ulangi setiap 30 Menit (1.800.000 ms) -> Sangat aman dari Banned
setInterval(runTwitterEngine, 1800000);

console.log('🦅 MESIN GHOST TWITTER (PIVOT 3): ONLINE & MENGUDARA');
