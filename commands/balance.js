module.exports = function (bot, supabase) {
    return async (msg) => {
        const userId = msg.from.id;

        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', userId)
            .single();

        if (error || !user) {
            return bot.sendMessage(msg.chat.id, 'Could not retrieve your balance.');
        }

        bot.sendMessage(
            msg.chat.id,
            `Coins: ${user.coins.toLocaleString()}\n` +
            `Coins/Click: ${user.coins_per_click}\n` +
            `Coins/Sec: ${user.coins_per_sec}\n` +
            `Total Earned: ${user.total_coins_earned.toLocaleString()}\n` +
            `Total Clicks: ${user.total_clicks.toLocaleString()}`
        );
    };
};
