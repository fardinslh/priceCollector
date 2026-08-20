import { bot, registerBotCommands } from './bot.js';
import process from 'node:process';
import { alertService } from './services/alertService.js';
import { publishTopDealToChannel } from './services/dealsPublisher.js';

/**
 * Main application entry point to start the Telegram Shopping Assistant Bot.
 */
async function bootstrap() {
  console.log('---------------------------------------------------------');
  console.log('🤖 Iranian Shopping Assistant Telegram Bot is starting...');
  console.log('⚡ Powered by Gemini AI, GrammY, Digikala, Torob & Zoomit');
  console.log('---------------------------------------------------------');

  // Register official Telegram Bot menu commands
  await registerBotCommands();

  // Start periodic price drop alert tracker (every 60 minutes)
  alertService.startBackgroundTracker(bot, 60);

  // Publish top deal to the configured channel every 6 hours (if channel is set)
  if (process.env.TELEGRAM_DEALS_CHANNEL_ID) {
    setInterval(() => {
      publishTopDealToChannel(bot).catch(() => {});
    }, 6 * 60 * 60 * 1000);
    console.log('📢 Deal publisher enabled (interval: 6 hours).');
  }

  // Handle graceful shutdown
  const stopBot = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}. Shutting down bot gracefully...`);
    try {
      await bot.stop();
      console.log('✅ Bot stopped successfully.');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => stopBot('SIGINT'));
  process.once('SIGTERM', () => stopBot('SIGTERM'));

  // Start polling
  await bot.start({
    onStart: (botInfo) => {
      console.log(`🚀 Bot @${botInfo.username} is now online and listening for messages!`);
    },
  });
}

bootstrap().catch((err) => {
  console.error('❌ Fatal error during bot startup:', err);
  process.exit(1);
});
