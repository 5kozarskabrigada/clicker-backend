require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// --- Environment Variables ---
const {
    TELEGRAM_BOT_TOKEN,
    WEB_APP_URL,
    PORT = 10000,
    SUPABASE_URL,
    SUPABASE_KEY
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !WEB_APP_URL || !SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing required environment variables!");
}

// --- Initialization ---
const app = express();
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Middleware Setup ---
const allowedOrigins = [WEB_APP_URL, 'https://web.telegram.org'];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.some(o => origin.startsWith(o)) || /\.vercel\.app$/.test(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
}));
app.use(express.json());
app.use(helmet.contentSecurityPolicy({
    directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://telegram.org"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https://pngimg.com", "https://i1.sndcdn.com"],
        connectSrc: ["'self'", `https://${new URL(SUPABASE_URL).hostname}`],
    }
}));


// --- Telegram Auth Validation Middleware ---
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

        const secret = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secret).update(dataToCheck.join('\n')).digest('hex');

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

// --- Helper Functions ---
async function getDBUser(telegramId) {
    const { data, error } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
    if (error && error.code !== 'PGRST116') { // PGRST116 means no rows found, which is not a server error
        console.error(`Error fetching user ${telegramId}:`, error.message);
    }
    return data;
}

// --- API Endpoints ---
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Welcome to Clicker Backend' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/user', validateTelegramAuth, async (req, res) => {
    try {
        let dbUser = await getDBUser(req.user.id);
        if (!dbUser) return res.status(404).json({ error: 'User not found' });

        const { data: earningsData, error: rpcError } = await supabase.rpc('process_passive_income', { p_user_id: dbUser.id });
        if (rpcError) throw rpcError;

        const updatedUser = await getDBUser(req.user.id);
        res.json({ user: updatedUser, earnings: earningsData });
    } catch (err) {
        console.error("Error in /user endpoint:", err.message);
        res.status(500).json({ error: 'Server error during user fetch' });
    }
});

app.post('/api/click', validateTelegramAuth, async (req, res) => {
    try {
        const user = await getDBUser(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Using a database function is more efficient for frequent updates
        const { data: updatedUser, error } = await supabase.rpc('increment_user_clicks', {
            p_user_id: user.id,
            p_click_increment: 1 // Sending one click at a time now
        }).single();

        if (error) throw error;
        res.json(updatedUser);
    } catch (err) {
        console.error("Error in /click:", err.message);
        res.status(500).json({ error: 'Failed to process click' });
    }
});

app.post('/api/upgrade', validateTelegramAuth, async (req, res) => {
    const { upgradeId } = req.body;
    if (!upgradeId) return res.status(400).json({ error: 'Missing upgradeId' });

    try {
        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) return res.status(404).json({ error: 'User not found' });

        const { error } = await supabase.rpc('purchase_upgrade', {
            p_user_id: dbUser.id,
            p_upgrade_id: upgradeId
        });
        if (error) throw new Error(error.message);

        const updatedUser = await getDBUser(req.user.id);
        res.json(updatedUser);
    } catch (err) {
        console.error(`Error in /upgrade for ${upgradeId}:`, err.message);
        const message = err.message.includes('Not enough coins') ? 'You do not have enough coins.' : 'Upgrade failed.';
        res.status(400).json({ error: message });
    }
});

app.get('/api/top', validateTelegramAuth, async (req, res) => {
    const sortBy = req.query.sortBy || 'coins';
    const allowedSortColumns = ['coins', 'coins_per_click', 'coins_per_sec'];
    if (!allowedSortColumns.includes(sortBy)) {
        return res.status(400).json({ error: 'Invalid sort parameter' });
    }
    try {
        const { data, error } = await supabase.from('users').select(`username, ${sortBy}`).order(sortBy, { ascending: false }).limit(10);
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load top players' });
    }
});

app.get('/api/transfers', validateTelegramAuth, async (req, res) => {
    try {
        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) return res.status(404).json({ error: 'User not found' });
        const { data, error } = await supabase.from('transfer_history').select(`*, from:from_user_id(username), to:to_user_id(username)`).or(`from_user_id.eq.${dbUser.id},to_user_id.eq.${dbUser.id}`).order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load transfers' });
    }
});

app.post('/api/transfer', validateTelegramAuth, async (req, res) => {
    try {
        const { toUsername, amount } = req.body;
        if (!toUsername || !amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Invalid username or amount.' });
        }
        const fromUser = await getDBUser(req.user.id);
        if (!fromUser) return res.status(404).json({ error: 'Sender not found' });

        // This assumes you have an RPC function in Supabase named `execute_transfer`
        const { error } = await supabase.rpc('execute_transfer', {
            from_id: fromUser.id,
            to_username: toUsername,
            transfer_amount: amount
        });

        if (error) throw new Error(error.message);

        const updatedSender = await getDBUser(req.user.id);
        res.json({ message: 'Transfer successful!', updatedSender });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/game-data', validateTelegramAuth, async (req, res) => {
    try {
        const [imagesRes, tasksRes] = await Promise.all([
            supabase.from('images').select('*'),
            supabase.from('tasks').select('*')
        ]);
        if (imagesRes.error) throw imagesRes.error;
        if (tasksRes.error) throw tasksRes.error;
        res.json({ images: imagesRes.data, tasks: tasksRes.data });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load game data' });
    }
});

app.get('/api/user-progress', validateTelegramAuth, async (req, res) => {
    try {
        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) return res.status(404).json({ error: 'User not found' });
        const { data, error } = await supabase.from('user_images').select('image_id').eq('user_id', dbUser.id);
        if (error) throw error;
        res.json({ unlocked_image_ids: data.map(img => img.image_id) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user progress' });
    }
});

app.post('/api/images/buy', validateTelegramAuth, async (req, res) => {
    try {
        const { imageId } = req.body;
        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) return res.status(404).json({ error: 'User not found' });

        const { data: image, error: imageError } = await supabase.from('images').select('cost').eq('id', imageId).single();
        if (imageError || !image) return res.status(404).json({ error: 'Image not found.' });
        if (dbUser.coins < image.cost) return res.status(400).json({ error: 'Not enough coins.' });

        const { error: updateError } = await supabase.from('users').update({ coins: dbUser.coins - image.cost }).eq('id', dbUser.id);
        if (updateError) throw updateError;

        const { error: insertError } = await supabase.from('user_images').insert({ user_id: dbUser.id, image_id: imageId });
        if (insertError) throw insertError;

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not purchase image.' });
    }
});

app.post('/api/images/select', validateTelegramAuth, async (req, res) => {
    try {
        const { imageId } = req.body;
        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) return res.status(404).json({ error: 'User not found' });

        const { error } = await supabase.from('users').update({ equipped_image_id: imageId }).eq('id', dbUser.id);
        if (error) throw error;

        const updatedUser = await getDBUser(req.user.id);
        res.json(updatedUser);
    } catch (err) {
        res.status(500).json({ error: 'Could not select image.' });
    }
});

app.get('/api/user-tasks', validateTelegramAuth, async (req, res) => {
    try {
        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) return res.status(404).json({ error: 'User not found' });
        const { data, error } = await supabase.rpc('check_user_tasks', { p_user_id: dbUser.id });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to check tasks' });
    }
});

// --- Telegram Bot Logic ---
bot.onText(/\/start/, async (msg) => {
    try {
        const { id: telegram_id, username, first_name, last_name } = msg.from;
        const { error } = await supabase.from('users').upsert({
            telegram_id,
            username: username || `user_${telegram_id}`,
            first_name,
            last_name,
            last_active: new Date().toISOString()
        }, { onConflict: 'telegram_id' });
        if (error) throw error;

        bot.sendMessage(msg.chat.id, "Welcome! Click the button below to start playing.", {
            reply_markup: {
                inline_keyboard: [[{ text: "🚀 Open Game", web_app: { url: WEB_APP_URL } }]]
            }
        });
    } catch (error) {
        console.error("Error in /start:", error.message);
        bot.sendMessage(msg.chat.id, "Sorry, an error occurred while setting up your profile.");
    }
});

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});