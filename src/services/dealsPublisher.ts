import process from 'node:process';
import { Bot, InlineKeyboard } from 'grammy';
import { compareAllPrices, formatTomanPrice, type ProductResult } from './priceService.js';
import { toAffiliateUrl } from '../utils/affiliate.js';

export interface DealOpportunity {
  query: string;
  cheapestStore: string;
  cheapestPrice: number;
  expensiveStore: string;
  expensivePrice: number;
  profitAmount: number;
  profitPercent: number;
  cheapestUrl: string;
  imageUrl?: string;
}

const POPULAR_TRACKED_ITEMS = [
  'iPhone 16 Pro Max 256GB',
  'MacBook Pro M4',
  'AirPods Pro 2',
  'Samsung Galaxy S24 Ultra',
  'JBL Charge 6',
  'PlayStation 5 Slim',
  'iPad Air M2',
  'Apple Watch Ultra 2',
];

/**
 * Discovers the best live price differences / arbitrage deals across stores.
 */
export async function discoverTopDeals(): Promise<DealOpportunity[]> {
  const deals: DealOpportunity[] = [];

  for (const item of POPULAR_TRACKED_ITEMS) {
    try {
      const results = await compareAllPrices(item);
      const available = results.filter((r) => r.isAvailable && r.price > 0);

      if (available.length >= 2) {
        const cheapest = available[0];
        const expensive = available[available.length - 1];

        const diff = expensive.price - cheapest.price;
        if (diff > 500000) {
          // Minimum 500k Toman price difference
          const percent = Math.round((diff / expensive.price) * 100);
          deals.push({
            query: item,
            cheapestStore: cheapest.source,
            cheapestPrice: cheapest.price,
            expensiveStore: expensive.source,
            expensivePrice: expensive.price,
            profitAmount: diff,
            profitPercent: percent,
            cheapestUrl: cheapest.url,
            imageUrl: cheapest.imageUrl,
          });
        }
      }
    } catch {
      // Continue to next item
    }
  }

  // Sort by highest profit amount
  deals.sort((a, b) => b.profitAmount - a.profitAmount);
  return deals;
}

/**
 * Publishes top deals to a configured Telegram channel.
 */
export async function publishTopDealToChannel(bot: Bot, channelId?: string): Promise<boolean> {
  const targetChannel = channelId || process.env.TELEGRAM_DEALS_CHANNEL_ID;
  if (!targetChannel) return false;

  try {
    const deals = await discoverTopDeals();
    if (deals.length === 0) return false;

    const topDeal = deals[0];
    const affiliateUrl = toAffiliateUrl(topDeal.cheapestUrl, topDeal.cheapestStore as any);

    const text = `
🔥 <b>فرصت استثنایی خرید و شکار قیمت!</b> 🛍️

📦 <b>کالا:</b> <code>${topDeal.query}</code>

🏆 <b>ارزان‌ترین در ${topDeal.cheapestStore}:</b> <b>${formatTomanPrice(topDeal.cheapestPrice)}</b>
🛒 <b>قیمت در ${topDeal.expensiveStore}:</b> <s>${formatTomanPrice(topDeal.expensivePrice)}</s>

💰 <b>میزان سود مستقیم شما:</b> <b>${formatTomanPrice(topDeal.profitAmount)}</b> (${topDeal.profitPercent}٪ ارزان‌تر!)

<i>برای خرید با کمترین قیمت روی دکمه زیر کلیک کنید:</i>
`.trim();

    const keyboard = new InlineKeyboard().url(
      `🛒 خرید ارزان‌ترین از ${topDeal.cheapestStore}`,
      affiliateUrl
    );

    if (topDeal.imageUrl && topDeal.imageUrl.startsWith('http')) {
      try {
        await bot.api.sendPhoto(targetChannel, topDeal.imageUrl, {
          caption: text,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        return true;
      } catch {
        // Fallback to text
      }
    }

    await bot.api.sendMessage(targetChannel, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    return true;
  } catch (err) {
    process.stderr.write(`[dealsPublisher] Error publishing deal to channel: ${err}\n`);
    return false;
  }
}
