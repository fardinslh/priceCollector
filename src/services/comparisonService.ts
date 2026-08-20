import 'dotenv/config';
import process from 'node:process';
import { GoogleGenAI } from '@google/genai';
import { compareAllPrices, formatTomanPrice, type ProductResult } from './priceService.js';
import { toAffiliateUrl } from '../utils/affiliate.js';
import { InlineKeyboard } from 'grammy';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

let aiInstance: GoogleGenAI | null = null;
if (GEMINI_API_KEY) {
  aiInstance = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface ComparisonResult {
  item1Query: string;
  item2Query: string;
  item1Products: ProductResult[];
  item2Products: ProductResult[];
  htmlSummary: string;
  keyboard: InlineKeyboard;
}

/**
 * Detects if a user query is asking for a comparison between two products.
 */
export function isComparisonQuery(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return (
    /(?:^|\s)(?:مقایسه|مقایسش|کدوم بهتره|کدومو بخرم)(?:\s|$)/i.test(trimmed) ||
    /(?:.+)\s+(?:با|vs|یا|در برابر)\s+(?:.+)/i.test(trimmed)
  );
}

/**
 * Parses two product targets from a comparison query.
 */
export function parseComparisonItems(text: string): [string, string] | null {
  const cleaned = text
    .replace(/(?:^|\s)(?:لطفا|بی زحمت|قیمت|مقایسه کن|مقایسه|کدوم بهتره|بین)(?:\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Pattern 1: X با Y or X vs Y or X یا Y
  const match = cleaned.match(/^(.+?)\s+(?:با|vs|یا|در برابر|و)\s+(.+)$/i);
  if (match && match[1].trim().length >= 2 && match[2].trim().length >= 2) {
    return [match[1].trim(), match[2].trim()];
  }

  return null;
}

/**
 * Performs full live price comparison and AI technical synthesis for two products.
 */
export async function compareTwoProducts(
  item1Query: string,
  item2Query: string
): Promise<ComparisonResult> {
  const [results1, results2] = await Promise.all([
    compareAllPrices(item1Query),
    compareAllPrices(item2Query),
  ]);

  const p1 = results1.find((r) => r.isAvailable && r.price > 0);
  const p2 = results2.find((r) => r.isAvailable && r.price > 0);

  const price1Text = p1 ? `${p1.source}: ${p1.formattedPrice}` : '❌ ناموجود در فروشگاه‌ها';
  const price2Text = p2 ? `${p2.source}: ${p2.formattedPrice}` : '❌ ناموجود در فروشگاه‌ها';

  let aiSynthesis = '';

  if (aiInstance) {
    try {
      const prompt = `
You are a technical Iranian tech reviewer and buyer consultant.
Compare these two products concisely in Persian for Telegram:
Product 1: "${item1Query}" (Price: ${price1Text})
Product 2: "${item2Query}" (Price: ${price2Text})

Output format strictly in Telegram HTML:
- 3 key bullet points comparing strengths/differences (Processor/Screen, Camera/Battery, Value for money).
- A 1-sentence bottom line verdict (کدوم ارزش خرید بیشتری داره).
Use ONLY <b>, <i>, <code> tags. Keep under 120 words.
`.trim();

      const res = await aiInstance.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });

      aiSynthesis = res.text?.trim() || '';
    } catch {
      // Fallback
    }
  }

  let html = `⚖️ <b>مقایسه هوشمند دو کالا:</b>\n\n`;
  html += `1️⃣ <b>${escapeHtml(item1Query)}</b>\n`;
  html += `💰 کمترین قیمت: <b>${price1Text}</b>\n\n`;

  html += `2️⃣ <b>${escapeHtml(item2Query)}</b>\n`;
  html += `💰 کمترین قیمت: <b>${price2Text}</b>\n\n`;

  if (aiSynthesis) {
    html += `📊 <b>تحلیل و ارزش خرید:</b>\n${aiSynthesis}\n`;
  }

  const keyboard = new InlineKeyboard();

  if (p1) {
    keyboard.url(`🛒 خرید ${item1Query.slice(0, 15)} (${p1.source})`, toAffiliateUrl(p1.url, p1.source as any));
  }
  if (p2) {
    keyboard.url(`🛒 خرید ${item2Query.slice(0, 15)} (${p2.source})`, toAffiliateUrl(p2.url, p2.source as any));
  }

  return {
    item1Query,
    item2Query,
    item1Products: results1,
    item2Products: results2,
    htmlSummary: html.trim(),
    keyboard,
  };
}
