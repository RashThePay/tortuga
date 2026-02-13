const bot = require('../bot');

// Vercel serverless function handler
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(200).json({ ok: true }); // Always 200 to avoid Telegram retries
    }
  } else {
    res.status(200).send('Tortuga bot is running.');
  }
};
