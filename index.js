bot.command('tarik', async (ctx) => {
    const userId = ctx.from.id;
    const db = bacaDatabase();
    if (!db[userId]) return ctx.reply('❌ Anda belum punya dompet. Ketik /dompet');

    const pesan = ctx.message.text.split(' ');
    if (pesan.length !== 2) return ctx.reply('⚠️ Gunakan format:\n`/tarik <ALAMAT_DOMPET_PHANTOM_ANDA>`', { parse_mode: 'Markdown' });

    const alamatTujuan = pesan[1];
    const pesanProses = await ctx.reply('⚙️ Memproses penarikan ke jaringan Solana...', { parse_mode: 'Markdown' });

    try {
        const pubKeyTujuan = new PublicKey(alamatTujuan);
        const secretKey = Uint8Array.from(db[userId].privateKey);
        const userKeypair = Keypair.fromSecretKey(secretKey);

        // Tarik saldo nyata
        const saldoLamports = await solanaConnection.getBalance(userKeypair.publicKey);

        // Sisakan 5000 lamports untuk bayar biaya gas penarikan itu sendiri
        const biayaTransfer = 5000; 
        if (saldoLamports <= biayaTransfer) {
            return ctx.telegram.editMessageText(ctx.chat.id, pesanProses.message_id, null, '❌ Saldo Anda kosong atau tidak cukup untuk membayar biaya jaringan (Gas Fee).');
        }

        const lamportsKirim = saldoLamports - biayaTransfer;

        // Rakit transaksi nyata
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

        // Broadcast ke mainnet
        const txid = await solanaConnection.sendTransaction(tarikTx);

        const saldoTerkirim = (lamportsKirim / LAMPORTS_PER_SOL).toFixed(4);
        const teksSukses = `✅ *PENARIKAN BERHASIL!*\n\nBerhasil mengirim *${saldoTerkirim} SOL* ke:\n\`\${alamatTujuan}\`\n\n🔗 *Resi Transaksi:*\n[Lihat di Solscan](https://solscan.io/tx/${txid})`;

        await ctx.telegram.editMessageText(ctx.chat.id, pesanProses.message_id, null, teksSukses, { parse_mode: 'Markdown', disable_web_page_preview: true });

    } catch (error) {
        console.log("Error Tarik:", error);
        await ctx.telegram.editMessageText(ctx.chat.id, pesanProses.message_id, null, '❌ *Penarikan Gagal!*\nPastikan alamat tujuan valid dan jaringan Solana tidak sedang sibuk.', { parse_mode: 'Markdown' });
    }
});
