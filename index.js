// --- SETUP (TOP OF FILE) ---
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
    if (error) {
        console.error(`Error fetching user for telegramId ${telegramId}:`, error.message);
        return null;
    }
    return data;
}

// --- API ROUTES ---

// GET /api/user: Get user data and calculate passive income
app.get('/api/user', validateTelegramAuth, async (req, res) => {
    const telegramId = req.user.id;
    let user = await getDBUser(telegramId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    // Assuming process_passive_income SQL function exists
    await supabase.rpc('process_passive_income', { p_user_id: user.id }).catch(err => console.error("Error processing passive income:", err.message));

    // Fetch user again to get updated coin count
    const updatedUser = await getDBUser(telegramId);
    res.json(updatedUser);
});

// POST /api/click: Handle a click action
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

// POST /api/upgrade/click
app.post('/api/upgrade/click', validateTelegramAuth, async (req, res) => {
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { error } = await supabase.rpc('upgrade_click', { p_user_id: user.id });
    if (error) return res.status(400).json({ error: error.message });
    const updatedUser = await getDBUser(req.user.id);
    res.json(updatedUser);
});

// POST /api/upgrade/auto
app.post('/api/upgrade/auto', validateTelegramAuth, async (req, res) => {
    const user = await getDBUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { error } = await supabase.rpc('upgrade_auto', { p_user_id: user.id });
    if (error) return res.status(400).json({ error: error.message });
    const updatedUser = await getDBUser(req.user.id);
    res.json(updatedUser);
});

// GET /api/top
app.get('/api/top', async (req, res) => {
    const { data, error } = await supabase.from('users').select('username, coins').order('coins', { ascending: false }).limit(10);
    if (error) return res.status(500).json({ error: 'Failed to load top players' });
    res.json(data);
});

// --- TELEGRAM BOT COMMAND HANDLERS ---

// Command: /start (Handles user creation)
bot.onText(/\/start/, async (msg) => {
    const { id: telegram_id, username, first_name, last_name } = msg.from;
    try {
        // --- Self-healing logic ---
        // 1. Delete any potential duplicate entries for this user first.
        await supabase.from('users').delete().eq('telegram_id', telegram_id);

        // 2. Now, insert a single, clean record.
        const { error: insertError } = await supabase.from('users').insert([{
            telegram_id, username, first_name, last_name,
            coins: 0, coins_per_click: 1, coins_per_sec: 0,
            click_upgrade_level: 1, click_upgrade_cost: 10,
            auto_upgrade_level: 0, auto_upgrade_cost: 20,
            current_image: 'default',
            total_clicks: 0, total_coins_earned: 0, total_upgrades: 0,
            last_active: new Date().toISOString()
        }]);

        if (insertError) {
            // If insert fails for any other reason, throw the error.
            throw insertError;
        }

        // 3. Send the welcome message.
        bot.sendMessage(msg.chat.id, `Welcome to the Clicker Game, @${username}!\n\nClick the button below to start playing.`, {
            reply_markup: { inline_keyboard: [[{ text: '🚀 Open Clicker Game', web_app: { url: WEB_APP_URL } }]] }
        });

    } catch (error) {
        console.error("Error in /start command:", error);
        bot.sendMessage(msg.chat.id, "Sorry, there was an error setting up your account. Please try again in a moment.");
    }
});


// --- INITIALIZE EXTERNAL COMMAND FILES ---
// This pattern allows you to keep command logic in separate files.
const balanceHandler = require('./commands/balance')(bot, supabase);
const topHandler = require('./commands/top')(bot, supabase);
const transferHandler = require('./commands/transfer')(bot, supabase);
const clickHandler = require('./commands/click.js');

// Attach the handlers to the bot
bot.onText(/\/balance/, balanceHandler);
bot.onText(/\/top/, topHandler);
bot.onText(/\/transfer/, transferHandler);
bot.onText(/\/click/, clickHandler(bot, supabase));


// --- START THE SERVER (AT THE VERY END) ---
app.listen(PORT, () => {
    console.log(`API server listening on port ${PORT}`);
    console.log('Bot is running...');
});