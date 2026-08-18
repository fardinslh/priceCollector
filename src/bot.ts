import { Bot, InlineKeyboard, Keyboard, GrammyError, HttpError, type Context } from 'grammy';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import process from 'node:process';
import { compareAllPrices, type ProductResult } from './services/priceService.js';

// Load environment variables
dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Validate environment variables at boot time
if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.trim() === '') {
  console.error('❌ Boot Error: Missing required environment variable "TELEGRAM_BOT_TOKEN".');
  process.exit(1);
}

if (!GEMINI_API_KEY || GEMINI_API_KEY.trim() === '') {
  console.error('❌ Boot Error: Missing required environment variable "GEMINI_API_KEY".');
  process.exit(1);
}

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Initialize Telegram Bot
export const bot = new Bot(TELEGRAM_BOT_TOKEN);

/**
 * Gemini Function Calling Tool Declaration
 */
const comparePricesTool = {
  functionDeclarations: [
    {
      name: 'compare_prices',
      description:
        'Searches Digikala, Torob, and Technolife in Iran, compares real-time prices, and identifies the cheapest vendor with direct verified product links.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description:
              'The normalized product search term extracted from user input (e.g. "iPhone 13 128GB", "AirPods Pro 2", "MacBook Air M3").',
          },
        },
        required: ['query'],
      },
    },
  ],
};

const SYSTEM_INSTRUCTION = `
You are a smart, friendly, and expert Persian shopping assistant (دستیار هوشمند مقایسه قیمت).
Your job is to help users find the best deals across Iranian online stores (دیجی‌کالا، ترب، تکنولایف).

Instructions:
1. When the user asks about any product, gadget, phone, laptop, or item (even with typos, informal Persian slang, or English names), extract the normalized product query and call the function \`compare_prices\`.
2. NEVER hallucinate or invent prices, stores, or availability. Rely ONLY on the results returned by \`compare_prices\`.
3. Respond in polite, fluent, natural Persian using HTML formatting (<b>bold</b>, <i>italic</i>, <code>code</code>, <s>strike</s>).
4. Do NOT use Markdown or MarkdownV2 symbols (*, _, \`, #) in your final response—use strict HTML tags ONLY to ensure clean rendering on Telegram.
5. In your response:
   - Highlight the cheapest store and best price clearly.
   - List other store prices for quick comparison.
   - Keep the summary clear, helpful, and concise.
6. If no products are found in the tool output, politely explain that the product was not found or is currently out of stock in the checked stores, and suggest a refined search query.
`.trim();

/**
 * Result structure returned by the agent pipeline.
 */
interface AgentResponse {
  htmlText: string;
  products?: ProductResult[];
  searchQuery?: string;
}

/**
 * Execute Gemini Agent with Function Calling for a user message.
 */
export async function runShoppingAgent(userMessage: string): Promise<AgentResponse> {
  try {
    // 1. Initial call to Gemini with tools and system instruction
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ text: userMessage }],
        },
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [comparePricesTool],
        temperature: 0.2,
      },
    });

    const candidates = response.candidates;
    const firstPart = candidates?.[0]?.content?.parts?.[0];
    const functionCall = firstPart?.functionCall;

    // If Gemini requested the compare_prices tool
    if (functionCall && functionCall.name === 'compare_prices') {
      const args = functionCall.args as { query?: string };
      const extractedQuery = (args?.query || userMessage).trim();

      // Execute local price comparison across Iranian platforms
      const priceResults = await compareAllPrices(extractedQuery);

      // 2. Feed tool output back to Gemini for final Persian HTML synthesis
      const secondResponse = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [{ text: userMessage }],
          },
          {
            role: 'model',
            parts: [{ functionCall }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'compare_prices',
                  response: {
                    query: extractedQuery,
                    foundCount: priceResults.length,
                    results: priceResults,
                  },
                },
              },
            ],
          },
        ],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.3,
        },
      });

      const responseText =
        secondResponse.text ||
        '✅ نتایج استعلام قیمت دریافت شد. دکمه‌های زیر را برای مشاهده و خرید بررسی کنید:';

      return {
        htmlText: cleanHtmlOutput(responseText),
        products: priceResults,
        searchQuery: extractedQuery,
      };
    }

    // Direct conversational response without tool invocation
    const directText = response.text || 'متوجه درخواست شما نشدم، لطفاً نام کالا را ارسال کنید.';
    return {
      htmlText: cleanHtmlOutput(directText),
    };
  } catch (error: any) {
    console.error('Agent execution error:', error?.message || error);

    // Fallback: If Gemini API fails, attempt direct price comparison as backup
    try {
      const directResults = await compareAllPrices(userMessage);
      if (directResults.length > 0) {
        const cheapest = directResults[0];
        let fallbackHtml = `🛍️ <b>نتایج مقایسه قیمت برای "${escapeHtml(userMessage)}"</b>\n\n`;
        fallbackHtml += `🏆 <b>ارزان‌ترین فروشنده:</b> ${cheapest.source} با قیمت <b>${cheapest.formattedPrice}</b>\n\n`;
        fallbackHtml += `📊 <b>سایر فروشگاه‌ها:</b>\n`;
        directResults.forEach((item, index) => {
          fallbackHtml += `${index + 1}. <b>${item.source}:</b> ${item.formattedPrice}\n`;
        });

        return {
          htmlText: fallbackHtml,
          products: directResults,
          searchQuery: userMessage,
        };
      }
    } catch {
      // Ignore fallback failure
    }

    return {
      htmlText: '⚠️ متأسفانه در برقراری ارتباط خطایی رخ داد. لطفاً دوباره تلاش کنید.',
    };
  }
}

/**
 * Escapes unsafe HTML characters for Telegram HTML parse mode.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sanitizes model output by converting basic markdown artifacts into safe Telegram HTML.
 */
function cleanHtmlOutput(rawText: string): string {
  let cleaned = rawText
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^#+\s*(.*?)$/gm, '<b>$1</b>');

  return cleaned.trim();
}

/**
 * Builds interactive Telegram InlineKeyboard buttons for product search results.
 */
function buildProductInlineKeyboard(
  products: ProductResult[],
  searchQuery: string
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (products.length === 0) {
    // Fallback search buttons if no products directly scraped
    const encoded = encodeURIComponent(searchQuery);
    keyboard
      .url('🔍 جستجو در ترب', `https://torob.com/search/?query=${encoded}`)
      .row()
      .url('📦 جستجو در دیجی‌کالا', `https://www.digikala.com/search/?q=${encoded}`);
    return keyboard;
  }

  const cheapest = products[0];

  // 1. Cheapest Store primary action button
  keyboard
    .url(`🛒 خرید از ${cheapest.source} (بهترین قیمت)`, cheapest.url)
    .row();

  // 2. Additional store links
  const torobItem = products.find((p) => p.source === 'Torob');
  const digikalaItem = products.find((p) => p.source === 'Digikala');
  const technolifeItem = products.find((p) => p.source === 'Technolife');

  const secondRowButtons: { text: string; url: string }[] = [];

  if (torobItem && torobItem.url !== cheapest.url) {
    secondRowButtons.push({ text: '🔍 مشاهده در ترب', url: torobItem.url });
  } else if (!torobItem) {
    secondRowButtons.push({
      text: '🔍 جستجو در ترب',
      url: `https://torob.com/search/?query=${encodeURIComponent(searchQuery)}`,
    });
  }

  if (digikalaItem && digikalaItem.url !== cheapest.url) {
    secondRowButtons.push({ text: '📦 مشاهده در دیجی‌کالا', url: digikalaItem.url });
  } else if (!digikalaItem) {
    secondRowButtons.push({
      text: '📦 جستجو در دیجی‌کالا',
      url: `https://www.digikala.com/search/?q=${encodeURIComponent(searchQuery)}`,
    });
  }

  if (technolifeItem && technolifeItem.url !== cheapest.url) {
    secondRowButtons.push({ text: '⚡ مشاهده در تکنولایف', url: technolifeItem.url });
  }

  // Layout buttons cleanly
  secondRowButtons.forEach((btn, idx) => {
    keyboard.url(btn.text, btn.url);
    if (idx % 2 === 1 && idx < secondRowButtons.length - 1) {
      keyboard.row();
    }
  });

  return keyboard;
}

/**
 * Suggestion Keyboard for quick onboarding searches.
 */
const suggestionKeyboard = new Keyboard()
  .text('📱 آیفون 13')
  .text('💻 مک‌بوک ایر M3')
  .row()
  .text('🎧 ایرپاد پرو 2')
  .text('🎮 پلی‌استیشن 5')
  .row()
  .text('ℹ️ راهنما')
  .resized();

/* ==========================================================================
   Bot Commands and Handlers
   ========================================================================== */

// /start Command Handler
bot.command('start', async (ctx: Context) => {
  const welcomeMessage = `
👋 <b>سلام! به ربات هوشمند مقایسه قیمت خوش آمدید.</b>

من دستیار هوشمند شما برای پیدا کردن بهترین و ارزان‌ترین قیمت‌ها در فروشگاه‌های معتبر ایران (<b>دیجی‌کالا</b>، <b>ترب</b> و <b>تکنولایف</b>) هستم.

🔍 <b>روش استفاده:</b>
کافیست نام هر کالا یا مدل مد نظرتان را به فارسی یا انگلیسی برای من ارسال کنید (مثلاً <code>آیفون 13</code> یا <code>AirPods Pro 2</code>). من سریعاً کمترین قیمت بازار را همراه با لینک مستقیم خرید برای شما استخراج می‌کنم.

👇 همچنین می‌توانید از گزینه‌های پیشنهادی زیر استفاده کنید:
`.trim();

  await ctx.reply(welcomeMessage, {
    parse_mode: 'HTML',
    reply_markup: suggestionKeyboard,
  });
});

// /help Command Handler
bot.command('help', async (ctx: Context) => {
  const helpMessage = `
📖 <b>راهنمای ربات مقایسه قیمت</b>

1️⃣ <b>استعلام سریع:</b> نام هر محصول را تایپ و ارسال کنید.
2️⃣ <b>جستجوی هوشمند:</b> حتی با وجود غلط املایی یا اصطلاحات عامیانه، مدل دقیق استخراج و بررسی می‌شود.
3️⃣ <b>فروشگاه‌های تحت پوشش:</b>
   • دیجی‌کالا (Digikala)
   • ترب (Torob)
   • تکنولایف (Technolife)

💡 <i>نکته: قیمت‌ها به تومان محاسبه شده و ارزان‌ترین فروشنده همیشه با رتبه اول به شما پیشنهاد می‌شود.</i>
`.trim();

  await ctx.reply(helpMessage, {
    parse_mode: 'HTML',
  });
});

// Text Message Handler
bot.on('message:text', async (ctx: Context) => {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  // Handle help button from suggestion keyboard
  if (text === 'ℹ️ راهنما') {
    return ctx.reply(
      '📖 برای شروع، نام محصولی که می‌خواهید قیمت آن را مقایسه کنید ارسال کنید (مثلاً: <code>سامسونگ S24 Ultra</code>).',
      { parse_mode: 'HTML' }
    );
  }

  // Send typing chat action
  await ctx.replyWithChatAction('typing');

  try {
    const result = await runShoppingAgent(text);

    const replyOptions: {
      parse_mode: 'HTML';
      reply_markup?: InlineKeyboard;
    } = {
      parse_mode: 'HTML',
    };

    if (result.products && result.products.length > 0 && result.searchQuery) {
      replyOptions.reply_markup = buildProductInlineKeyboard(
        result.products,
        result.searchQuery
      );
    }

    await ctx.reply(result.htmlText, replyOptions);
  } catch (error: any) {
    console.error('Error handling user message:', error?.message || error);
    await ctx.reply(
      '⚠️ مشکلی در پردازش پیام شما به وجود آمد. لطفاً مجدداً امتحان کنید.',
      { parse_mode: 'HTML' }
    );
  }
});

/* ==========================================================================
   Global Error Handler
   ========================================================================== */
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[Telegram Bot] Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;

  if (e instanceof GrammyError) {
    console.error('[Telegram Bot] Grammy error in request:', e.description);
  } else if (e instanceof HttpError) {
    console.error('[Telegram Bot] Could not contact Telegram servers:', e);
  } else {
    console.error('[Telegram Bot] Unknown runtime error:', e);
  }
});
