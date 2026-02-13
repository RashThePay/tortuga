// Run this once after deploying to Vercel to register the webhook URL:
//   node scripts/set-webhook.js https://your-project.vercel.app
//
// Or to remove the webhook (switch back to polling):
//   node scripts/set-webhook.js --delete

require('dotenv').config();
const token = process.env.BOT_TOKEN;
const arg = process.argv[2];

if (!token) {
  console.error('BOT_TOKEN not set in .env');
  process.exit(1);
}

async function main() {
  const baseUrl = `https://api.telegram.org/bot${token}`;

  if (arg === '--delete') {
    const res = await fetch(`${baseUrl}/deleteWebhook`);
    const data = await res.json();
    console.log('deleteWebhook:', data);
    return;
  }

  if (!arg) {
    console.error('Usage: node scripts/set-webhook.js <vercel-url>');
    console.error('  e.g. node scripts/set-webhook.js https://tortuga.vercel.app');
    process.exit(1);
  }

  const webhookUrl = `${arg}/api/webhook`;
  const res = await fetch(`${baseUrl}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
  const data = await res.json();
  console.log('setWebhook:', data);
  console.log('Webhook URL:', webhookUrl);
}

main().catch(console.error);
