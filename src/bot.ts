import { Bot, Context, InlineKeyboard, Keyboard, InlineQueryResultBuilder, GrammyError, HttpError } from 'grammy';
import { GoogleGenAI, Type, type FunctionDeclaration } from '@google/genai';
import dotenv from 'dotenv';
import axios from 'axios';
import process from 'node:process';
import { compareAllPrices, type ProductResult } from './services/priceService.js';
import { toAffiliateUrl } from './utils/affiliate.js';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

if (!TELEGRAM_BOT_TOKEN) {
  console.warn(
    '[Telegram Bot] Warning: TELEGRAM_BOT_TOKEN is not set in environment variables. Bot will fail to start.'
  );
}

if (!GEMINI_API_KEY) {
  console.warn(
    '[Telegram Bot] Warning: GEMINI_API_KEY is not set in environment variables. AI responses will fail.'
  );
}

export const bot = new Bot(TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

/* ==========================================================================
   Gemini Tool Declarations & System Instructions (Digikala & Torob)
   ========================================================================== */

const comparePricesTool: { functionDeclarations: FunctionDeclaration[] } = {
  functionDeclarations: [
    {
      name: 'compare_prices',
      description:
        'Searches and compares real-time prices for products in Iran exclusively across Digikala and Torob.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description:
              'The normalized product search term extracted from user input or voice note (e.g. "iPhone 13 128GB", "AirPods Pro 2", "MacBook Air M3", "سامسونگ S24", "اتو بخار تفال").',
          },
        },
        required: ['query'],
      },
    },
  ],
};

const SYSTEM_INSTRUCTION = `
You are a fast Persian shopping assistant (موتور هوشمند مقایسه و شکار کمترین قیمت). Compare prices exclusively between Digikala and Torob.

Rules:
1. Always call \`compare_prices\` for product queries.
2. When tool results return, present the COMPLETE 2-STORE STATUS MATRIX:
   - If available products exist (at least one store has isAvailable: true):
     🏆 <b>ارزان‌ترین پیشنهاد:</b> [فروشگاه برنده] - [قیمت به تومان]
     
     📊 <b>وضعیت قیمت‌ها:</b>
     • <b>دیجی‌کالا (Digikala):</b> [قیمت یا ❌ ناموجود / یافت نشد]
     • <b>ترب (Torob):</b> [قیمت یا ❌ ناموجود / یافت نشد]
     
     (If both stores are available and have different prices, mention the savings / difference).
   - If BOTH stores are unavailable (isAvailable: false):
     Clearly state that the requested product/model is currently NOT available in Digikala and Torob. NEVER hallucinate or present different models/accessories as the requested item.
3. Format:
   - ONLY use <b>, <i>, <code>, <a> tags for Telegram.
   - NEVER use <ul>, <ol>, <li>, <br>, <div>, or <p>. Use standard newlines (\\n) and emoji bullets (•, 🛍️, 📦, 🏆, 📊) for lists.
   - Keep the tone fast, concise, and helpful.
`.trim();

/**
 * Result structure returned by the agent pipeline.
 */
export interface AgentResponse {
  htmlText: string;
  products?: ProductResult[];
  searchQuery?: string;
}

/**
 * Execute Gemini Agent with Function Calling for a text message.
 */
export async function runShoppingAgent(userMessage: string): Promise<AgentResponse> {
  const trimmed = userMessage.trim();

  try {
    // 1. Ask Gemini to identify product name and intent
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ text: trimmed }],
        },
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [comparePricesTool],
        temperature: 0.1,
      },
    });

    const candidates = response.candidates;
    const firstPart = candidates?.[0]?.content?.parts?.[0];
    const functionCall = firstPart?.functionCall;

    // If Gemini identified product query or requested compare_prices
    if (functionCall && functionCall.name === 'compare_prices') {
      const args = functionCall.args as { query?: string };
      const extractedQuery = (args?.query || trimmed).trim();

      const priceResults = await compareAllPrices(extractedQuery);
      const htmlText = formatComparisonFallback(extractedQuery, priceResults);

      return {
        htmlText: cleanHtmlOutput(htmlText),
        products: priceResults,
        searchQuery: extractedQuery,
      };
    }

    // Direct conversational reply if query was just a greeting or question
    if (response.text && response.text.trim()) {
      return {
        htmlText: cleanHtmlOutput(response.text),
      };
    }

    // Fallback: execute direct search
    const fallbackResults = await compareAllPrices(trimmed);
    return {
      htmlText: formatComparisonFallback(trimmed, fallbackResults),
      products: fallbackResults,
      searchQuery: trimmed,
    };
  } catch (error: any) {
    console.warn('[Telegram Bot] Gemini intent recognition skipped/failed, executing direct ground-truth comparison:', error?.message || error);
    try {
      const fallbackResults = await compareAllPrices(trimmed);
      return {
        htmlText: formatComparisonFallback(trimmed, fallbackResults),
        products: fallbackResults,
        searchQuery: trimmed,
      };
    } catch {
      return {
        htmlText: '⚠️ متأسفانه در حال حاضر امکان استعلام قیمت وجود ندارد. لطفاً دقایقی دیگر تلاش کنید.',
      };
    }
  }
}

/**
 * Execute Gemini Agent with Multimodal Voice/Audio input.
 */
export async function runShoppingAgentWithAudio(
  base64AudioData: string,
  mimeType = 'audio/ogg'
): Promise<AgentResponse> {
  try {
    const audioPrompt =
      'Please listen to this voice message in Persian, understand what product the user wants to buy or compare prices for, and extract the clean product name to call `compare_prices`.';

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: base64AudioData,
                mimeType,
              },
            },
            {
              text: audioPrompt,
            },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [comparePricesTool],
        temperature: 0.1,
      },
    });

    const candidates = response.candidates;
    const firstPart = candidates?.[0]?.content?.parts?.[0];
    const functionCall = firstPart?.functionCall;

    if (functionCall && functionCall.name === 'compare_prices') {
      const args = functionCall.args as { query?: string };
      const extractedQuery = (args?.query || 'کالای درخواستی').trim();

      const priceResults = await compareAllPrices(extractedQuery);
      const htmlText = formatComparisonFallback(extractedQuery, priceResults);

      return {
        htmlText: cleanHtmlOutput(htmlText),
        products: priceResults,
        searchQuery: extractedQuery,
      };
    }

    const directText =
      response.text ||
      '🎙️ پیام صوتی شما دریافت شد اما نام محصول مشخصی در آن تشخیص داده نشد. لطفاً نام کالا را به صورت متنی یا واضح‌تر ارسال کنید.';
    return {
      htmlText: cleanHtmlOutput(directText),
    };
  } catch (error: any) {
    console.error('Audio agent execution error:', error?.message || error);
    return {
      htmlText: '⚠️ متأسفانه در پردازش پیام صوتی شما خطایی رخ داد. لطفاً نام محصول را به صورت متنی ارسال کنید.',
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
 * Generates structured Persian HTML comparison summary with strict lowest price highlight for Digikala & Torob.
 */
export function formatComparisonFallback(query: string, results: ProductResult[]): string {
  const availableItems = results.filter((r) => r.isAvailable && r.price > 0);
  const digikalaItem = results.find((r) => r.source === 'Digikala');
  const torobItem = results.find((r) => r.source === 'Torob');

  if (availableItems.length === 0) {
    return (
      `🔍 <b>استعلام قیمت برای:</b> <code>${escapeHtml(query)}</code>\n\n` +
      `❌ متأسفانه محصول مورد نظر شما در حال حاضر در دیجی‌کالا و ترب موجود نیست یا یافت نشد.\n\n` +
      `💡 <i>پیشنهاد: مدل مشخص‌تر یا نام دقیق کالا را ارسال کنید.</i>`
    );
  }

  const cheapest = availableItems[0];

  let html = `🛍️ <b>استعلام و مقایسه قیمت: ${escapeHtml(query)}</b>\n\n`;
  html += `🏆 <b>ارزان‌ترین پیشنهاد:</b> <b>${cheapest.source}</b> با قیمت <b>${cheapest.formattedPrice}</b>\n\n`;

  html += `📊 <b>وضعیت قیمت‌ها:</b>\n`;
  html += `• <b>دیجی‌کالا (Digikala):</b> ${digikalaItem?.isAvailable ? `<b>${digikalaItem.formattedPrice}</b>` : '❌ ناموجود / یافت نشد'}\n`;
  html += `• <b>ترب (Torob):</b> ${torobItem?.isAvailable ? `<b>${torobItem.formattedPrice}</b>` : '❌ ناموجود / یافت نشد'}\n`;

  if (availableItems.length > 1) {
    const highest = availableItems[availableItems.length - 1];
    const diff = highest.price - cheapest.price;
    if (diff > 0) {
      html += `\n💰 <b>میزان سود خرید از ارزان‌ترین:</b> ${diff.toLocaleString('fa-IR')} تومان ارزان‌تر از ${highest.source}\n`;
    }
  }

  return html.trim();
}

/**
 * Sanitizes model output by converting unsupported HTML/markdown into safe Telegram HTML.
 */
export function cleanHtmlOutput(rawText: string): string {
  if (!rawText) return '';

  let cleaned = rawText;

  // 1. Convert block & list elements to standard text formatting
  cleaned = cleaned.replace(/<br\s*[\/]?>/gi, '\n');
  cleaned = cleaned.replace(/<\/?(ul|ol)>/gi, '');
  cleaned = cleaned.replace(/<li[^>]*>/gi, '• ');
  cleaned = cleaned.replace(/<\/li>/gi, '\n');
  cleaned = cleaned.replace(/<\/?(p|div)>/gi, '\n');
  cleaned = cleaned.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '<b>$1</b>\n');

  // 2. Normalize markdown elements to Telegram HTML
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  cleaned = cleaned.replace(/\*(.*?)\*/g, '<i>$1</i>');
  cleaned = cleaned.replace(/`([^`]+)`/g, '<code>$1</code>');
  cleaned = cleaned.replace(/^#+\s*(.*?)$/gm, '<b>$1</b>');

  // 3. Strip any unsupported HTML tags while preserving Telegram-compatible tags:
  // Allowed: b, strong, i, em, u, ins, s, strike, del, a (with href), code, pre, blockquote
  cleaned = cleaned.replace(
    /<(?!\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|a(?:\s+href="[^"]*")?)\b)[^>]*>/gi,
    ''
  );

  // 4. Normalize multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

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
  const encoded = encodeURIComponent(searchQuery);

  const availableItems = products.filter((p) => p.isAvailable && p.price > 0);
  const digikalaItem = products.find((p) => p.source === 'Digikala');
  const torobItem = products.find((p) => p.source === 'Torob');

  if (availableItems.length === 0) {
    // Fallback search buttons if no products available
    keyboard
      .url('🔍 جستجو در ترب', toAffiliateUrl(`https://torob.com/search/?query=${encoded}`, 'Torob'))
      .url(
        '📦 جستجو در دیجی‌کالا',
        toAffiliateUrl(`https://www.digikala.com/search/?q=${encoded}`, 'Digikala')
      );
    return keyboard;
  }

  const cheapest = availableItems[0];
  const cheapestAffiliateUrl = toAffiliateUrl(cheapest.url, cheapest.source);

  // Button 1 (Row 1): Cheapest Store primary action button
  keyboard.url(`🛒 خرید از ${cheapest.source} (بهترین قیمت)`, cheapestAffiliateUrl).row();

  // Button 2 & 3 (Row 2): Direct/Search links for Digikala and Torob
  const digikalaUrl = digikalaItem?.url || `https://www.digikala.com/search/?q=${encoded}`;
  const torobUrl = torobItem?.url || `https://torob.com/search/?query=${encoded}`;

  keyboard
    .url(
      digikalaItem?.isAvailable ? '📦 دیجی‌کالا' : '📦 جستجو در دیجی‌کالا',
      toAffiliateUrl(digikalaUrl, 'Digikala')
    )
    .url(
      torobItem?.isAvailable ? '🔍 ترب' : '🔍 جستجو در ترب',
      toAffiliateUrl(torobUrl, 'Torob')
    );

  return keyboard;
}

/**
 * Sends response to user as photo message if product image is available,
 * or gracefully falls back to standard HTML text, and finally plain text on entity parsing errors.
 */
async function sendShoppingResponse(ctx: Context, result: AgentResponse): Promise<void> {
  const replyMarkup =
    result.products && result.products.length > 0 && result.searchQuery
      ? buildProductInlineKeyboard(result.products, result.searchQuery)
      : undefined;

  const cheapest = result.products && result.products.length > 0 ? result.products[0] : null;
  const plainText = result.htmlText.replace(/<[^>]*>/g, '').trim();

  // 1. Try sending as photo if valid image URL exists
  if (cheapest && cheapest.imageUrl && cheapest.imageUrl.startsWith('http')) {
    try {
      await ctx.replyWithPhoto(cheapest.imageUrl, {
        caption: result.htmlText,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
      return;
    } catch (photoError) {
      console.warn(
        '[Telegram Bot] Could not send photo with HTML caption, attempting HTML text fallback:',
        photoError
      );
    }
  }

  // 2. Attempt sending as HTML text
  try {
    await ctx.reply(result.htmlText, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  } catch (htmlError) {
    console.warn('[Telegram Bot] HTML parse error, falling back to pure plain text:', htmlError);
    // 3. Bulletproof fallback: Strip all HTML tags and send as pure plain text
    try {
      await ctx.reply(plainText, {
        reply_markup: replyMarkup,
      });
    } catch (plainError) {
      console.error('[Telegram Bot] Critical failure sending message:', plainError);
    }
  }
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

/**
 * Registers the official Telegram bot menu commands.
 */
export async function initBotCommands(): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: '🚀 شروع به کار و منوی اصلی' },
      { command: 'help', description: '📖 راهنمای استعلام و مقایسه قیمت' },
    ]);
    console.log('✅ Bot menu commands registered successfully.');
  } catch (err) {
    console.warn('[Telegram Bot] Failed to set bot commands:', err);
  }
}

// /start Command Handler
bot.command('start', async (ctx: Context) => {
  const welcomeMessage = `
👋 <b>سلام! به ربات هوشمند مقایسه قیمت (مفت‌بر) خوش آمدید.</b>

من دستیار هوشمند شما برای پیدا کردن بهترین و ارزان‌ترین قیمت‌ها در <b>دیجی‌کالا</b> و <b>ترب</b> هستم.

🔍 <b>روش‌های استفاده:</b>
1️⃣ <b>ارسال متن:</b> نام کالا را تایپ کنید (مثلاً: <code>آیفون 13</code> یا <code>سامسونگ S24</code>).
2️⃣ <b>ارسال وویس:</b> نام کالا را با ویس بگویید، هوش مصنوعی سریعاً آن را تشخیص داده و قیمت‌ها را استخراج می‌کند.
3️⃣ <b>حالت اینلاین (Inline):</b> در هر چت یا گروهی کافیست بنویسید <code>@${ctx.me?.username || 'botname'} [نام کالا]</code>.

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
📖 <b>راهنمای ربات مقایسه قیمت مفت‌بر</b>

1️⃣ <b>استعلام متنی:</b> نام هر محصول را تایپ و ارسال کنید.
2️⃣ <b>استعلام صوتی (Voice):</b> یک پیام صوتی حاوی نام کالا بفرستید.
3️⃣ <b>استعلام اینلاین:</b> با تایپ <code>@${ctx.me?.username || 'botname'} [اسم کالا]</code> در هر چتی قیمت‌ها را ببینید.
4️⃣ <b>فروشگاه‌های تحت پوشش:</b>
   • دیجی‌کالا (Digikala)
   • ترب (Torob)

💡 <i>نکته: قیمت‌ها در حافظه کش ۱۵ دقیقه‌ای ذخیره می‌شوند تا پاسخ‌ها فوری و زیر ثانیه ارسال شوند.</i>
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
      '📖 برای شروع، نام محصولی که می‌خواهید قیمت آن را مقایسه کنید ارسال کنید (مثلاً: <code>سامسونگ S24 Ultra</code> یا <code>مک‌بوک پرو M4</code> یا یک وویس بفرستید).',
      { parse_mode: 'HTML' }
    );
  }

  // Send typing chat action
  await ctx.replyWithChatAction('typing');

  // Immediately send temporary loading message
  let loadingMsg: any = null;
  try {
    loadingMsg = await ctx.reply(
      '🔍 <b>در حال جستجو و مقایسه قیمت‌ها از دیجی‌کالا و ترب...</b> ⏳',
      { parse_mode: 'HTML' }
    );
  } catch {
    // Proceed even if sending loading message failed
  }

  try {
    const result = await runShoppingAgent(text);

    // Delete loading message before sending final response
    if (loadingMsg && ctx.chat?.id) {
      await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    }

    await sendShoppingResponse(ctx, result);
  } catch (error: any) {
    console.error('Error handling user text message:', error?.message || error);

    if (loadingMsg && ctx.chat?.id) {
      await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    }

    await ctx.reply('⚠️ مشکلی در پردازش پیام شما به وجود آمد. لطفاً مجدداً امتحان کنید.', {
      parse_mode: 'HTML',
    });
  }
});

// Voice Message Handler (Multimodal Gemini Speech Recognition)
bot.on('message:voice', async (ctx: Context) => {
  const voice = ctx.message?.voice;
  if (!voice) return;

  await ctx.replyWithChatAction('typing');

  // Immediately send temporary loading message
  let loadingMsg: any = null;
  try {
    loadingMsg = await ctx.reply(
      '🎙️ <b>در حال پردازش پیام صوتی و استعلام قیمت از دیجی‌کالا و ترب...</b> ⏳',
      { parse_mode: 'HTML' }
    );
  } catch {
    // Proceed even if sending loading message failed
  }

  try {
    const file = await ctx.getFile();

    if (!file.file_path) {
      if (loadingMsg && ctx.chat?.id) {
        await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
      }
      return ctx.reply('⚠️ دریافت فایل صوتی با مشکل مواجه شد. لطفاً متن محصول را ارسال کنید.', {
        parse_mode: 'HTML',
      });
    }

    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await axios.get<ArrayBuffer>(fileUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const base64Audio = Buffer.from(response.data).toString('base64');
    const mimeType = voice.mime_type || 'audio/ogg';

    const result = await runShoppingAgentWithAudio(base64Audio, mimeType);

    if (loadingMsg && ctx.chat?.id) {
      await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    }

    await sendShoppingResponse(ctx, result);
  } catch (error: any) {
    console.error('Error handling voice message:', error?.message || error);

    if (loadingMsg && ctx.chat?.id) {
      await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    }

    await ctx.reply(
      '⚠️ در پردازش پیام صوتی شما خطایی رخ داد. لطفاً نام محصول را به صورت متنی ارسال کنید.',
      { parse_mode: 'HTML' }
    );
  }
});

// Inline Query Handler (@botname [query])
bot.on('inline_query', async (ctx: Context) => {
  const query = ctx.inlineQuery?.query?.trim() || '';

  if (!query) {
    const helpArticle = InlineQueryResultBuilder.article(
      'inline_help',
      '🔍 جستجوی هوشمند قیمت کالا',
      {
        description: 'نام محصول را تایپ کنید (مثلاً: iPhone 15 یا ایرپاد پرو)',
        thumbnail_url: 'https://cdn-icons-png.flaticon.com/512/3144/3144456.png',
      }
    ).text(
      '👋 <b>برای استعلام قیمت در تلگرام:</b>\nنام محصول مورد نظرتان را پس از آیدی ربات بنویسید (مثلاً: <code>@botname MacBook Air M3</code>).',
      { parse_mode: 'HTML' }
    );

    return await ctx.answerInlineQuery([helpArticle], { cache_time: 300 });
  }

  try {
    const products = await compareAllPrices(query);
    const availableItems = products.filter((p) => p.isAvailable && p.price > 0);

    if (availableItems.length === 0) {
      const notFoundArticle = InlineQueryResultBuilder.article(
        'not_found',
        `❌ محصول "${query}" یافت نشد`,
        {
          description: 'هیچ کالای فعالی در دیجی‌کالا و ترب پیدا نشد.',
          reply_markup: buildProductInlineKeyboard(products, query),
        }
      ).text(
        `❌ متأسفانه محصول <b>${escapeHtml(query)}</b> در حال حاضر در دیجی‌کالا و ترب موجود نیست یا یافت نشد.`,
        { parse_mode: 'HTML' }
      );

      return await ctx.answerInlineQuery([notFoundArticle], { cache_time: 60 });
    }

    const cheapest = availableItems[0];
    const inlineResults = [];

    // 1. Comparison Summary Article
    const summaryHtml = formatComparisonFallback(query, products);

    const summaryArticle = InlineQueryResultBuilder.article(
      `summary_${query}`,
      `🏆 ارزان‌ترین: ${cheapest.formattedPrice} (${cheapest.source})`,
      {
        description: cheapest.title,
        thumbnail_url: cheapest.imageUrl,
        reply_markup: buildProductInlineKeyboard(products, query),
      }
    ).text(summaryHtml, { parse_mode: 'HTML' });

    inlineResults.push(summaryArticle);

    // 2. Individual Store Offers
    products.forEach((product, idx) => {
      const affiliateUrl = toAffiliateUrl(product.url, product.source);
      const isAvail = product.isAvailable && product.price > 0;
      const titlePrefix = isAvail ? product.source : `${product.source} (ناموجود)`;
      const priceText = isAvail ? product.formattedPrice : '❌ ناموجود / یافت نشد';

      const storeArticle = InlineQueryResultBuilder.article(
        `store_${product.source}_${idx}`,
        `${titlePrefix}: ${priceText}`,
        {
          description: product.title,
          thumbnail_url: product.imageUrl,
          reply_markup: new InlineKeyboard().url(
            isAvail ? `🛒 خرید از ${product.source}` : `🔍 جستجو در ${product.source}`,
            affiliateUrl
          ),
        }
      ).text(
        `🛍️ <b>${escapeHtml(product.title)}</b>\n\n` +
          `💰 <b>وضعیت در ${product.source}:</b> ${priceText}\n` +
          `🔗 <a href="${affiliateUrl}">${isAvail ? 'مشاهده و خرید آنلاین' : 'جستجوی محصول در فروشگاه'}</a>`,
        { parse_mode: 'HTML' }
      );

      inlineResults.push(storeArticle);
    });

    await ctx.answerInlineQuery(inlineResults, { cache_time: 300 });
  } catch (err) {
    console.error('Error answering inline query:', err);
    await ctx.answerInlineQuery([], { cache_time: 10 });
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
