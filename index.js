equire('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const TelegramBot = require('node-telegram-bot-api');
const supabase = require('./db');
const crypto = require('crypto');

const { TELEGRAM_BOT_TOKEN, WEB_APP_URL, PORT = 10000, SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!TELEGRAM_BOT_TOKEN || !WEB_APP_URL || !SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing required environment variables!");
}

const app = express();



const allowedOrigins = [
    'https://clicker-frontend-pi.vercel.app',
    'https://web.telegram.org'
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);

        const standardizedOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;

        if (allowedOrigins.indexOf(standardizedOrigin) !== -1 || /\.vercel\.app$/.test(standardizedOrigin)) {

            return callback(null, true);
        }

        return callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'), false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};



app.use(cors(corsOptions));

app.use(express.json());

app.use(helmet.contentSecurityPolicy({
    directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://telegram.org"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https://pngimg.com", "https://i1.sndcdn.com"], 
        connectSrc: ["'self'", "https://*.supabase.co", "https://clicker-backend-chjq.onrender.com"], 
    }
}));

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
    console.error(`Polling error: ${error.code} - ${error.message}`);
    if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
        console.warn('Conflict error detected. This instance will stop polling.');
        bot.stopPolling();
    }
});



app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Welcome to Clicker Backend' });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


const validateTelegramAuth = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader) return res.status(401).json({ error: 'Missing Telegram InitData' });

        const initData = new URLSearchParams(authHeader);
        const hash = initData.get('hash');
        const dataToCheck = [];

        initData.sort();
        initData.forEach((val, key) => {
            if (key !== 'hash') dataToCheck.push(`${key}=${val}`);
        });

        const secret = crypto.createHmac('sha256', 'WebAppData')
            .update(TELEGRAM_BOT_TOKEN)
            .digest();
        const calculatedHash = crypto.createHmac('sha256', secret)
            .update(dataToCheck.join('\n'))
            .digest('hex');

        if (calculatedHash !== hash) {
            return res.status(403).json({ error: 'Invalid hash' });
        }

        const user = initData.get('user');
        if (!user) return res.status(400).json({ error: 'User data missing' });

        req.user = JSON.parse(user);
        next();
    } catch (err) {
        console.error('Auth error:', err);
        res.status(400).json({ error: 'Invalid initData' });
    }
};


async function getDBUser(telegramId) {
    const { data: users, error } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', telegramId);

    if (error) {
        console.error(`Error fetching user:`, error.message);
        return null;
    }
    return users?.[0] || null;
}



app.get('/api/user', validateTelegramAuth, async (req, res) => {
    try {
        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        const { data: earningsData, error: rpcError } = await supabase.rpc('process_passive_income', { p_user_id: dbUser.id });
        if (rpcError) throw rpcError;

        const updatedUser = await getDBUser(req.user.id);

        res.json({ user: updatedUser, earnings: earningsData });

    } catch (err) {
        console.error("Error in /user endpoint:", err);
        res.status(500).json({ error: 'Server error during user fetch' });
    }
});

app.post('/api/click', validateTelegramAuth, async (req, res) => {
    try {
        const user = await getDBUser(req.user.id);
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
            .eq('telegram_id', req.user.id)
            .select()
            .single();

        if (error) throw error;

        await supabase.from('user_logs').insert({
            user_id: user.id,
            action: 'click',
            details: { coins_earned: user.coins_per_click }
        });

        res.json(updatedUser);
    } catch (err) {
        console.error("Error in /click:", err);
        res.status(500).json({ error: 'Failed to process click' });
    }
});

app.post('/api/upgrade', validateTelegramAuth, async (req, res) => {
    const { upgradeId } = req.body;

    if (!upgradeId) {
        return res.status(400).json({ error: 'Missing upgradeId' });
    }

    try {
        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) return res.status(404).json({ error: 'User not found in DB' });

        await supabase
            .from('users')
            .update({ total_upgrades: dbUser.total_upgrades + 1 })
            .eq('id', dbUser.id);


        const { error } = await supabase.rpc('purchase_upgrade', {
            p_user_id: dbUser.id,
            p_upgrade_id: upgradeId
        });

        if (error) throw error;

        const updatedUser = await getDBUser(req.user.id);
        res.json(updatedUser);

    } catch (err) {
        console.error(`Error in /upgrade for ${upgradeId}:`, err);
        const message = err.message.includes('Not enough coins') ? 'You do not have enough coins for this upgrade.' : 'Upgrade failed.';
        res.status(400).json({ error: message });
    }
});


app.get('/api/top', async (req, res) => {
    const sortBy = req.query.sortBy || 'coins';

    const allowedSortColumns = ['coins', 'coins_per_click', 'coins_per_sec', 'offline_coins_per_hour'];
    if (!allowedSortColumns.includes(sortBy)) {
        return res.status(400).json({ error: 'Invalid sort parameter' });
    }

    try {
        const { data, error } = await supabase
            .from('users')
            .select(`username, ${sortBy}`)
            .order(sortBy, { ascending: false })
            .limit(10);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error(`Error in /top for sortBy=${sortBy}:`, err);
        res.status(500).json({ error: 'Failed to load top players' });
    }
});

app.get('/api/transfers', validateTelegramAuth, async (req, res) => {
    const dbUser = await getDBUser(req.user.id);
    if (!dbUser) return res.status(404).json({ error: 'User not found' });

    try {
        const { data, error } = await supabase
            .from('transfer_history')
            .select(`*, from:from_user_id(username), to:to_user_id(username)`)
            .or(`from_user_id.eq.${dbUser.id},to_user_id.eq.${dbUser.id}`)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load transfers' });
    }
});



app.get('/api/game-data', validateTelegramAuth, async (req, res) => {
    try {
        const { data: images, error: imgError } = await supabase.from('images').select('*');
        if (imgError) throw imgError;

        const { data: tasks, error: taskError } = await supabase.from('tasks').select('*');
        if (taskError) throw taskError;

        res.json({ images, tasks });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load game data' });
    }
});

app.get('/api/user-progress', validateTelegramAuth, async (req, res) => {
    const dbUser = await getDBUser(req.user.id);
    if (!dbUser) return res.status(404).json({ error: 'User not found' });

    try {
        const { data: user_images, error } = await supabase.from('user_images').select('image_id').eq('user_id', dbUser.id);
        if (error) throw error;

        res.json({ unlocked_image_ids: user_images.map(img => img.image_id) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user progress' });
    }
});


app.post('/api/images/buy', validateTelegramAuth, async (req, res) => {
    const { imageId } = req.body;
    const dbUser = await getDBUser(req.user.id);

    const { data: image } = await supabase.from('images').select('cost').eq('id', imageId).single();
    if (!image || dbUser.coins < image.cost) {
        return res.status(400).json({ error: 'Cannot afford this image' });
    }

    await supabase.from('users').update({ coins: dbUser.coins - image.cost }).eq('id', dbUser.id);
    await supabase.from('user_images').insert({ user_id: dbUser.id, image_id: imageId });

    res.json({ success: true });
});


app.post('/api/images/select', validateTelegramAuth, async (req, res) => {
    const { imageId } = req.body;
    const dbUser = await getDBUser(req.user.id);

    await supabase.from('users').update({ equipped_image_id: imageId }).eq('id', dbUser.id);

    const updatedUser = await getDBUser(req.user.id);
    res.json(updatedUser);
});

app.get('/api/user-tasks', validateTelegramAuth, async (req, res) => {
    const dbUser = await getDBUser(req.user.id);
    if (!dbUser) return res.status(404).json({ error: 'User not found' });

    try {
        const { data, error } = await supabase.rpc('check_user_tasks', { p_user_id: dbUser.id });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to check tasks' });
    }
});

bot.onText(/\/start/, async (msg) => {
    try {
        const { id: telegram_id, username, first_name, last_name } = msg.from;

        const newUserProfile = {
            telegram_id,
            username: username || `user_${telegram_id}`,
            first_name,
            last_name,
            coins: 0.000000000,
            coins_per_click: 0.000000001,
            coins_per_sec: 0,
            offline_coins_per_hour: 0,

            click_tier_1_level: 0,
            click_tier_2_level: 0,
            click_tier_3_level: 0,
            click_tier_4_level: 0,
            click_tier_5_level: 0,
            auto_tier_1_level: 0,
            auto_tier_2_level: 0,
            auto_tier_3_level: 0,
            auto_tier_4_level: 0,
            auto_tier_5_level: 0,
            offline_tier_1_level: 0,
            offline_tier_2_level: 0,
            offline_tier_3_level: 0,
            offline_tier_4_level: 0,
            offline_tier_5_level: 0,

            total_clicks: 0,
            total_coins_earned: 0.0,
            last_active: new Date().toISOString()
        };

        const { error } = await supabase
            .from('users')
            .upsert(newUserProfile, { onConflict: 'telegram_id' });

        if (error) throw error;

        bot.sendMessage(msg.chat.id, "Welcome! Click below to play.", {
            reply_markup: {
                inline_keyboard: [[{
                    text: "🚀 Open Game",
                    web_app: { url: WEB_APP_URL }
                }]]
            }
        });
    } catch (error) {
        console.error("Error in /start:", error);
        bot.sendMessage(msg.chat.id, "Sorry, an error occurred. Please try again.");
    }
});


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});