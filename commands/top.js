module.exports = function (bot, supabase) {
    return async (msg) => {
        const { data: users, error } = await supabase
            .from('users')
            .select('username, coins')
            .order('coins', { ascending: false })
            .limit(10);

        if (error || !users || users.length === 0) {
            return bot.sendMessage(msg.chat.id, 'Failed to load top players.');
        }

        let text = '🏆 Top Players:\n\n';
        users.forEach((user, idx) => {
            text += `${idx + 1}. @${user.username || 'anonymous'} — ${user.coins.toLocaleString()} 🪙\n`;
        });

        bot.sendMessage(msg.chat.id, text);
    };
};
