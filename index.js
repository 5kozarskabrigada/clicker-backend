require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const supabase = require('./db');
const crypto = require('crypto');

// --- ENV-VARIABLES CHECK ---
const { TELEGRAM_BOT_TOKEN, WEB_APP_URL, PORT = 10000, SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!TELEGRAM_BOT_TOKEN || !WEB_APP_URL || !SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing required environment variables!");
}

// --- INITIALIZE THE BOT (ONE SINGLE INSTANCE) ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- EXPRESS API SETUP ---
const app = express();
app.use(cors());
app.use(express.json());

// --- MIDDLEWARE & HELPERS ---
const validateTelegramAuth = (req, res, next) => {
    const authHeader = req.headers['Authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'Not authorized: Missing Telegram InitData' });
    }
    const initData = new URLSearchParams(authHeader);
    const hash = initData.get('hash');
    const dataToCheck = [];
    initData.sort();
    initData.forEach((val, key) => key !== 'hash' && dataToCheck.push(`${key}=${val}`));
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secret).update(dataToCheck.join('\n')).digest('hex');
    if (calculatedHash !== hash) {
        return res.status(403).json({ error: 'Not authorized: Invalid hash' });
    }
    req.user = JSON.parse(initData.get('user'));
    next();
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


// --- API ROUTES ---

app.get('/api/user', validateTelegramAuth, async (req, res) => {
    const telegramId = req.user.id;
    let user = await getDBUser(telegramId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Assuming process_passive_income SQL function exists
    await supabase.rpc('process_passive_income', { p_user_id: user.id }).catch(err => console.error("Error processing passive income:", err.message));
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
    const { data: updatedUser, error } = await supabase.from('users').update(updates).eq('telegram_id', telegramId).select().single();
    if (error) return res.status(500).json({ error: 'Failed to process click' });
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


bot.onText(/\/start/, async (msg) => {
    const { id: telegram_id, username, first_name, last_name } = msg.from;
    try {
        const { data: existingUsers } = await supabase.from('users').select('id').eq('telegram_id', telegram_id);
        if (existingUsers && existingUsers.length > 0) {
            await supabase.from('users').delete().eq('telegram_id', telegram_id);
            console.log(`Cleaned up ${existingUsers.length} old entries for user ${telegram_id}`);
        }
        const { error: insertError } = await supabase.from('users').insert([{
            telegram_id, username, first_name, last_name,
            coins: 0, coins_per_click: 1, coins_per_sec: 0,
            click_upgrade_level: 1, click_upgrade_cost: 10,
            auto_upgrade_level: 0, auto_upgrade_cost: 20,
            current_image: 'default',
            total_clicks: 0, total_coins_earned: 0, total_upgrades: 0,
            last_active: new Date().toISOString()
        }]);
        if (insertError) throw insertError;
        bot.sendMessage(msg.chat.id, `Welcome! Click below to play.`, {
            reply_markup: { inline_keyboard: [[{ text: '🚀 Open Clicker Game', web_app: { url: WEB_APP_URL } }]] }
        });
    } catch (error) {
        console.error("Error in /start command:", error);
        bot.sendMessage(msg.chat.id, "Sorry, an error occurred. Please try again.");
    }
});

// --- INITIALIZE EXTERNAL COMMAND FILES ---
/* <--- ADD THIS
try {
    const balanceHandler = require('./commands/balance')(bot, supabase);
    const topHandler = require('./commands/top')(bot, supabase);
    const transferHandler = require('./commands/transfer')(bot, supabase);
    const clickHandler = require('./commands/click.js')(bot, supabase);
    bot.onText(/\/balance/, balanceHandler);
    bot.onText(/\/top/, topHandler);
    bot.onText(/\/transfer/, transferHandler);
    bot.onText(/\/click/, clickHandler);
} catch (error) {
    console.warn("Could not load external command files. This is okay if they don't exist.", error.message);
}
ADD THIS ---> */

app.listen(PORT, () => {
    console.log(`API server listening on port ${PORT}`);
    console.log('Bot is running...');
});