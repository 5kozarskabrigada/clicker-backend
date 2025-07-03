require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const supabase = require('./db');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });


const balanceCommand = require('./commands/balance');
const clickCommand = require('./commands/click');
const topCommand = require('./commands/top');
const transferCommand = require('./commands/transfer');


bot.onText(/\/balance/, balanceCommand(bot, supabase));
bot.onText(/\/click/, clickCommand(bot, supabase));
bot.onText(/\/top/, topCommand(bot, supabase));
bot.onText(/\/transfer/, transferCommand(bot, supabase));


bot.on('message', async (msg) => {
    if (msg.web_app_data) {
        const data = JSON.parse(msg.web_app_data.data);


        if (data.action === 'click') {
            await clickCommand.handleWebAppClick(bot, supabase, msg.from.id);
        }
    }
});

console.log('Bot is running...');