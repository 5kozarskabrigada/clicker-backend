require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const supabase = require('./db');
const crypto = require('crypto');
const adminHandler = require('./commands/admin')(bot, supabase);

const { TELEGRAM_BOT_TOKEN, WEB_APP_URL, PORT = 10000, SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!TELEGRAM_BOT_TOKEN || !WEB_APP_URL || !SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing required environment variables!");
}


const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: { interval: 300, autoStart: true, params: { timeout: 10 } } });

bot.on('polling_error', (error) => {
    console.error(`Polling error: ${error.code} - ${error.message}`);

    if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
        console.warn('Conflict error detected. This instance will stop polling.');
        bot.stopPolling();
    }
});


const app = express();
app.use(cors());
app.use(express.json());


const validateTelegramAuth = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            return res.status(401).json({ error: 'Not authorized: Missing Telegram InitData' });
        }

        const initData = new URLSearchParams(authHeader);
        const hash = initData.get('hash');
        const dataToCheck = [];

        initData.sort();
        initData.forEach((val, key) => {
            if (key !== 'hash') {
                dataToCheck.push(`${key}=${val}`);
            }
        });

        const secret = crypto.createHmac('sha256', 'WebAppData')
            .update(TELEGRAM_BOT_TOKEN)
            .digest();
        const calculatedHash = crypto.createHmac('sha256', secret)
            .update(dataToCheck.join('\n'))
            .digest('hex');

        if (calculatedHash !== hash) {
            return res.status(403).json({ error: 'Not authorized: Invalid hash' });
        }

        const user = initData.get('user');
        if (!user) return res.status(400).json({ error: 'Invalid initData: user missing' });

        req.user = JSON.parse(user);
        next();
    } catch (err) {
        console.error('Auth error:', err);
        res.status(400).json({ error: 'Invalid initData format or hash' });
    }
};


async function getDBUser(telegramId) {
    const { data: users, error } = await supabase.from('users').select('*').eq('telegram_id', telegramId);
    if (error) {
        console.error(`Error fetching user for telegramId ${telegramId}:`, error.message);
        return null;
    }
    if (!users || users.length === 0) return null;
    if (users.length > 1) {
        console.warn(`Multiple users found for telegramId ${telegramId}, returning first one and attempting cleanup.`);
    }
    return users[0];
}




app.get('/api/user', validateTelegramAuth, async (req, res) => {
    const telegramId = req.user.id;
    let user = await getDBUser(telegramId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    try {
        await supabase.rpc('process_passive_income', { p_user_id: user.id });
    } catch (err) {
        console.error("Error processing passive income:", err.message);
    }
    const updatedUser = await getDBUser(telegramId);
    if (!updatedUser) return res.status(404).json({ error: 'User not found after passive income update' });
    res.json(updatedUser);
});

app.post('/api/click', validateTelegramAuth, async (req, res) => {
    const telegramId = req.user.id;
    const user = await getDBUser(telegramId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updates = {
        coins: user.coins + user.coins_per_click,
        total_clicks: user.total_clicks + 1,
        total_coins_earned: user.total_coins_earned + user.coins_per_click,
        last_active: new Date().toISOString(),
    };

    const { data: updatedUser, error } = await supabase
        .from('users')
        .update(updates)
        .eq('telegram_id', telegramId)
        .select()
        .single();

    if (error) return res.status(500).json({ error: 'Failed to process click' });


    await supabase.from('user_logs').insert({
        user_id: user.id, 
        action: 'click',
        details: { coins_earned: user.coins_per_click }
    });

    res.json(updatedUser);
});

app.post('/api/upgrade/click', validateTelegramAuth, async (req, res) => {
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { error } = await supabase.rpc('upgrade_click', { p_user_id: user.id });
    if (error) return res.status(400).json({ error: error.message });
    const updatedUser = await getDBUser(req.user.id);
    res.json(updatedUser);
});

app.post('/api/upgrade/auto', validateTelegramAuth, async (req, res) => {
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { error } = await supabase.rpc('upgrade_auto', { p_user_id: user.id });
    if (error) return res.status(400).json({ error: error.message });
    const updatedUser = await getDBUser(req.user.id);
    res.json(updatedUser);
});

app.get('/api/top', async (req, res) => {
    const { data, error } = await supabase.from('users').select('username, coins').order('coins', { ascending: false }).limit(10);
    if (error) return res.status(500).json({ error: 'Failed to load top players' });
    res.json(data);
});

app.post('/api/transfer', validateTelegramAuth, async (req, res) => {
    const { toUsername, amount } = req.body;
    const fromUser = await getDBUser(req.user.id);
    if (!fromUser) return res.status(404).json({ error: 'Sender not found' });
    const { error } = await supabase.rpc('transfer_coins', { p_from_user_id: fromUser.id, p_to_username: toUsername, p_amount: parseInt(amount, 10) });
    if (error) return res.status(400).json({ error: error.message });
    const updatedSender = await getDBUser(req.user.id);
    res.json({ message: `Successfully sent ${amount} coins to @${toUsername}!`, updatedSender });
});

app.get('/api/images', validateTelegramAuth, async (req, res) => {
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { data: allImages, error: imgErr } = await supabase.from('image_upgrades').select('*');
    const { data: userImages, error: userImgErr } = await supabase.from('user_images').select('image_id').eq('user_id', user.id);
    if (imgErr || userImgErr) return res.status(500).json({ error: 'Could not fetch images' });
    res.json({ allImages, userImages, currentImageId: user.current_image });
});

app.post('/api/images/buy', validateTelegramAuth, async (req, res) => {
    const { imageId } = req.body;
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { data: updatedUser, error } = await supabase.rpc('buy_image', { p_user_id: user.id, p_image_id: imageId });
    if (error) return res.status(400).json({ error: error.message });
    res.json(updatedUser);
});

app.post('/api/images/select', validateTelegramAuth, async (req, res) => {
    const { imageId } = req.body;
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { data: owned, error: ownErr } = await supabase.from('user_images').select('image_id').eq('user_id', user.id).eq('image_id', imageId).single();
    if (ownErr || !owned) return res.status(403).json({ error: 'You do not own this image.' });
    const { data: updatedUser, error } = await supabase.from('users').update({ current_image: imageId }).eq('id', user.id).select().single();
    if (error) return res.status(500).json({ error: 'Failed to select image.' });
    res.json(updatedUser);
});

app.get('/api/achievements', validateTelegramAuth, async (req, res) => {
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { data: allAchievements, error: achErr } = await supabase.from('achievements').select('*');
    const { data: userAchievements, error: userAchErr } = await supabase.from('user_achievements').select('achievement_id, unlocked_at').eq('user_id', user.id);
    if (achErr || userAchErr) return res.status(500).json({ error: 'Could not fetch achievements' });
    res.json({ allAchievements, userAchievements });
});

app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;


    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('username', username)
        .eq('is_admin', true)
        .single();

    if (error || !user) {
        return res.status(403).json({ error: 'Access denied' });
    }


    const token = crypto.randomBytes(32).toString('hex');

    res.json({ token });
});


app.use('/admin/api', async (req, res, next) => {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
});


app.get('/admin/api/users', async (req, res) => {
    const { search, page = 1, limit = 20 } = req.query;

    let query = supabase
        .from('users')
        .select('id, username, coins, is_admin, is_banned, banned_reason, created_at',
            { count: 'exact' })
        .order('coins', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

    if (search) {
        query = query.ilike('username', `%${search}%`);
    }

    const { data: users, count, error } = await query;

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json({ users, total: count });
});


bot.onText(/\/start/, async (msg) => {
    const { id: telegram_id, username, first_name, last_name } = msg.from;
    const chatId = msg.chat.id;

    try {
        const userData = {
            telegram_id: telegram_id,
            username: username,
            first_name: first_name,
            last_name: last_name,
            coins: 0,
            coins_per_click: 1,
            coins_per_sec: 0,
            click_upgrade_level: 1,
            click_upgrade_cost: 10,
            auto_upgrade_level: 0,
            auto_upgrade_cost: 20,
            current_image: 'default',
            total_clicks: 0,
            total_coins_earned: 0,
            total_upgrades: 0,
            last_active: new Date().toISOString()
        };

      
        const { error } = await supabase.from('users').upsert(userData, { onConflict: 'telegram_id' });

        if (error) throw error;

        bot.sendMessage(chatId, "Welcome! Click below to play.", {
            reply_markup: {
                inline_keyboard: [[{ text: "🚀 Open Game", web_app: { url: WEB_APP_URL } }]]
            }
        });

    } catch (error) {
        console.error("Error in /start command:", error);
        bot.sendMessage(chatId, "Sorry, an error occurred. Please try again.");
    }
});

bot.onText(/^\/(ban|unban|setcoins|addcoins|adminlogs|userlogs|makeadmin)/, adminHandler);

// try {
//     const balanceHandler = require('./commands/balance')(bot, supabase);
//     const topHandler = require('./commands/top')(bot, supabase);
//     const transferHandler = require('./commands/transfer')(bot, supabase);
//     const clickHandler = require('./commands/click.js')(bot, supabase);
//     bot.onText(/\/balance/, balanceHandler);
//     bot.onText(/\/top/, topHandler);
//     bot.onText(/\/transfer/, transferHandler);
//     bot.onText(/\/click/, clickHandler);
// } catch (error) {
//     console.warn("Could not load external command files. This is okay if they don't exist.", error.message);
// }

app.listen(PORT, () => {
    console.log(`API server listening on port ${PORT}`);
    console.log('Bot is running...');
});