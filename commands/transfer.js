module.exports = function (bot, supabase) {
    return async (msg) => {
        const userId = msg.from.id;
        const text = msg.text.trim();

        // Format: /transfer @username 100
        const match = text.match(/^\/transfer\s+@?(\w+)\s+(\d+)$/);

        if (!match) {
            return bot.sendMessage(
                msg.chat.id,
                'Usage: /transfer @username amount\nExample: /transfer @john 100'
            );
        }

        const [_, toUsername, amountStr] = match;
        const amount = parseInt(amountStr);

        if (amount <= 0) {
            return bot.sendMessage(msg.chat.id, 'Enter a positive number of coins.');
        }

        const { data: sender, error: senderErr } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', userId)
            .single();

        if (senderErr || !sender) {
            return bot.sendMessage(msg.chat.id, 'Sender not found.');
        }

        if (sender.coins < amount) {
            return bot.sendMessage(msg.chat.id, 'Not enough coins.');
        }

        const { data: recipient, error: recipientErr } = await supabase
            .from('users')
            .select('*')
            .eq('username', toUsername)
            .single();

        if (recipientErr || !recipient) {
            return bot.sendMessage(msg.chat.id, `User @${toUsername} not found.`);
        }

        // Perform transfer
        const { error: senderUpdateErr } = await supabase
            .from('users')
            .update({ coins: sender.coins - amount })
            .eq('telegram_id', userId);

        const { error: recipientUpdateErr } = await supabase
            .from('users')
            .update({ coins: recipient.coins + amount })
            .eq('id', recipient.id);

        if (senderUpdateErr || recipientUpdateErr) {
            return bot.sendMessage(msg.chat.id, 'Transfer failed.');
        }

        // Log transfer history
        await supabase.from('transfer_history').insert([{
            from_user_id: sender.id,
            to_user_id: recipient.id,
            amount: amount
        }]);

        return bot.sendMessage(
            msg.chat.id,
            `You sent ${amount} coins to @${toUsername}`
        );
    };
};

bot.onText(/\/transfers/, async (msg) => {
    const userId = msg.from.id;

    const { data: user, error } = await supabase
        .from('users')
        .select('id')
        .eq('telegram_id', userId)
        .single();

    if (error || !user) {
        return bot.sendMessage(msg.chat.id, 'Could not fetch your transfers.');
    }

    const { data: transfers, error: historyErr } = await supabase
        .from('transfer_history')
        .select('to_user_id, amount, created_at, users!transfer_history_to_user_id_fkey(username)')
        .eq('from_user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(5);

    if (historyErr || transfers.length === 0) {
        return bot.sendMessage(msg.chat.id, 'No recent transfers.');
    }

    let historyText = `Last Transfers:\n\n`;
    for (const t of transfers) {
        historyText += `@${t.users?.username || 'unknown'}: ${t.amount} 🪙 on ${new Date(t.created_at).toLocaleDateString()}\n`;
    }

    bot.sendMessage(msg.chat.id, historyText);
});
