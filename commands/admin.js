module.exports = function (bot, supabase) {
    async function logAdminAction(adminId, action, targetUserId = null, details = {}) {
        await supabase.from('admin_logs').insert({
            admin_id: adminId,
            action,
            target_user_id: targetUserId,
            details
        });
    }


    async function logUserAction(userId, action, details = {}) {
        await supabase.from('user_logs').insert({
            user_id: userId,
            action,
            details
        });
    }


    async function isAdmin(userId) {
        const { data, error } = await supabase
            .from('users')
            .select('is_admin')
            .eq('telegram_id', userId)
            .single();

        return data?.is_admin === true;
    }


    async function handleAdminCommand(msg) {
        const userId = msg.from.id;
        const isUserAdmin = await isAdmin(userId);

        if (!isUserAdmin) {
            return bot.sendMessage(msg.chat.id, "❌ You don't have permission to use this command.");
        }

        const command = msg.text.split(' ')[0];
        const args = msg.text.split(' ').slice(1);

        switch (command) {
            case '/ban':
                return handleBan(msg, args);
            case '/unban':
                return handleUnban(msg, args);
            case '/setcoins':
                return handleSetCoins(msg, args);
            case '/addcoins':
                return handleAddCoins(msg, args);
            case '/adminlogs':
                return handleAdminLogs(msg, args);
            case '/userlogs':
                return handleUserLogs(msg, args);
            case '/makeadmin':
                return handleMakeAdmin(msg, args);
            default:
                return showAdminHelp(msg);
        }
    }

    async function handleBan(msg, args) {
        if (args.length < 1) {
            return bot.sendMessage(msg.chat.id, "Usage: /ban @username [reason]");
        }

        const username = args[0].replace('@', '');
        const reason = args.slice(1).join(' ') || "No reason provided";


        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .single();

        if (error || !user) {
            return bot.sendMessage(msg.chat.id, "User not found.");
        }


        const { error: updateError } = await supabase
            .from('users')
            .update({ is_banned: true, banned_reason: reason })
            .eq('id', user.id);

        if (updateError) {
            return bot.sendMessage(msg.chat.id, "Failed to ban user.");
        }

        await supabase.from('admin_logs').insert({
            admin_id: adminUser.id, 
            action: 'ban',
            target_user_id: user.id,
            details: { reason }
        });

        return bot.sendMessage(msg.chat.id, `✅ User @${username} has been banned. Reason: ${reason}`);
    }

    async function handleSetCoins(msg, args) {
        if (args.length < 2) {
            return bot.sendMessage(msg.chat.id, "Usage: /setcoins @username amount");
        }

        const username = args[0].replace('@', '');
        const amount = parseInt(args[1]);

        if (isNaN(amount)) {
            return bot.sendMessage(msg.chat.id, "Please enter a valid number.");
        }


        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .single();

        if (error || !user) {
            return bot.sendMessage(msg.chat.id, "User not found.");
        }

        const { error: updateError } = await supabase
            .from('users')
            .update({ coins: amount })
            .eq('id', user.id);

        if (updateError) {
            return bot.sendMessage(msg.chat.id, "Failed to update coins.");
        }

        await logAdminAction(msg.from.id, 'set_coins', user.id, { amount });

        return bot.sendMessage(msg.chat.id, `✅ Set @${username}'s coins to ${amount}.`);
    }



    function showAdminHelp(msg) {
        const helpText = `
        👑 Admin Commands:
        
        /ban @username [reason] - Ban a user
        /unban @username - Unban a user
        /setcoins @username amount - Set a user's coin balance
        /addcoins @username amount - Add coins to a user's balance
        /adminlogs [count] - Show recent admin actions
        /userlogs @username [count] - Show user logs
        /makeadmin @username - Grant admin privileges
        `;

        return bot.sendMessage(msg.chat.id, helpText);
    }

    return handleAdminCommand;
};