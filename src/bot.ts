import {
  Bot,
  InlineKeyboard,
  Keyboard,
  InlineQueryResultBuilder,
  GrammyError,
  HttpError,
  type Context,
} from 'grammy';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import axios from 'axios';
import process from 'node:process';
import { compareAllPrices, type ProductResult } from './services/priceService.js';
import { toAffiliateUrl } from './utils/affiliate.js';

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
              'The normalized product search term extracted from user input or voice note (e.g. "iPhone 13 128GB", "AirPods Pro 2", "MacBook Air M3").',
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
1. When the user asks about any product, gadget, phone, laptop, or item (via text or voice note, with typos, slang, or English names), extract the normalized product query and call the function \`compare_prices\`.
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
export interface AgentResponse {
  htmlText: string;
  products?: ProductResult[];
  searchQuery?: string;
}

/**
 * Execute Gemini Agent with Function Calling for a text message.
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

      // Execute cached/live price comparison across Iranian platforms
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
        `✅ قیمت‌های استعلام شده برای <b>${escapeHtml(extractedQuery)}</b>:`;

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
 * Execute Gemini Agent with Multimodal Audio (Voice Message) Input.
 */
export async function runShoppingAgentWithAudio(
  base64Audio: string,
  mimeType: string = 'audio/ogg'
): Promise<AgentResponse> {
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: base64Audio,
                mimeType,
              },
            },
            {
              text: 'لطفاً به این پیام صوتی گوش بده، اگر کاربر نام محصولی را برای استعلام یا مقایسه قیمت اعلام کرده است، نام دقیق آن را استخراج کن و تابع compare_prices را فراخوانی کن.',
            },
          ],
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

    if (functionCall && functionCall.name === 'compare_prices') {
      const args = functionCall.args as { query?: string };
      const extractedQuery = (args?.query || '').trim();

      if (extractedQuery) {
        const priceResults = await compareAllPrices(extractedQuery);

        const secondResponse = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    data: base64Audio,
                    mimeType,
                  },
                },
              ],
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
          `🎙️ <b>محصول شناسایی شده از صدای شما:</b> ${escapeHtml(extractedQuery)}\n\n` +
          `✅ نتایج مقایسه قیمت دریافت شد.`;

        return {
          htmlText: cleanHtmlOutput(responseText),
          products: priceResults,
          searchQuery: extractedQuery,
        };
      }
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
    const torobSearchUrl = toAffiliateUrl(`https://torob.com/search/?query=${encoded}`, 'Torob');
    const digikalaSearchUrl = toAffiliateUrl(
      `https://www.digikala.com/search/?q=${encoded}`,
      'Digikala'
    );

    keyboard
      .url('🔍 جستجو در ترب', torobSearchUrl)
      .row()
      .url('📦 جستجو در دیجی‌کالا', digikalaSearchUrl);
    return keyboard;
  }

  const cheapest = products[0];
  const cheapestAffiliateUrl = toAffiliateUrl(cheapest.url, cheapest.source);

  // 1. Cheapest Store primary action button
  keyboard.url(`🛒 خرید از ${cheapest.source} (بهترین قیمت)`, cheapestAffiliateUrl).row();

  // 2. Additional store links
  const torobItem = products.find((p) => p.source === 'Torob');
  const digikalaItem = products.find((p) => p.source === 'Digikala');
  const technolifeItem = products.find((p) => p.source === 'Technolife');

  const secondRowButtons: { text: string; url: string }[] = [];

  if (torobItem && torobItem.url !== cheapest.url) {
    secondRowButtons.push({
      text: '🔍 مشاهده در ترب',
      url: toAffiliateUrl(torobItem.url, 'Torob'),
    });
  } else if (!torobItem) {
    secondRowButtons.push({
      text: '🔍 جستجو در ترب',
      url: toAffiliateUrl(
        `https://torob.com/search/?query=${encodeURIComponent(searchQuery)}`,
        'Torob'
      ),
    });
  }

  if (digikalaItem && digikalaItem.url !== cheapest.url) {
    secondRowButtons.push({
      text: '📦 مشاهده در دیجی‌کالا',
      url: toAffiliateUrl(digikalaItem.url, 'Digikala'),
    });
  } else if (!digikalaItem) {
    secondRowButtons.push({
      text: '📦 جستجو در دیجی‌کالا',
      url: toAffiliateUrl(
        `https://www.digikala.com/search/?q=${encodeURIComponent(searchQuery)}`,
        'Digikala'
      ),
    });
  }

  if (technolifeItem && technolifeItem.url !== cheapest.url) {
    secondRowButtons.push({
      text: '⚡ مشاهده در تکنولایف',
      url: toAffiliateUrl(technolifeItem.url, 'Technolife'),
    });
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
 * Sends response to user as photo message if product image is available,
 * or gracefully falls back to standard text message.
 */
async function sendShoppingResponse(ctx: Context, result: AgentResponse): Promise<void> {
  const replyMarkup =
    result.products && result.products.length > 0 && result.searchQuery
      ? buildProductInlineKeyboard(result.products, result.searchQuery)
      : undefined;

  const cheapest = result.products && result.products.length > 0 ? result.products[0] : null;

  if (cheapest && cheapest.imageUrl && cheapest.imageUrl.startsWith('http')) {
    try {
      await ctx.replyWithPhoto(cheapest.imageUrl, {
        caption: result.htmlText,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
      return;
    } catch (photoError) {
      console.warn('Could not send as photo, falling back to text reply:', photoError);
    }
  }

  // Standard text message
  await ctx.reply(result.htmlText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });
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
👋 <b>سلام! به ربات هوشمند مقایسه قیمت (مفت‌بر) خوش آمدید.</b>

من دستیار هوشمند شما برای پیدا کردن بهترین و ارزان‌ترین قیمت‌ها در فروشگاه‌های معتبر ایران (<b>دیجی‌کالا</b>، <b>ترب</b> و <b>تکنولایف</b>) هستم.

🔍 <b>روش‌های استفاده:</b>
1️⃣ <b>ارسال متن:</b> نام کالا را تایپ کنید (مثلاً: <code>آیفون 13</code> یا <code>AirPods Pro 2</code>).
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
   • تکنولایف (Technolife)

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
      '📖 برای شروع، نام محصولی که می‌خواهید قیمت آن را مقایسه کنید ارسال کنید (مثلاً: <code>سامسونگ S24 Ultra</code> یا یک وویس بفرستید).',
      { parse_mode: 'HTML' }
    );
  }

  // Send typing chat action
  await ctx.replyWithChatAction('typing');

  try {
    const result = await runShoppingAgent(text);
    await sendShoppingResponse(ctx, result);
  } catch (error: any) {
    console.error('Error handling user text message:', error?.message || error);
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

  try {
    const file = await ctx.getFile();

    if (!file.file_path) {
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
    await sendShoppingResponse(ctx, result);
  } catch (error: any) {
    console.error('Error handling voice message:', error?.message || error);
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

    if (!products || products.length === 0) {
      const notFoundArticle = InlineQueryResultBuilder.article(
        'not_found',
        `❌ محصول "${query}" یافت نشد`,
        {
          description: 'هیچ کالای فعالی در دیجی‌کالا، ترب و تکنولایف پیدا نشد.',
          reply_markup: new InlineKeyboard()
            .url(
              '🔍 جستجو در ترب',
              toAffiliateUrl(
                `https://torob.com/search/?query=${encodeURIComponent(query)}`,
                'Torob'
              )
            )
            .url(
              '📦 جستجو در دیجی‌کالا',
              toAffiliateUrl(
                `https://www.digikala.com/search/?q=${encodeURIComponent(query)}`,
                'Digikala'
              )
            ),
        }
      ).text(
        `❌ متأسفانه کالای فعالی برای عبارت <b>${escapeHtml(query)}</b> در فروشگاه‌های ایران یافت نشد.`,
        { parse_mode: 'HTML' }
      );

      return await ctx.answerInlineQuery([notFoundArticle], { cache_time: 60 });
    }

    const cheapest = products[0];
    const inlineResults = [];

    // 1. Comparison Summary Article
    let summaryHtml = `🛍️ <b>مقایسه قیمت: ${escapeHtml(query)}</b>\n\n`;
    summaryHtml += `🏆 <b>بهترین قیمت:</b> ${cheapest.formattedPrice} (از <b>${cheapest.source}</b>)\n\n`;
    summaryHtml += `📊 <b>فروشگاه‌های تحت پوشش:</b>\n`;

    products.forEach((p, idx) => {
      const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
      summaryHtml += `${medal} <b>${p.source}:</b> ${p.formattedPrice}\n`;
    });

    const summaryArticle = InlineQueryResultBuilder.article(
      `summary_${query}`,
      `🏆 بهترین قیمت: ${cheapest.formattedPrice} (${cheapest.source})`,
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
      const storeArticle = InlineQueryResultBuilder.article(
        `store_${product.source}_${idx}`,
        `${product.source}: ${product.formattedPrice}`,
        {
          description: product.title,
          thumbnail_url: product.imageUrl,
          reply_markup: new InlineKeyboard().url(`🛒 خرید از ${product.source}`, affiliateUrl),
        }
      ).text(
        `🛍️ <b>${escapeHtml(product.title)}</b>\n\n` +
          `💰 <b>قیمت در ${product.source}:</b> ${product.formattedPrice}\n` +
          `🔗 <a href="${affiliateUrl}">مشاهده و خرید آنلاین در ${product.source}</a>`,
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
