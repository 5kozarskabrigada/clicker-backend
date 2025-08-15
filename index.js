require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');


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


const app = express();
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const { Decimal } = require('decimal.js'); 


const INTRA_TIER_COST_MULTIPLIER = 1.215;
const upgrades = {
    click: [
        { id: 'click_tier_1', name: 'A Cups', benefit: '+0.000000001 per click', base_cost: 0.000000064, tier: 1 },
        { id: 'click_tier_2', name: 'B Cups', benefit: '+0.000000008 per click', base_cost: 0.000001024, tier: 2 },
        { id: 'click_tier_3', name: 'C Cups', benefit: '+0.000000064 per click', base_cost: 0.000016384, tier: 3 },
        { id: 'click_tier_4', name: 'D Cups', benefit: '+0.000000512 per click', base_cost: 0.000262144, tier: 4 },
        { id: 'click_tier_5', name: 'DD Cups', benefit: '+0.000004096 per click', base_cost: 0.004194304, tier: 5 },
    ],
    auto: [
        { id: 'auto_tier_1', name: 'Basic Lotion', benefit: '+0.000000001 per sec', base_cost: 0.000000064, tier: 1 },
        { id: 'auto_tier_2', name: 'Enhanced Serum', benefit: '+0.000000008 per sec', base_cost: 0.000001024, tier: 2 },
        { id: 'auto_tier_3', name: 'Collagen Cream', benefit: '+0.000000064 per sec', base_cost: 0.000016384, tier: 3 },
        { id: 'auto_tier_4', name: 'Firming Gel', benefit: '+0.000000512 per sec', base_cost: 0.000262144, tier: 4 },
        { id: 'auto_tier_5', name: 'Miracle Elixir', benefit: '+0.000004096 per sec', base_cost: 0.004194304, tier: 5 },
    ],
    offline: [
        { id: 'offline_tier_1', name: 'Simple Bralette', benefit: '+0.000000001 per hour', base_cost: 0.000000064, tier: 1 },
        { id: 'offline_tier_2', name: 'Sports Bra', benefit: '+0.000000008 per hour', base_cost: 0.000001024, tier: 2 },
        { id: 'offline_tier_3', name: 'Padded Bra', benefit: '+0.000000064 per hour', base_cost: 0.000016384, tier: 3 },
        { id: 'offline_tier_4', name: 'Push-Up Bra', benefit: '+0.000000512 per hour', base_cost: 0.000262144, tier: 4 },
        { id: 'offline_tier_5', name: 'Designer Corset', benefit: '+0.000004096 per hour', base_cost: 0.004194304, tier: 5 },
    ]
};

const allUpgrades = [...upgrades.click, ...upgrades.auto, ...upgrades.offline];



const allowedOrigins = [
    process.env.WEB_APP_URL, 
    'https://clicker-frontend-pi.vercel.app', 
    'https://web.telegram.org'
];

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || /\.vercel\.app$/.test(origin)) {
            callback(null, true);
        } else {
            callback(new Error('This origin is not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'], 
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204 
};

app.use(cors(corsOptions));

app.options(/.*/, cors(corsOptions));


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


async function getDBUser(telegramId) {
    const { data, error } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
    if (error && error.code !== 'PGRST116') { 
        console.error(`Error fetching user ${telegramId}:`, error.message);
    }
    return data;
}


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
        const { clicks } = req.body;
        if (!clicks || typeof clicks !== 'number' || clicks <= 0) {
         
            const currentUser = await getDBUser(req.user.id);
            return res.status(200).json(currentUser);
        }

        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) {
            return res.status(404).json({ error: 'User not found' });
        }


        const { error: rpcError } = await supabase.rpc('increment_user_clicks', {
            p_user_id: dbUser.id,
            p_click_increment: clicks
        });

        if (rpcError) {
            throw new Error(`RPC Error: ${rpcError.message}`);
        }

        const updatedUser = await getDBUser(req.user.id);
        if (!updatedUser) {
            return res.status(404).json({ error: 'Could not retrieve updated user data.' });
        }

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

        const upgrade = allUpgrades.find(u => u.id === upgradeId);
        if (!upgrade) return res.status(404).json({ error: 'Upgrade not found' });

        const currentLevel = new Decimal(dbUser[`${upgradeId}_level`] || 0);
        const baseCost = new Decimal(upgrade.base_cost);
        const multiplier = new Decimal(INTRA_TIER_COST_MULTIPLIER);
        const userCoins = new Decimal(dbUser.coins);

        const cost = baseCost.times(multiplier.pow(currentLevel));

        console.log(`[Upgrade Check] User: ${dbUser.id}, Upgrade: ${upgradeId}`);
        console.log(`  > User Coins: ${userCoins.toString()}`);
        console.log(`  > Calculated Cost: ${cost.toString()}`);

        if (userCoins.lessThan(cost)) {
            console.log('  > Decision: INSUFFICIENT FUNDS');
            return res.status(400).json({ error: 'You do not have enough coins.' });
        }
        console.log('  > Decision: SUFFICIENT FUNDS, proceeding to database...');

        const { error } = await supabase.rpc('purchase_upgrade', {
            p_user_id: dbUser.id,
            p_upgrade_id: upgradeId
        });

        if (error) {
            throw new Error(error.message);
        }

        const updatedUser = await getDBUser(req.user.id);
        res.json({ success: true, newCoins: updatedUser.coins });

    } catch (err) {
        console.error(`[Upgrade Error] for ${upgradeId}:`, err.message);
        const message = err.message.includes('Not enough coins')
            ? 'You do not have enough coins.'
            : 'Upgrade failed due to a server error.';
        res.status(400).json({ error: message });
    }
    
});

app.post('/api/sync', validateTelegramAuth, async (req, res) => {
    try {
        const { clicks } = req.body;
        if (!clicks || clicks <= 0) {
            return res.status(204).send(); 
        }

        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        await supabase.rpc('increment_user_clicks', {
            p_user_id: dbUser.id,
            p_click_increment: clicks
        });

        res.status(204).send(); 
    } catch (err) {
        console.error("Error in /sync endpoint:", err.message);
        res.status(500).json({ error: 'Failed to process sync' });
    }
});


app.get('/api/tasks/claimed', validateTelegramAuth, async (req, res) => {
    try {
        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) return res.status(404).json({ error: 'User not found' });

        const { data, error } = await supabase
            .from('user_claimed_tasks')
            .select('task_id')
            .eq('user_id', dbUser.id);

        if (error) throw error;

        res.json(data); 

    } catch (err) {
        console.error("Error fetching claimed tasks:", err.message);
        res.status(500).json({ error: 'Failed to fetch claimed tasks' });
    }
});


app.post('/api/tasks/:taskId/claim', validateTelegramAuth, async (req, res) => {
    try {
        const { taskId } = req.params;
        const dbUser = await getDBUser(req.user.id);
        if (!dbUser) return res.status(404).json({ error: 'User not found' });

        const { error } = await supabase.rpc('claim_task_reward', {
            p_user_id: dbUser.id,
            p_task_id: parseInt(taskId)
        });

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        const updatedUser = await getDBUser(req.user.id);
        res.json(updatedUser);

    } catch (err) {
        console.error("Error in /tasks/claim:", err.message);
        res.status(500).json({ error: 'Failed to claim reward' });
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


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});