import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import process from 'node:process';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

let aiInstance: GoogleGenAI | null = null;
if (GEMINI_API_KEY) {
  aiInstance = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

export interface CandidateProduct {
  title: string;
  price: number;
  status?: string;
  url?: string;
  raw?: any;
}

const ACCESSORY_KEYWORDS = [
  'گلس',
  'محافظ صفحه',
  'محافظ لنز',
  'کاور',
  'قاب',
  'کیف',
  'بند',
  'استیکر',
  'برچسب',
  'شارژر',
  'کابل',
  'پد',
  'پایه',
  'هولدر',
  'تبدیل',
  'سلفی',
  'اسکین',
  'آستین',
  'screen protector',
  'case',
  'cover',
  'strap',
  'sleeve',
  'adapter',
  'cable',
  'film',
  'skin',
];

const USED_AND_INSTALLMENT_KEYWORDS = [
  'کارکرده',
  'استوک',
  'دست دوم',
  'refurbished',
  'open box',
  'جعبه باز',
  'قسطی',
  'پیش پرداخت',
  'اقساط',
  'stock',
  'used',
];

/**
 * Checks if a title represents an accessory when the user didn't ask for one.
 */
export function isAccessoryProduct(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  const userWantsAccessory = ACCESSORY_KEYWORDS.some((k) => q.includes(k));
  if (userWantsAccessory) return false;
  return ACCESSORY_KEYWORDS.some((k) => {
    const regex = new RegExp(`(^|\\s|\\/|-)${k}(\\s|\\/|-|$)`, 'i');
    return regex.test(t) || t.includes(k);
  });
}

/**
 * Checks if a title or status denotes used, second-hand, refurbished, or installment down payments.
 */
export function isUsedOrInstallmentProduct(
  title: string,
  status: string | undefined,
  query: string
): boolean {
  const combined = `${title} ${status || ''}`.toLowerCase();
  const q = query.toLowerCase();
  const userWantsUsed = USED_AND_INSTALLMENT_KEYWORDS.some((k) => q.includes(k));
  if (userWantsUsed) return false;
  return USED_AND_INSTALLMENT_KEYWORDS.some((k) => combined.includes(k));
}

/**
 * Ensures strict sub-model matching (e.g. Pro vs Air, Ultra, Max, Plus, Mini).
 */
export function matchesSubModel(title: string, query: string): boolean {
  const q = query.toLowerCase();
  const t = title.toLowerCase();

  // Pro vs Air
  const qHasPro = /(?:^|\s)(pro|پرو)(?:\s|$)/i.test(q);
  const qHasAir = /(?:^|\s)(air|ایر)(?:\s|$)/i.test(q);
  const tHasPro = /(?:^|\s)(pro|پرو)(?:\s|$)/i.test(t);
  const tHasAir = /(?:^|\s)(air|ایر)(?:\s|$)/i.test(t);

  if (qHasPro && !qHasAir && tHasAir && !tHasPro) return false;
  if (qHasAir && !qHasPro && tHasPro && !tHasAir) return false;

  // Ultra
  const qHasUltra = /(?:^|\s)(ultra|اولترا)(?:\s|$)/i.test(q);
  const tHasUltra = /(?:^|\s)(ultra|اولترا)(?:\s|$)/i.test(t);
  if (qHasUltra && !tHasUltra) return false;
  if (!qHasUltra && tHasUltra && (q.includes('s2') || q.includes('apple watch'))) return false;

  // Max
  const qHasMax = /(?:^|\s)(max|مکس)(?:\s|$)/i.test(q);
  const tHasMax = /(?:^|\s)(max|مکس)(?:\s|$)/i.test(t);
  if (qHasMax && !tHasMax) return false;

  // Plus
  const qHasPlus = /(?:^|\s)(plus|پلاس)(?:\s|$)/i.test(q);
  const tHasPlus = /(?:^|\s)(plus|پلاس)(?:\s|$)/i.test(t);
  if (qHasPlus && !tHasPlus) return false;

  // Mini
  const qHasMini = /(?:^|\s)(mini|مینی)(?:\s|$)/i.test(q);
  const tHasMini = /(?:^|\s)(mini|مینی)(?:\s|$)/i.test(t);
  if (qHasMini && !tHasMini) return false;

  return true;
}

/**
 * Ensures strict chipset, processor generation, and model number matching.
 */
export function matchesChipsetAndGeneration(title: string, query: string): boolean {
  const q = query.toLowerCase();
  const t = title.toLowerCase();

  // 1. Apple Silicon Chips (M1, M2, M3, M4, M5, M4 Pro, M4 Max)
  const chipMatch = q.match(/(?:^|\s)(m[1-9]|m[1-9]\s*pro|m[1-9]\s*max)(?:\s|$)/i);
  if (chipMatch) {
    const chip = chipMatch[1].replace(/\s+/g, '').toLowerCase();
    const tWithoutSpaces = t.replace(/\s+/g, '');
    if (!tWithoutSpaces.includes(chip)) return false;

    // Reject older Intel chips when M-series is requested
    const oldIntel = [
      'core i3',
      'core i5',
      'core i7',
      'core i9',
      'i3',
      'i5',
      'i7',
      'i9',
      'intel',
      '2017',
      '2018',
      '2019',
      '2020',
    ];
    if (oldIntel.some((old) => t.includes(old)) && !q.includes('intel')) {
      return false;
    }
  }

  // 2. Numeric Generation (e.g. iPhone 13 vs 14 vs 15 vs 16 / S23 vs S24 vs S25)
  const genMatch = q.match(/(?:^|\s)(\d{2}|s\d{2})(?:\s|$)/i);
  if (genMatch) {
    const gen = genMatch[1].toLowerCase();
    const regex = new RegExp(`(^|\\s|\\/|-)${gen}(\\s|\\/|-|$)`, 'i');
    if (!regex.test(t) && !t.includes(gen)) {
      return false;
    }
  }

  return true;
}

/**
 * Checks price realism to eliminate accessory matches or down payment installments.
 */
export function isPriceRealistic(title: string, price: number, query: string): boolean {
  if (price <= 0) return false;

  const q = query.toLowerCase();
  const t = title.toLowerCase();

  // Laptops (MacBook, ThinkPad, ZenBook, Legion, ROG, etc.)
  const isLaptop =
    ['macbook', 'مکبوک', 'مک بوک', 'لپ تاپ', 'لپتاپ', 'laptop'].some((k) => q.includes(k)) ||
    ['macbook', 'مکبوک', 'مک بوک', 'لپ تاپ', 'لپتاپ'].some((k) => t.includes(k));

  if (isLaptop) {
    // If it's a modern M-series MacBook, filter out installment down payments
    if (q.includes('m4') || t.includes('m4')) {
      if (price < 150000000) return false;
    } else if (q.includes('m3') || t.includes('m3')) {
      if (price < 90000000) return false;
    } else if (q.includes('m2') || t.includes('m2')) {
      if (price < 65000000) return false;
    } else if (q.includes('m1') || t.includes('m1')) {
      if (price < 45000000) return false;
    } else if (price < 15000000) {
      return false;
    }
  }

  // Flagship Phones (iPhone 13/14/15/16, Galaxy S23/S24/S25)
  const isFlagshipPhone =
    ['iphone', 'آیفون', 'ایفون', 's23', 's24', 's25'].some((k) => q.includes(k)) &&
    !ACCESSORY_KEYWORDS.some((k) => q.includes(k));

  if (isFlagshipPhone && price < 15000000) {
    return false;
  }

  return true;
}

/**
 * Algorithmic deterministic filter and ranker to select the single best genuine matching product.
 */
export function deterministicFilterAndRank(
  candidates: CandidateProduct[],
  query: string
): CandidateProduct | null {
  if (!candidates || candidates.length === 0) return null;

  const validCandidates = candidates.filter((c) => {
    if (!c.title || c.price <= 0) return false;
    if (isAccessoryProduct(c.title, query)) return false;
    if (isUsedOrInstallmentProduct(c.title, c.status, query)) return false;
    if (!matchesSubModel(c.title, query)) return false;
    if (!matchesChipsetAndGeneration(c.title, query)) return false;
    if (!isPriceRealistic(c.title, c.price, query)) return false;
    return true;
  });

  if (validCandidates.length === 0) {
    return null;
  }

  // Sort by price ascending to find the best deal
  validCandidates.sort((a, b) => a.price - b.price);
  return validCandidates[0];
}

/**
 * AI-powered validator using Gemini to semantically verify candidates and pick the exact match.
 */
export async function validateProductCandidatesWithAI(
  query: string,
  candidates: CandidateProduct[]
): Promise<CandidateProduct | null> {
  if (!candidates || candidates.length === 0) return null;

  // First run deterministic filter to eliminate obvious junk
  const deterministicBest = deterministicFilterAndRank(candidates, query);

  // If Gemini API is not configured, return deterministic result immediately
  if (!aiInstance) {
    return deterministicBest;
  }

  // Limit candidates to top 6 to conserve tokens and reduce latency
  const candidateSlice = candidates.slice(0, 6);

  const prompt = `
You are an expert Iranian e-commerce product verification AI.
The user is searching for: "${query}"

Here is a list of candidate products from an Iranian online store:
${candidateSlice
  .map(
    (c, i) =>
      `[${i + 1}] Title: "${c.title}" | Price: ${c.price.toLocaleString('en-US')} Toman | Status: ${c.status || 'New/Available'}`
  )
  .join('\n')}

Task:
1. Identify the EXACT matching product index (1-based) that represents the NEW, GENUINE product matching the user's requested brand, model family, generation, and chipset (e.g. M4, iPhone 15 Pro, Tefal Iron, etc.).
2. Strictly FILTER OUT:
   - Accessories (screen protectors / محافظ صفحه, cases / قاب, chargers / شارژر, cables, sleeves)
   - Used / refurbished / stock products (کارکرده, استوک, دست دوم)
   - Sub-model mismatch (e.g. user asked for MacBook Pro but candidate is MacBook Air; user asked for Pro but candidate is base model)
   - Generation / Chipset mismatch (e.g. user asked for M4 but candidate is Intel Core i5 or 2019/2020 or M1/M2/M3)
   - Fake or partial prices (installment down payments / پیش پرداخت under actual market value)
3. Return ONLY a JSON object: {"selectedIndex": number | null, "reason": "brief explanation"}
`.trim();

  try {
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
      if (
        typeof parsed.selectedIndex === 'number' &&
        parsed.selectedIndex >= 1 &&
        parsed.selectedIndex <= candidateSlice.length
      ) {
        const aiChosen = candidateSlice[parsed.selectedIndex - 1];
        process.stderr.write(
          `[productValidator] AI verified exact match: "${aiChosen.title.slice(0, 45)}..." at ${aiChosen.price} Toman (${parsed.reason || 'verified'})\n`
        );
        return aiChosen;
      }
    }
  } catch (error: any) {
    process.stderr.write(
      `[productValidator] AI validation skipped due to error/quota (${error?.message || error}), falling back to deterministic ranker.\n`
    );
  }

  // Gracefully fallback to deterministic ranker
  return deterministicBest;
}
