require('dotenv').config();
const { Telegraf } = require('telegraf');
const actions = require('./actions');
const votes = require('./votes');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Lobby commands
bot.command('newgame', (ctx) => actions.newGame(ctx));
bot.command('join', (ctx) => actions.join(ctx));
bot.command('start', (ctx) => {
  // /start in private chat is just a greeting
  if (ctx.chat.type === 'private') {
    return ctx.reply('🏴‍☠️ سلام! من ربات بازی جزیره‌ی گنج هستم.\nمن را به گروه اضافه کنید و با /newgame بازی جدید بسازید.');
  }
  return actions.startGame(ctx);
});

// Day phase commands
bot.command('jump', (ctx) => actions.moveLocation(ctx));
bot.command('attack', (ctx) => actions.attack(ctx));
bot.command('maroon', (ctx) => actions.maroon(ctx));
bot.command('mutiny', (ctx) => actions.mutiny(ctx));
bot.command('inspect', (ctx) => actions.inspect(ctx));
bot.command('replace', (ctx) => actions.moveTreasure(ctx));
bot.command('callarmada', (ctx) => actions.callArmada(ctx));
bot.command('dispute', (ctx) => actions.dispute(ctx));
bot.command('pass', (ctx) => actions.pass(ctx));
bot.command('status', (ctx) => actions.status(ctx));

// Callback queries (inline keyboard presses)
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith('newgame_')) return actions.handleNewgameModeCallback(ctx);
  if (data.startsWith('vote_')) return votes.handleVoteCallback(ctx);
  if (data.startsWith('setup_')) return votes.handleSetupCallback(ctx);
  if (data.startsWith('loot_')) return votes.handleLootCallback(ctx);
  if (data.startsWith('act_')) return actions.handleActionCallback(ctx);
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

// Export for Vercel webhook usage
module.exports = bot;

// Local polling mode: run directly with `node bot.js`
if (require.main === module) {
  bot.launch(() => {
    console.log('🏴‍☠️ Tortuga bot is running (polling)!');
    bot.telegram.sendMessage(process.env.ADMIN_USER_ID || 440613406, '🤖 ربات جزیره‌ی گنج راه‌اندازی شد!').catch(() => {
      console.warn('⚠️ نمی‌توانم پیام راه‌اندازی را به ادمین ارسال کنم. مطمئن شوید ADMIN_USER_ID را تنظیم کرده‌اید.');
    });
  });
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
