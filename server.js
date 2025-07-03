require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const supabase = require('./db');
const crypto = require('crypto');

// --- ENV-VARIABLES CHECK ---
const { TELEGRAM_BOT_TOKEN, WEB_APP_URL, PORT = 5050 } = process.env;
if (!TELEGRAM_BOT_TOKEN || !WEB_APP_URL) {
    throw new Error("Missing required environment variables: TELEGRAM_BOT_TOKEN, WEB_APP_URL");
}

// --- EXPRESS API SETUP ---
const app = express();
app.use(cors());
app.use(express.json());

// --- MIDDLEWARE & HELPERS ---

const validateTelegramAuth = (req, res, next) => {
    const authHeader = req.headers['telegram-init-data'];
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
    const { data, error } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
    return error ? null : data;
}

// --- API ROUTES ---

// GET /api/user: Load user data and process passive income.
app.get('/api/user', validateTelegramAuth, async (req, res) => {
    let user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Process passive income earned since last activity
    await supabase.rpc('process_passive_income', { p_user_id: user.id });

    // Check for any achievements that might have been unlocked
    const { data: newAchievements } = await supabase.rpc('check_and_grant_achievements', { p_user_id: user.id });

    // Fetch the final, fully updated user state
    const updatedUser = await getDBUser(req.user.id);
    res.json({ ...updatedUser, newly_unlocked_achievements: newAchievements || [] });
});

// POST /api/click: Handle a click action.
app.post('/api/click', validateTelegramAuth, async (req, res) => {
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updates = {
        coins: user.coins + user.coins_per_click,
        total_clicks: user.total_clicks + 1,
        total_coins_earned: user.total_coins_earned + user.coins_per_click,
        last_active: new Date().toISOString(),
    };

    const { data: updatedUser, error } = await supabase.from('users').update(updates).eq('id', user.id).select().single();
    if (error) return res.status(500).json({ error: 'Failed to process click' });

    // Check for achievements after the click
    await supabase.rpc('check_and_grant_achievements', { p_user_id: user.id });

    res.json(updatedUser);
});

// POST /api/upgrade/click & /api/upgrade/auto
['click', 'auto'].forEach(type => {
    app.post(`/api/upgrade/${type}`, validateTelegramAuth, async (req, res) => {
        const user = await getDBUser(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const { error } = await supabase.rpc(`upgrade_${type}`, { p_user_id: user.id });
        if (error) return res.status(400).json({ error: error.message });

        await supabase.rpc('check_and_grant_achievements', { p_user_id: user.id });

        const updatedUser = await getDBUser(req.user.id);
        res.json(updatedUser);
    });
});

// POST /api/transfer: Securely transfer coins to another user.
app.post('/api/transfer', validateTelegramAuth, async (req, res) => {
    const { toUsername, amount } = req.body;
    const fromUser = await getDBUser(req.user.id);
    if (!fromUser) return res.status(404).json({ error: 'Sender not found' });

    const { error } = await supabase.rpc('transfer_coins', {
        p_from_user_id: fromUser.id,
        p_to_username: toUsername,
        p_amount: parseInt(amount, 10)
    });

    if (error) return res.status(400).json({ error: error.message });

    const updatedSender = await getDBUser(req.user.id);
    res.json({ message: `Successfully sent ${amount} coins to @${toUsername}!`, updatedSender });
});

// GET /api/top: Get the top 10 players.
app.get('/api/top', async (req, res) => {
    const { data, error } = await supabase.from('users').select('username, coins').order('coins', { ascending: false }).limit(10);
    if (error) return res.status(500).json({ error: 'Failed to load top players' });
    res.json(data);
});

// GET /api/images: Get all available images and user's owned images.
app.get('/api/images', validateTelegramAuth, async (req, res) => {
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: allImages, error: imgErr } = await supabase.from('image_upgrades').select('*');
    const { data: userImages, error: userImgErr } = await supabase.from('user_images').select('image_id').eq('user_id', user.id);

    if (imgErr || userImgErr) return res.status(500).json({ error: 'Could not fetch images' });

    res.json({ allImages, userImages, currentImageId: user.current_image });
});

// POST /api/images/buy: Purchase a new image.
app.post('/api/images/buy', validateTelegramAuth, async (req, res) => {
    const { imageId } = req.body;
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: updatedUser, error } = await supabase.rpc('buy_image', { p_user_id: user.id, p_image_id: imageId });
    if (error) return res.status(400).json({ error: error.message });

    res.json(updatedUser);
});

// POST /api/images/select: Select an owned image.
app.post('/api/images/select', validateTelegramAuth, async (req, res) => {
    const { imageId } = req.body;
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify ownership
    const { data: owned, error: ownErr } = await supabase.from('user_images').select('image_id').eq('user_id', user.id).eq('image_id', imageId).single();
    if (ownErr || !owned) return res.status(403).json({ error: 'You do not own this image.' });

    const { data: updatedUser, error } = await supabase.from('users').update({ current_image: imageId }).eq('id', user.id).select().single();
    if (error) return res.status(500).json({ error: 'Failed to select image.' });

    res.json(updatedUser);
});

// GET /api/achievements: Get all achievements and user's unlocked achievements.
app.get('/api/achievements', validateTelegramAuth, async (req, res) => {
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: allAchievements, error: achErr } = await supabase.from('achievements').select('*');
    const { data: userAchievements, error: userAchErr } = await supabase.from('user_achievements').select('achievement_id, unlocked_at').eq('user_id', user.id);

    if (achErr || userAchErr) return res.status(500).json({ error: 'Could not fetch achievements' });

    res.json({ allAchievements, userAchievements });
});

app.listen(PORT, () => console.log(`API server listening on port ${PORT}`));

// --- TELEGRAM BOT LOGIC ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
    const { id: telegram_id, username, first_name, last_name } = msg.from;
    let { data: user } = await supabase.from('users').select('id').eq('telegram_id', telegram_id).single();
    if (!user) {
        await supabase.from('users').insert([{
            telegram_id, username, first_name, last_name,
            coins: 0, coins_per_click: 1, coins_per_sec: 0,
            click_upgrade_level: 1, click_upgrade_cost: 10,
            auto_upgrade_level: 0, auto_upgrade_cost: 20,
            current_image: 'default' // Or your default image ID
        }]);
    }
    bot.sendMessage(msg.chat.id, `Welcome to Clicker Pro, @${username}!`, {
        reply_markup: { inline_keyboard: [[{ text: '🚀 Open Clicker Game', web_app: { url: WEB_APP_URL } }]] }
    });
});

console.log('Bot is running...');