import { bot } from './bot.js';
import process from 'node:process';

/**
 * Main application entry point to start the Telegram Shopping Assistant Bot.
 */
async function bootstrap() {
  console.log('---------------------------------------------------------');
  console.log('🤖 Iranian Shopping Assistant Telegram Bot is starting...');
  console.log('⚡ Powered by Gemini AI, GrammY, Digikala, Torob & Technolife');
  console.log('---------------------------------------------------------');

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
