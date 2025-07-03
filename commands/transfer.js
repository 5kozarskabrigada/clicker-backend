// This file should export a single function
module.exports = function (bot, supabase) {

    // The function that handles the /transfer command
    async function handleTransfer(msg) {
        const userId = msg.from.id;
        const text = msg.text.trim();
        const match = text.match(/^\/transfer\s+@?(\w+)\s+(\d+)$/);

        if (!match) {
            return bot.sendMessage(msg.chat.id, 'Usage: /transfer @username amount\nExample: /transfer @john 100');
        }

        const [_, toUsername, amountStr] = match;
        const amount = parseInt(amountStr, 10);

        if (amount <= 0) {
            return bot.sendMessage(msg.chat.id, 'Enter a positive number of coins.');
        }

        // ... (The rest of your transfer logic is correct)
        const { data: sender, error: senderErr } = await supabase.from('users').select('*').eq('telegram_id', userId).single();
        if (senderErr || !sender) return bot.sendMessage(msg.chat.id, 'Sender not found.');
        if (sender.coins < amount) return bot.sendMessage(msg.chat.id, 'Not enough coins.');
        const { data: recipient, error: recipientErr } = await supabase.from('users').select('*').eq('username', toUsername).single();
        if (recipientErr || !recipient) return bot.sendMessage(msg.chat.id, `User @${toUsername} not found.`);

        const { error: senderUpdateErr } = await supabase.from('users').update({ coins: sender.coins - amount }).eq('telegram_id', userId);
        const { error: recipientUpdateErr } = await supabase.from('users').update({ coins: recipient.coins + amount }).eq('id', recipient.id);

        if (senderUpdateErr || recipientUpdateErr) return bot.sendMessage(msg.chat.id, 'Transfer failed.');

        await supabase.from('transfer_history').insert([{ from_user_id: sender.id, to_user_id: recipient.id, amount: amount }]);

        return bot.sendMessage(msg.chat.id, `You sent ${amount} coins to @${toUsername}`);
    }

    // This function returns the actual handler that bot.onText needs
    return handleTransfer;

    // --- DELETE THE CODE THAT WAS CAUSING THE ERROR ---
    // The following lines were at the top level of your file and causing the crash.
    // They must be removed.
    /*
    bot.onText(/\/transfers/, async (msg) => {
        // ... this code needs to be moved or handled differently
    });
    */
};