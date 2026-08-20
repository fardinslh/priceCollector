import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { GoogleGenAI } from '@google/genai';
import type { ProductResult } from './priceService.js';

export interface PriceFloorData {
  minObserved: number;
  maxObserved: number;
  avgObserved: number;
  sampleCount: number;
  lastUpdated: string;
}

export interface LearningMemory {
  version: string;
  lastUpdated: string;
  queryMappings: Record<string, string>;
  brandAliases: Record<string, string>;
  learnedPriceFloors: Record<string, PriceFloorData>;
  learnedNegativeKeywords: string[];
  stats: {
    totalQueriesProcessed: number;
    successfulLearnings: number;
    cacheHitAccelerations: number;
  };
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const MEMORY_FILE_PATH = path.join(DATA_DIR, 'learningMemory.json');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

let aiInstance: GoogleGenAI | null = null;
if (GEMINI_API_KEY) {
  aiInstance = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

const DEFAULT_MEMORY: LearningMemory = {
  version: '1.0.0',
  lastUpdated: new Date().toISOString(),
  queryMappings: {
    'مکبوک پرو m4': 'MacBook Pro M4',
    'مک بوک پرو m4': 'MacBook Pro M4',
    'ایرپاد پرو ۲': 'AirPods Pro 2',
    'ایرپاد پرو 2': 'AirPods Pro 2',
    'ایفون ۱۶ پرو مکس': 'iPhone 16 Pro Max',
    'آیفون ۱۶ پرو مکس': 'iPhone 16 Pro Max',
    'اس ۲۴ اولترا': 'Samsung Galaxy S24 Ultra',
    'اس 24 اولترا': 'Samsung Galaxy S24 Ultra',
    'jbl charge 6': 'JBL Charge 6',
    'اسپیکر چارج ۶': 'JBL Charge 6',
  },
  brandAliases: {
    'اپل': 'Apple',
    'ایفون': 'iPhone',
    'آیفون': 'iPhone',
    'سامسونگ': 'Samsung',
    'شیائومی': 'Xiaomi',
    'ردمی': 'Redmi',
    'پوکو': 'Poco',
  },
  learnedPriceFloors: {},
  learnedNegativeKeywords: [],
  stats: {
    totalQueriesProcessed: 0,
    successfulLearnings: 0,
    cacheHitAccelerations: 0,
  },
};

class ContinuousLearningEngine {
  private memory: LearningMemory;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.memory = this.loadMemory();
  }

  private loadMemory(): LearningMemory {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(MEMORY_FILE_PATH)) {
        const fileContent = fs.readFileSync(MEMORY_FILE_PATH, 'utf-8');
        const parsed = JSON.parse(fileContent);
        return {
          ...DEFAULT_MEMORY,
          ...parsed,
          stats: {
            ...DEFAULT_MEMORY.stats,
            ...(parsed.stats || {}),
          },
        };
      }
    } catch (err) {
      process.stderr.write(`[learningEngine] Warning reading memory file: ${err}\n`);
    }

    return { ...DEFAULT_MEMORY };
  }

  /**
   * Debounced save to disk to avoid I/O bottlenecks.
   */
  private scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      try {
        if (!fs.existsSync(DATA_DIR)) {
          fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        this.memory.lastUpdated = new Date().toISOString();
        fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify(this.memory, null, 2), 'utf-8');
        process.stderr.write(`[learningEngine] Successfully persisted self-learned knowledge to disk.\n`);
      } catch (err) {
        process.stderr.write(`[learningEngine] Error saving memory to disk: ${err}\n`);
      }
    }, 1500);
  }

  /**
   * Extracts a standardized product signature key for price floor indexing.
   */
  public extractProductKey(text: string): string {
    return text
      .toLowerCase()
      .replace(/(?:گوشی|موبایل|لپ تاپ|لپتاپ|هدفون|اسپیکر|مدل|ظرفیت|گیگابایت|گیگ|رم|دو سیم|کارت|zaa|lla|ch|دو سیم کارت)/gi, ' ')
      .replace(/[\(\)\[\]\|\-–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Retrieves any learned canonical query rewrite from memory.
   */
  public getLearnedCanonicalQuery(rawQuery: string): string | null {
    const key = rawQuery.trim().toLowerCase();
    return this.memory.queryMappings[key] || null;
  }

  /**
   * Retrieves the dynamic minimum price floor learned from previous verified real-world listings.
   */
  public getLearnedPriceFloor(queryOrTitle: string): number | null {
    const key = this.extractProductKey(queryOrTitle);
    for (const [learnedKey, data] of Object.entries(this.memory.learnedPriceFloors)) {
      if (key.includes(learnedKey) || learnedKey.includes(key)) {
        // Price floor is 45% of minimum observed genuine price
        return Math.round(data.minObserved * 0.45);
      }
    }
    return null;
  }

  /**
   * Records a successful search result, automatically updating:
   * 1. Query rewrite dictionary (slang -> canonical name)
   * 2. Dynamic price floors & moving averages
   * 3. Statistical learning metrics
   */
  public recordSuccessfulSearch(
    rawQuery: string,
    canonicalQuery: string,
    verifiedResults: ProductResult[]
  ): void {
    this.memory.stats.totalQueriesProcessed += 1;

    const availablePriced = verifiedResults.filter((p) => p.isAvailable && p.price > 0);
    if (availablePriced.length === 0) return;

    const winner = availablePriced[0];
    const normalizedRaw = rawQuery.trim().toLowerCase();

    // 1. Learn query mapping if user query differs from clean canonical representation
    if (canonicalQuery && canonicalQuery.toLowerCase() !== normalizedRaw) {
      this.memory.queryMappings[normalizedRaw] = canonicalQuery;
      this.memory.stats.successfulLearnings += 1;
      process.stderr.write(
        `[learningEngine] Learned new query mapping: "${normalizedRaw}" -> "${canonicalQuery}"\n`
      );
    }

    // 2. Update Dynamic Price Floors
    const productKey = this.extractProductKey(canonicalQuery || rawQuery);
    if (productKey.length >= 3) {
      const existing = this.memory.learnedPriceFloors[productKey];
      const currentPrice = winner.price;

      if (existing) {
        existing.minObserved = Math.min(existing.minObserved, currentPrice);
        existing.maxObserved = Math.max(existing.maxObserved, currentPrice);
        existing.avgObserved = Math.round(
          (existing.avgObserved * existing.sampleCount + currentPrice) / (existing.sampleCount + 1)
        );
        existing.sampleCount += 1;
        existing.lastUpdated = new Date().toISOString();
      } else {
        this.memory.learnedPriceFloors[productKey] = {
          minObserved: currentPrice,
          maxObserved: currentPrice,
          avgObserved: currentPrice,
          sampleCount: 1,
          lastUpdated: new Date().toISOString(),
        };
      }
    }

    this.scheduleSave();
  }

  /**
   * Background AI self-reflection when a query fails or produces ambiguous candidates.
   * Runs asynchronously without blocking the user response.
   */
  public async reflectAndLearnFromFailure(failedQuery: string): Promise<void> {
    if (!aiInstance) return;

    try {
      const prompt = `
You are an expert Iranian e-commerce query optimizer and self-learning system.
A user searched for: "${failedQuery}" but the search engine had difficulty matching it.

Task:
1. Extract the exact English and Persian clean product name (remove slang, typo, noise like "رجیستر شده", "ارزون", "قیمت").
2. Return ONLY JSON:
{
  "canonicalEnglish": "string (e.g. iPhone 16 Pro Max 256GB)",
  "canonicalPersian": "string (e.g. گوشی آیفون ۱۶ پرو مکس ۲۵۶ گیگابایت)",
  "detectedCategory": "string"
}
`.trim();

      const response = await aiInstance.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const text = response.text?.trim();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed.canonicalEnglish && parsed.canonicalEnglish.length > 3) {
          const key = failedQuery.trim().toLowerCase();
          this.memory.queryMappings[key] = parsed.canonicalEnglish;
          this.memory.stats.successfulLearnings += 1;
          process.stderr.write(
            `[learningEngine] [AI Reflection] Learned self-correction for "${key}" -> "${parsed.canonicalEnglish}"\n`
          );
          this.scheduleSave();
        }
      }
    } catch {
      // Non-blocking background worker
    }
  }

  /**
   * Returns current learning statistics.
   */
  public getStats() {
    return {
      ...this.memory.stats,
      totalLearnedQueryMappings: Object.keys(this.memory.queryMappings).length,
      totalLearnedPriceFloors: Object.keys(this.memory.learnedPriceFloors).length,
      lastUpdated: this.memory.lastUpdated,
    };
  }
}

export const learningEngine = new ContinuousLearningEngine();
