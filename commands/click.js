async function handleWebAppClick(bot, supabase, userId) {
    const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', userId)
        .single();

    if (error || !user) {
        return { error: 'User not found' };
    }

    // Update user data
    const updates = {
        coins: user.coins + user.coins_per_click,
        total_clicks: user.total_clicks + 1,
        total_coins_earned: user.total_coins_earned + user.coins_per_click,
        last_active: new Date()
    };

    const { data: updatedUser, error: updateError } = await supabase
        .from('users')
        .update(updates)
        .eq('telegram_id', userId)
        .select()
        .single();

    return updatedUser;
}

module.exports = function (bot, supabase) {
    return async (msg) => {
        const userId = msg.from.id;
        const user = await handleWebAppClick(bot, supabase, userId);

        if (user.error) {
            return bot.sendMessage(msg.chat.id, `Error: ${user.error}`);
        }

        bot.sendMessage(
            msg.chat.id,
            `💰 You clicked and earned ${user.coins_per_click} coins!\n` +
            `Total coins: ${user.coins}`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        {
                            text: 'Open Clicker',
                            web_app: { url: process.env.WEB_APP_URL }
                        }
                    ]]
                }
            }
        );
    };
};

module.exports.handleWebAppClick = handleWebAppClick;