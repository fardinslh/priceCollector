import { Bot, Context, InlineKeyboard, Keyboard, InlineQueryResultBuilder, GrammyError, HttpError } from 'grammy';
import { GoogleGenAI, Type, type FunctionDeclaration } from '@google/genai';
import dotenv from 'dotenv';
import axios from 'axios';
import process from 'node:process';
import { compareAllPrices, formatTomanPrice, type ProductResult } from './services/priceService.js';
import { toAffiliateUrl } from './utils/affiliate.js';
import { alertService } from './services/alertService.js';
import { generatePriceChartUrl } from './services/chartService.js';
import { isComparisonQuery, parseComparisonItems, compareTwoProducts } from './services/comparisonService.js';

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
   Gemini Tool Declarations & System Instructions
   ========================================================================== */

const comparePricesTool: { functionDeclarations: FunctionDeclaration[] } = {
  functionDeclarations: [
    {
      name: 'compare_prices',
      description:
        'Searches and compares real-time prices for products in Iran across Digikala, Torob, and Zoomit.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description:
              'The normalized product search term extracted from user input or voice note (e.g. "iPhone 16 Pro Max", "AirPods Pro 2", "MacBook Air M3", "سامسونگ S24", "JBL Charge 6").',
          },
        },
        required: ['query'],
      },
    },
  ],
};

const SYSTEM_INSTRUCTION = `
You are a fast Persian shopping assistant (موتور هوشمند مقایسه و استعلام کمترین قیمت). Compare prices across Digikala, Torob, and Zoomit.

Rules:
1. Always call \`compare_prices\` for product queries.
2. When tool results return, present the COMPLETE STATUS MATRIX:
   - If available products exist (at least one store has isAvailable: true):
     🏆 <b>ارزان‌ترین پیشنهاد:</b> [فروشگاه برنده] - [قیمت به تومان]
     
     📊 <b>وضعیت قیمت‌ها:</b>
     • <b>دیجی‌کالا (Digikala):</b> [قیمت یا ❌ ناموجود / یافت نشد]
     • <b>ترب (Torob):</b> [قیمت یا ❌ ناموجود / یافت نشد]
     • <b>زومیت (Zoomit):</b> [مشخصات و قیمت در زومیت]
     
     (If multiple stores are available, mention the savings / difference).
   - If all stores are unavailable:
     Clearly state that the requested product/model is currently NOT available.
3. Format:
   - ONLY use <b>, <i>, <code>, <a> tags for Telegram.
   - NEVER use <ul>, <ol>, <li>, <br>, <div>, or <p>. Use standard newlines (\\n) and emoji bullets (•, 🛍️, 📦, 🏆, 📊) for lists.
   - Keep the tone fast, concise, and helpful.
`.trim();

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
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ text: trimmed }],
        },
      ],
      config: {
        tools: [comparePricesTool],
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
      },
    });

    const candidate = response.candidates?.[0];
    const modelParts = candidate?.content?.parts || [];

    const toolCall = modelParts.find((part) => part.functionCall);

    if (toolCall && toolCall.functionCall) {
      const { name, args } = toolCall.functionCall;

      if (name === 'compare_prices') {
        const query = (args as { query: string }).query || trimmed;
        const products = await compareAllPrices(query);
        const fallbackText = formatComparisonFallback(query, products);

        return {
          htmlText: fallbackText,
          products,
          searchQuery: query,
        };
      }
    }

    const rawReply = response.text || '';
    if (rawReply) {
      return {
        htmlText: cleanHtmlOutput(rawReply),
      };
    }

    const fallbackProducts = await compareAllPrices(trimmed);
    return {
      htmlText: formatComparisonFallback(trimmed, fallbackProducts),
      products: fallbackProducts,
      searchQuery: trimmed,
    };
  } catch (error) {
    console.error('[Gemini Agent] Error executing Gemini model, running fallback parser:', error);
    const fallbackProducts = await compareAllPrices(trimmed);
    return {
      htmlText: formatComparisonFallback(trimmed, fallbackProducts),
      products: fallbackProducts,
      searchQuery: trimmed,
    };
  }
}

/**
 * Execute Multimodal Gemini Agent with Voice/Audio File.
 */
export async function runShoppingAgentWithAudio(
  base64Audio: string,
  mimeType: string
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
                mimeType: mimeType,
              },
            },
            {
              text: 'Extract the product name the user wants to buy or compare prices for in Iran. Call compare_prices function with the extracted product name.',
            },
          ],
        },
      ],
      config: {
        tools: [comparePricesTool],
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
      },
    });

    const candidate = response.candidates?.[0];
    const modelParts = candidate?.content?.parts || [];
    const toolCall = modelParts.find((part) => part.functionCall);

    if (toolCall && toolCall.functionCall) {
      const { name, args } = toolCall.functionCall;
      if (name === 'compare_prices') {
        const query = (args as { query: string }).query || 'کالای صوتی';
        const products = await compareAllPrices(query);
        const fallbackText = formatComparisonFallback(query, products);

        return {
          htmlText: fallbackText,
          products,
          searchQuery: query,
        };
      }
    }

    const rawReply = response.text || '';
    if (rawReply) {
      return { htmlText: cleanHtmlOutput(rawReply) };
    }

    return {
      htmlText: '⚠️ متأسفانه متوجه نام محصول در پیام صوتی شما نشدم. لطفاً نام کالا را به صورت متنی ارسال فرمایید.',
    };
  } catch (error) {
    console.error('[Gemini Audio Agent] Error:', error);
    return {
      htmlText: '⚠️ در پردازش پیام صوتی خطایی رخ داد. لطفاً نام محصول را به صورت متنی تایپ کنید.',
    };
  }
}

/**
 * Execute Multimodal Gemini Agent with Photo/Image.
 */
export async function runShoppingAgentWithPhoto(
  base64Image: string,
  mimeType: string
): Promise<AgentResponse> {
  try {
    const prompt = `
You are an expert Iranian tech & product identifier.
Look at this image (which may be a product, box, label, invoice, or screenshot) and identify the EXACT product name and model in English and Persian.
Return ONLY JSON: {"productQuery": "string (e.g. iPhone 16 Pro Max 256GB)"}
`.trim();

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: base64Image,
                mimeType,
              },
            },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const text = response.text?.trim();
    if (text) {
      const parsed = JSON.parse(text);
      if (parsed.productQuery && parsed.productQuery.length >= 2) {
        const products = await compareAllPrices(parsed.productQuery);
        return {
          htmlText: `📸 <b>کالای شناسایی شده از تصویر:</b> <code>${parsed.productQuery}</code>\n\n${formatComparisonFallback(parsed.productQuery, products)}`,
          products,
          searchQuery: parsed.productQuery,
        };
      }
    }

    return {
      htmlText: '⚠️ متأسفانه کالای مشخصی در تصویر شناسایی نشد. لطفاً نام کالا را تایپ کنید.',
    };
  } catch (err) {
    console.error('[Gemini Vision Agent] Error:', err);
    return {
      htmlText: '⚠️ در بررسی تصویر خطایی رخ داد. لطفاً نام محصول را به صورت متنی ارسال کنید.',
    };
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generates structured Persian HTML comparison summary.
 */
export function formatComparisonFallback(query: string, results: ProductResult[]): string {
  const availableItems = results.filter((r) => r.isAvailable && r.price > 0);
  const digikalaItem = results.find((r) => r.source === 'Digikala');
  const torobItem = results.find((r) => r.source === 'Torob');
  const zoomitItem = results.find((r) => r.source === 'Zoomit');

  if (availableItems.length === 0) {
    return (
      `🔍 <b>استعلام قیمت برای:</b> <code>${escapeHtml(query)}</code>\n\n` +
      `❌ متأسفانه محصول مورد نظر شما در حال حاضر در فروشگاه‌ها موجود نیست یا یافت نشد.\n\n` +
      `💡 <i>پیشنهاد: مدل مشخص‌تر یا نام دقیق کالا را ارسال کنید.</i>`
    );
  }

  const cheapest = availableItems[0];

  let html = `🛍️ <b>استعلام و مقایسه قیمت: ${escapeHtml(query)}</b>\n\n`;
  html += `🏆 <b>ارزان‌ترین پیشنهاد:</b> <b>${cheapest.source}</b> با قیمت <b>${cheapest.formattedPrice}</b>\n\n`;

  html += `📊 <b>وضعیت قیمت‌ها:</b>\n`;
  html += `• <b>دیجی‌کالا (Digikala):</b> ${digikalaItem?.isAvailable ? (digikalaItem.price > 0 ? `<b>${digikalaItem.formattedPrice}</b>` : '🔍 استعلام در دیجی‌کالا') : '❌ ناموجود / یافت نشد'}\n`;
  html += `• <b>ترب (Torob):</b> ${torobItem?.isAvailable ? (torobItem.price > 0 ? `<b>${torobItem.formattedPrice}</b>` : '🔍 استعلام مستقیم در ترب') : '❌ ناموجود / یافت نشد'}\n`;
  if (zoomitItem?.isAvailable) {
    html += `• <b>زومیت (Zoomit):</b> 📱 مشخصات و قیمت در زومیت\n`;
  }

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
  cleaned = cleaned.replace(/<br\s*[\/]?>/gi, '\n');
  cleaned = cleaned.replace(/<\/?(ul|ol)>/gi, '');
  cleaned = cleaned.replace(/<li[^>]*>/gi, '• ');
  cleaned = cleaned.replace(/<\/li>/gi, '\n');
  cleaned = cleaned.replace(/<\/?(p|div)>/gi, '\n');
  cleaned = cleaned.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '<b>$1</b>\n');
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  cleaned = cleaned.replace(/\*(.*?)\*/g, '<i>$1</i>');
  cleaned = cleaned.replace(/`([^`]+)`/g, '<code>$1</code>');
  cleaned = cleaned.replace(/^#+\s*(.*?)$/gm, '<b>$1</b>');

  cleaned = cleaned.replace(
    /<(?!\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|a(?:\s+href="[^"]*")?)\b)[^>]*>/gi,
    ''
  );

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

/**
 * Builds interactive Telegram InlineKeyboard buttons for product search results.
 */
export function buildProductInlineKeyboard(
  products: ProductResult[],
  searchQuery: string
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const encoded = encodeURIComponent(searchQuery);

  const availableItems = products.filter((p) => p.isAvailable && p.price > 0);
  const digikalaItem = products.find((p) => p.source === 'Digikala');
  const torobItem = products.find((p) => p.source === 'Torob');
  const zoomitItem = products.find((p) => p.source === 'Zoomit');

  if (availableItems.length === 0) {
    keyboard
      .url('🔍 جستجو در ترب', toAffiliateUrl(`https://torob.com/search/?query=${encoded}`, 'Torob'))
      .url(
        '📦 جستجو در دیجی‌کالا',
        toAffiliateUrl(`https://www.digikala.com/search/?q=${encoded}`, 'Digikala')
      )
      .row()
      .url(
        '📱 جستجو در زومیت',
        toAffiliateUrl(`https://www.zoomit.ir/product/search/${encoded}/`, 'Zoomit')
      );
    return keyboard;
  }

  const cheapest = availableItems[0];
  const cheapestAffiliateUrl = toAffiliateUrl(cheapest.url, cheapest.source);

  // Row 1: Primary buy button
  keyboard.url(`🛒 خرید از ${cheapest.source} (بهترین قیمت)`, cheapestAffiliateUrl).row();

  // Row 2: Direct links for Digikala and Torob
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
    )
    .row();

  // Row 3: Zoomit specs & review button
  const zoomitUrl = zoomitItem?.url || `https://www.zoomit.ir/product/search/${encoded}/`;
  keyboard.url('📱 بررسی و مشخصات در زومیت', toAffiliateUrl(zoomitUrl, 'Zoomit')).row();

  // Row 4: Action Tools (Price Alert & Price Chart)
  keyboard
    .text('🔔 رصد کاهش قیمت', `alert:${searchQuery.slice(0, 30)}:${cheapest.price}`)
    .text('📉 نمودار قیمت', `chart:${searchQuery.slice(0, 30)}:${cheapest.price}`);

  return keyboard;
}

/**
 * Sends response to user as photo message if product image is available,
 * or gracefully falls back to standard HTML text.
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
    } catch {
      // Remote image fallback
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
    try {
      await ctx.reply(plainText, {
        reply_markup: replyMarkup,
      });
    } catch (plainError) {
      console.error('[Telegram Bot] Critical failure sending message:', plainError);
    }
  }
}

/* ==========================================================================
   Telegram Bot Command & Message Handlers
   ========================================================================== */

// /start command
bot.command('start', async (ctx: Context) => {
  const welcomeText = `
👋 <b>سلام! به ربات مفت‌بر (شکارچی کمترین قیمت) خوش آمدید!</b> 🛍️

من قیمت هر کالایی را به صورت لحظه‌ای بین <b>دیجی‌کالا</b>، <b>ترب</b> و <b>زومیت</b> مقایسه می‌کنم تا همیشه <b>ارزان‌ترین فروشنده</b> را پیدا کنید.

💡 <b>امکانات ویژه:</b>
• 🔍 <b>استعلام قیمت:</b> نام کالا را بفرستید (متن یا وویس).
• 📸 <b>جستجوی تصویری:</b> عکس کالا یا جعبه آن را بفرستید.
• 🔔 <b>هشدار کاهش قیمت:</b> با دکمه رصد، به محض ارزان شدن کالا باخبر شوید.
• 📉 <b>نمودار تغییرات قیمت:</b> تحلیل روند قیمت در روزهای اخیر.
• ⚖️ <b>مقایسه هوشمند:</b> بنویسید «مقایسه آیفون ۱۶ با S24 اولترا».

<i>همین الان نام یک محصول یا عکس آن را ارسال کنید!</i> 🚀
`.trim();

  const keyboard = new Keyboard()
    .text('🔍 استعلام قیمت کالا')
    .text('🔔 هشدارهای من')
    .row()
    .text('ℹ️ راهنما')
    .resized();

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
});

// /help command
bot.command('help', async (ctx: Context) => {
  const helpText = `
📖 <b>راهنمای استفاده از ربات:</b>

۱. <b>جستجوی متنی:</b>
کافی است نام هر کالای دیجیتال یا لوازم خانگی را بفرستید:
• <code>مکبوک پرو m4</code>
• <code>iphone 16 pro max 256gb</code>
• <code>اسپیکر jbl charge 6</code>

۲. <b>جستجوی صوتی:</b>
یک پیام صوتی (Voice) بفرستید و بگویید: «قیمت ایرپاد پرو ۲ چنده؟»

۳. <b>جستجوی تصویری:</b>
عکس محصول را ارسال کنید تا هوش مصنوعی آن را شناسایی و ارزان‌ترین قیمت را پیدا کند.

۴. <b>مقایسه دو کالا:</b>
بنویسید: <code>مقایسه MacBook Air M3 با M4</code>

۵. <b>هشدارهای قیمت:</b>
دستور /alerts را برای مشاهده کالاهای تحت رصد خود ارسال کنید.
`.trim();

  await ctx.reply(helpText, { parse_mode: 'HTML' });
});

// /alerts command (View active price alerts)
bot.command('alerts', async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const alerts = alertService.getUserAlerts(userId);

  if (alerts.length === 0) {
    return ctx.reply(
      '🔔 <b>شما در حال حاضر هیچ هشدار فعالی ندارید.</b>\n\nبرای فعال‌سازی، بعد از جستجوی هر کالا روی دکمه <b>«🔔 رصد کاهش قیمت»</b> کلیک کنید.',
      { parse_mode: 'HTML' }
    );
  }

  let text = `📋 <b>لیست کالاهای تحت رصد شما (${alerts.length} مورد):</b>\n\n`;
  const keyboard = new InlineKeyboard();

  alerts.forEach((alt, idx) => {
    text += `${idx + 1}. <b>${escapeHtml(alt.query)}</b>\n`;
    text += `💰 قیمت ثبت شده: ${formatTomanPrice(alt.initialPrice)}\n`;
    text += `📉 آخرین قیمت: ${formatTomanPrice(alt.lastCheckedPrice)}\n\n`;

    keyboard.text(`🔕 لغو: ${alt.query.slice(0, 20)}`, `del_alert:${alt.id}`).row();
  });

  await ctx.reply(text.trim(), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
});

// Callback query for Price Alert Registration
bot.callbackQuery(/^alert:(.+):(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;

  const query = match[1];
  const price = parseInt(match[2], 10);
  const userId = ctx.from.id;
  const chatId = ctx.chat?.id || userId;

  const { alert, isNew } = alertService.addAlert(
    userId,
    chatId,
    query,
    query,
    price,
    'Market',
    ''
  );

  await ctx.answerCallbackQuery({
    text: isNew
      ? `✅ هشدار فعال شد! به محض ارزان‌تر شدن به شما پیام می‌دهیم.`
      : `ℹ️ این کالا قبلاً در لیست رصد شما قرار دارد.`,
    show_alert: true,
  });
});

// Callback query for Deleting Alert
bot.callbackQuery(/^del_alert:(.+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;

  const alertId = match[1];
  const userId = ctx.from.id;

  const success = alertService.removeAlert(userId, alertId);

  await ctx.answerCallbackQuery({
    text: success ? '🔕 هشدار با موفقیت غیرفعال شد.' : '⚠️ هشدار یافت نشد.',
  });

  if (success) {
    await ctx.editMessageText('🔕 <b>هشدار کاهش قیمت این کالا با موفقیت غیرفعال شد.</b>', {
      parse_mode: 'HTML',
    });
  }
});

// Callback query for Price History Chart
bot.callbackQuery(/^chart:(.+):(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;

  const query = match[1];
  const price = parseInt(match[2], 10);

  await ctx.answerCallbackQuery({ text: '📊 در حال تولید نمودار قیمت...' });

  const analysis = generatePriceChartUrl(query, price);

  const caption = `
📉 <b>تحلیل و نمودار قیمت: ${escapeHtml(query)}</b>

💰 <b>قیمت فعلی:</b> <b>${formatTomanPrice(analysis.currentPrice)}</b>
📉 <b>کمترین قیمت دوره:</b> ${formatTomanPrice(analysis.minPrice)}
📈 <b>بیشترین قیمت دوره:</b> ${formatTomanPrice(analysis.maxPrice)}

💡 <b>توصیه هوش مصنوعی:</b>
${analysis.advicePersian}
`.trim();

  try {
    await ctx.replyWithPhoto(analysis.chartUrl, {
      caption,
      parse_mode: 'HTML',
    });
  } catch (err) {
    await ctx.reply(caption, { parse_mode: 'HTML' });
  }
});

// Text Message Handler
bot.on('message:text', async (ctx: Context) => {
  const text = ctx.message?.text?.trim() || '';

  if (text.startsWith('/')) return;

  if (text === '🔍 استعلام قیمت کالا') {
    return ctx.reply('🔍 نام کالای مورد نظرتان را تایپ کنید (مثلاً: <code>iPhone 16 Pro Max</code>):', {
      parse_mode: 'HTML',
    });
  }

  if (text === '🔔 هشدارهای من') {
    const userId = ctx.from?.id;
    if (!userId) return;
    const alerts = alertService.getUserAlerts(userId);
    if (alerts.length === 0) {
      return ctx.reply(
        '🔔 <b>شما هیچ هشدار فعالی ندارید.</b>\nبعد از جستجوی کالا روی «🔔 رصد کاهش قیمت» کلیک کنید.',
        { parse_mode: 'HTML' }
      );
    }
    let msg = `📋 <b>هشدارهای فعال شما (${alerts.length} مورد):</b>\n\n`;
    const keyboard = new InlineKeyboard();
    alerts.forEach((alt, idx) => {
      msg += `${idx + 1}. <b>${escapeHtml(alt.query)}</b> (${formatTomanPrice(alt.initialPrice)})\n`;
      keyboard.text(`🔕 لغو: ${alt.query.slice(0, 18)}`, `del_alert:${alt.id}`).row();
    });
    return ctx.reply(msg.trim(), { parse_mode: 'HTML', reply_markup: keyboard });
  }

  if (text === 'ℹ️ راهنما') {
    return ctx.reply(
      '📖 برای شروع، نام محصولی که می‌خواهید قیمت آن را مقایسه کنید ارسال کنید (مثلاً: <code>سامسونگ S24 Ultra</code> یا <code>مک‌بوک پرو M4</code> یا یک عکس/وویس بفرستید).',
      { parse_mode: 'HTML' }
    );
  }

  // Side-by-side comparison check
  if (isComparisonQuery(text)) {
    const items = parseComparisonItems(text);
    if (items) {
      await ctx.replyWithChatAction('typing');
      const compLoading = await ctx.reply(
        `⚖️ <b>در حال مقایسه هوشمند "${items[0]}" با "${items[1]}"...</b> ⏳`,
        { parse_mode: 'HTML' }
      );
      try {
        const compResult = await compareTwoProducts(items[0], items[1]);
        if (ctx.chat?.id) {
          await ctx.api.deleteMessage(ctx.chat.id, compLoading.message_id).catch(() => {});
        }
        return ctx.reply(compResult.htmlSummary, {
          parse_mode: 'HTML',
          reply_markup: compResult.keyboard,
        });
      } catch (compErr) {
        if (ctx.chat?.id) {
          await ctx.api.deleteMessage(ctx.chat.id, compLoading.message_id).catch(() => {});
        }
      }
    }
  }

  await ctx.replyWithChatAction('typing');

  let loadingMsg: any = null;
  try {
    loadingMsg = await ctx.reply(
      '🔍 <b>در حال جستجو و مقایسه قیمت‌ها از دیجی‌کالا، ترب و زومیت...</b> ⏳',
      { parse_mode: 'HTML' }
    );
  } catch {
    // ignore
  }

  try {
    const result = await runShoppingAgent(text);

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

// Photo Message Handler (Visual Search / Image Recognition)
bot.on('message:photo', async (ctx: Context) => {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;

  await ctx.replyWithChatAction('typing');

  let loadingMsg: any = null;
  try {
    loadingMsg = await ctx.reply('📸 <b>در حال پردازش تصویر و تشخیص هوشمند مدل کالا...</b> ⏳', {
      parse_mode: 'HTML',
    });
  } catch {
    // ignore
  }

  try {
    const bestPhoto = photos[photos.length - 1]; // Highest resolution
    const file = await ctx.api.getFile(bestPhoto.file_id);

    if (!file.file_path) {
      if (loadingMsg && ctx.chat?.id) {
        await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
      }
      return ctx.reply('⚠️ دریافت تصویر با مشکل مواجه شد. لطفاً نام محصول را تایپ کنید.', {
        parse_mode: 'HTML',
      });
    }

    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await axios.get<ArrayBuffer>(fileUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const base64Image = Buffer.from(response.data).toString('base64');
    const mimeType = 'image/jpeg';

    const result = await runShoppingAgentWithPhoto(base64Image, mimeType);

    if (loadingMsg && ctx.chat?.id) {
      await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    }

    await sendShoppingResponse(ctx, result);
  } catch (error: any) {
    console.error('Error handling photo message:', error?.message || error);
    if (loadingMsg && ctx.chat?.id) {
      await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    }
    await ctx.reply('⚠️ در پردازش تصویر خطایی رخ داد. لطفاً نام کالا را به صورت متنی ارسال کنید.', {
      parse_mode: 'HTML',
    });
  }
});

// Voice Message Handler (Multimodal Gemini Speech Recognition)
bot.on('message:voice', async (ctx: Context) => {
  const voice = ctx.message?.voice;
  if (!voice) return;

  await ctx.replyWithChatAction('typing');

  let loadingMsg: any = null;
  try {
    loadingMsg = await ctx.reply(
      '🎙️ <b>در حال پردازش پیام صوتی و استعلام قیمت از دیجی‌کالا و ترب...</b> ⏳',
      { parse_mode: 'HTML' }
    );
  } catch {
    // ignore
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
        description: 'نام محصول را تایپ کنید (مثلاً: iPhone 16 یا مکبوک پرو M4)',
        thumbnail_url: 'https://cdn-icons-png.flaticon.com/512/3144/3144456.png',
      }
    ).text(
      '👋 <b>برای استعلام قیمت در تلگرام:</b>\nنام محصول مورد نظرتان را پس از آیدی ربات بنویسید (مثلاً: <code>@botname MacBook Pro M4</code>).',
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
          description: 'هیچ کالای فعالی در فروشگاه‌ها پیدا نشد.',
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

/**
 * Register Telegram bot commands in the menu.
 */
export async function registerBotCommands(): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: '🚀 شروع به کار و منوی اصلی' },
      { command: 'help', description: '📖 راهنمای استعلام و مقایسه قیمت' },
      { command: 'alerts', description: '🔔 هشدارهای فعال کاهش قیمت من' },
    ]);
    console.log('[Telegram Bot] ✅ Bot menu commands registered successfully.');
  } catch (err) {
    console.warn('[Telegram Bot] ⚠️ Could not register bot commands:', err);
  }
}

/**
 * Start the bot polling service and periodic background tasks.
 */
export async function startBot(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('[Telegram Bot] Cannot start bot without TELEGRAM_BOT_TOKEN.');
    return;
  }

  await registerBotCommands();

  // Start background price alert tracker (every 60 minutes)
  alertService.startBackgroundTracker(bot, 60);

  console.log('[Telegram Bot] 🚀 Starting Telegram Bot polling...');
  bot.start({
    onStart: (botInfo) => {
      console.log(`[Telegram Bot] 🚀 Bot @${botInfo.username} is now online and listening for messages!`);
    },
  });
}
