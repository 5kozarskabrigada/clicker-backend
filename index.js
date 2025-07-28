require('dotenv').config();
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
    'https://clicker-frontend-pi.vercel.app', // Your production frontend URL
    'https://web.telegram.org'
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);

       
        if (allowedOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        }

        if (/\.vercel\.app$/.test(origin)) {
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
        imgSrc: ["'self'", "data:", "https://pngimg.com"], 
        connectSrc: ["'self'", "https://*.supabase.co"],
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
        const user = await getDBUser(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        await supabase.rpc('process_passive_income', { p_user_id: user.id });
        const updatedUser = await getDBUser(req.user.id);

        res.json(updatedUser || { error: 'Failed to update user' });
    } catch (err) {
        console.error("Error in /user:", err);
        res.status(500).json({ error: 'Server error' });
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

app.post('/api/upgrade/click', validateTelegramAuth, async (req, res) => {
    try {
        const { error } = await supabase.rpc('upgrade_click', { p_user_id: req.user.id });
        if (error) throw error;
        const updatedUser = await getDBUser(req.user.id);
        res.json(updatedUser);
    } catch (err) {
        console.error("Error in /upgrade/click:", err);
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/upgrade/auto', validateTelegramAuth, async (req, res) => {
    try {
        const { error } = await supabase.rpc('upgrade_auto', { p_user_id: req.user.id });
        if (error) throw error;
        const updatedUser = await getDBUser(req.user.id);
        res.json(updatedUser);
    } catch (err) {
        console.error("Error in /upgrade/auto:", err);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/top', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('username, coins')
            .order('coins', { ascending: false })
            .limit(10);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error("Error in /top:", err);
        res.status(500).json({ error: 'Failed to load top players' });
    }
});

bot.onText(/\/start/, async (msg) => {
    try {
        const { id: telegram_id, username, first_name, last_name } = msg.from;

        const userData = {
            telegram_id,
            username,
            first_name,
            last_name,
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