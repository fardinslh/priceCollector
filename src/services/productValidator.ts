import process from 'node:process';
import { GoogleGenAI } from '@google/genai';

/**
 * Candidate item structure for product validation.
 */
export interface CandidateProduct {
  title: string;
  price: number; // in Tomans
  status?: string | null;
  raw?: any;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

let aiInstance: GoogleGenAI | null = null;
if (GEMINI_API_KEY) {
  aiInstance = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

/**
 * Keywords indicating fake, replica, or non-genuine items.
 */
export const FAKE_KEYWORDS = [
  'طرح',
  'کپی',
  'فیک',
  'غیراصل',
  'غیر اصل',
  'های کپی',
  'های‌کپی',
  'high copy',
  'clone',
  'replica',
  'fake',
  'copy',
  'فول کپی',
  'ماکت',
];

/**
 * Keywords indicating accessories that must be filtered out when a main device is requested.
 */
export const ACCESSORY_KEYWORDS = [
  'محافظ صفحه',
  'محافظ نمایش',
  'محافظ لنز',
  'محافظ دوربین',
  'گلس',
  'کاور',
  'قاب',
  'کیف',
  'بند',
  'استیکر',
  'برچسب',
  'شارژر',
  'کابل',
  'پد ماوس',
  'پد موس',
  'پایه نگهدارنده',
  'هولدر',
  'استند',
  'تبدیل',
  'مونوپاد',
  'سلفی',
  'اسکین',
  'آستین',
  'screen protector',
  'lens protector',
  'glass',
  'case',
  'cover',
  'strap',
  'sleeve',
  'adapter',
  'cable',
  'film',
  'skin',
  'keyboard cover',
  'dust plug',
  'محافظ کیبورد',
];

/**
 * Keywords indicating used, refurbished, stock, or installment down-payments.
 */
export const USED_KEYWORDS = [
  'کارکرده',
  'استوک',
  'دست دوم',
  'refurbished',
  'open box',
  'open-box',
  'جعبه باز',
  'جعبه آسیب دیده',
  'نمایشگاهی',
  'ویترینی',
  'پیش پرداخت',
  'اقساط',
  'قسطی',
  'down payment',
  'stock',
  'used',
];

/**
 * Detects if a product title is an accessory when the user searched for a main device.
 */
export function isAccessoryProduct(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  for (const acc of ACCESSORY_KEYWORDS) {
    if (q.includes(acc)) {
      return false; // User explicitly asked for the accessory
    }
  }

  return ACCESSORY_KEYWORDS.some((acc) => {
    const regex = new RegExp(`(^|\\s|\\/|-)${acc}(\\s|\\/|-|$)`, 'i');
    return regex.test(t) || t.includes(acc);
  });
}

/**
 * Detects if a product is used, refurbished, or fake.
 */
export function isUsedOrFakeProduct(
  title: string,
  status: string | null | undefined,
  query: string
): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  const fullText = `${t} ${(status || '').toLowerCase()}`;

  // Fake / Replica check
  if (FAKE_KEYWORDS.some((f) => t.includes(f) || fullText.includes(f))) {
    return true;
  }

  // Used / Refurbished check
  for (const u of USED_KEYWORDS) {
    if (q.includes(u)) {
      return false; // User explicitly asked for used/stock
    }
  }

  return USED_KEYWORDS.some((u) => fullText.includes(u));
}

/**
 * Checks whether sub-models match (e.g. Pro vs Air, Ultra vs base, Slim vs standard).
 */
export function matchesSubModel(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  // MacBook / iPad: Pro vs Air
  const qHasPro = /(?:^|\s)(pro|پرو)(?:\s|$)/i.test(q);
  const qHasAir = /(?:^|\s)(air|ایر)(?:\s|$)/i.test(q);
  const tHasPro = /(?:^|\s)(pro|پرو)(?:\s|$)/i.test(t);
  const tHasAir = /(?:^|\s)(air|ایر)(?:\s|$)/i.test(t);

  if (qHasPro && !qHasAir && tHasAir && !tHasPro) return false;
  if (qHasAir && !qHasPro && tHasPro && !tHasAir) return false;

  // Ultra vs standard (Galaxy S24 Ultra / Apple Watch Ultra)
  const qHasUltra = /(?:^|\s)(ultra|اولترا|الترا)(?:\s|$)/i.test(q);
  const tHasUltra = /(?:^|\s)(ultra|اولترا|الترا)(?:\s|$)/i.test(t);
  if (qHasUltra && !tHasUltra) return false;
  if (!qHasUltra && tHasUltra && (q.includes('s23') || q.includes('s24') || q.includes('s25'))) return false;

  // Plus vs regular
  const qHasPlus = /(?:^|\s)(plus|پلاس)(?:\s|$)/i.test(q);
  const tHasPlus = /(?:^|\s)(plus|پلاس)(?:\s|$)/i.test(t);
  if (qHasPlus && !tHasPlus) return false;

  return true;
}

/**
 * Checks whether chipset and numerical generation match.
 */
export function matchesChipsetAndGeneration(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  // 1. Apple Silicon M-Series (M1, M2, M3, M4, M5)
  const chipMatch = q.match(/(?:^|\s)(m[1-9])(?:\s|$)/i);
  if (chipMatch) {
    const requestedChip = chipMatch[1].toLowerCase();
    const allMChips = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const otherMChips = allMChips.filter((c) => c !== requestedChip);

    // Reject other M-chips
    if (otherMChips.some((c) => new RegExp(`(?:^|\\s|-)${c}(?:\\s|-|$)`, 'i').test(t))) {
      return false;
    }

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

    if (!t.includes(requestedChip)) {
      return false;
    }
  }

  // 2. Numerical Generation (iPhone 11/12/13/14/15/16, S23/S24/S25, AirPods 2/3/4)
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
 * Checks price realism to eliminate accessory matches, fake clones, or down payment installments.
 */
export function isPriceRealistic(title: string, price: number, query: string): boolean {
  if (price <= 0) return false;

  const q = query.toLowerCase();
  const t = title.toLowerCase();

  // 1. AirPods
  if (q.includes('airpods') || q.includes('ایرپاد') || t.includes('airpods') || t.includes('ایرپاد')) {
    if (price < 10000000) return false; // Genuine AirPods start above 10M Toman
  }

  // 2. Laptops (MacBook)
  const isMacBook =
    ['macbook', 'مکبوک', 'مک بوک'].some((k) => q.includes(k) || t.includes(k));
  if (isMacBook) {
    if (q.includes('m4') || t.includes('m4')) {
      if (price < 150000000) return false;
    } else if (q.includes('m3') || t.includes('m3')) {
      if (price < 90000000) return false;
    } else if (q.includes('m2') || t.includes('m2')) {
      if (price < 65000000) return false;
    } else if (q.includes('m1') || t.includes('m1')) {
      if (price < 45000000) return false;
    } else if (price < 30000000) {
      return false;
    }
  }

  // 3. Flagship Phones (iPhone, Galaxy S-series)
  const isFlagshipPhone =
    ['iphone', 'آیفون', 'ایفون', 's23', 's24', 's25'].some((k) => q.includes(k) || t.includes(k));
  if (isFlagshipPhone && price < 25000000) {
    return false;
  }

  // 4. Gaming Consoles (PS5, Xbox Series X)
  const isConsole =
    ['ps5', 'پلی استیشن', 'playstation', 'xbox series'].some((k) => q.includes(k) || t.includes(k));
  if (isConsole && price < 20000000) {
    return false;
  }

  // 5. Apple Watch
  const isAppleWatch =
    ['apple watch', 'اپل واچ', 'اپلواچ'].some((k) => q.includes(k) || t.includes(k));
  if (isAppleWatch && price < 10000000) {
    return false;
  }

  return true;
}

/**
 * Computes a high-precision relevance score (0 to 100) for a candidate product.
 */
export function scoreCandidateProduct(
  title: string,
  price: number,
  status: string | null | undefined,
  query: string
): number {
  if (price <= 0) return 0;
  if (isAccessoryProduct(title, query)) return 0;
  if (isUsedOrFakeProduct(title, status, query)) return 0;
  if (!matchesSubModel(title, query)) return 0;
  if (!matchesChipsetAndGeneration(title, query)) return 0;
  if (!isPriceRealistic(title, price, query)) return 0;

  let score = 60;
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  // Exact Chip bonus
  const chipMatch = q.match(/(?:^|\s)(m[1-9])(?:\s|$)/i);
  if (chipMatch) {
    const chip = chipMatch[1].toLowerCase();
    if (t.includes(`${chip} pro`) && !q.includes('pro')) {
      score -= 10; // Higher tier variant
    } else {
      score += 20;
    }
  }

  // Exact base storage match (e.g. 128 vs 256 vs 512)
  const storageMatch = q.match(/(?:^|\s)(128|256|512|1tb|2tb)(?:\s|$)/i);
  if (storageMatch) {
    const storage = storageMatch[1].toLowerCase();
    if (t.includes(storage)) {
      score += 20;
    }
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Deterministic ranker to select the single best genuine matching product.
 */
export function deterministicFilterAndRank(
  candidates: CandidateProduct[],
  query: string
): CandidateProduct | null {
  if (!candidates || candidates.length === 0) return null;

  const scored = candidates
    .map((c) => ({
      candidate: c,
      score: scoreCandidateProduct(c.title, c.price, c.status, query),
    }))
    .filter((item) => item.score >= 50 && item.candidate.price > 0);

  if (scored.length === 0) {
    return null;
  }

  // Sort primarily by highest match score, secondarily by lowest price
  scored.sort((a, b) => b.score - a.score || a.candidate.price - b.candidate.price);

  return scored[0].candidate;
}

/**
 * AI-powered validator using Gemini with deterministic safety.
 */
export async function validateProductCandidatesWithAI(
  query: string,
  candidates: CandidateProduct[]
): Promise<CandidateProduct | null> {
  if (!candidates || candidates.length === 0) return null;

  // Run deterministic filter first
  const deterministicBest = deterministicFilterAndRank(candidates, query);

  // If deterministic score is high-confidence, return it immediately for instant 0ms latency
  if (deterministicBest) {
    return deterministicBest;
  }

  // If Gemini API is available, try semantic evaluation
  if (aiInstance) {
    try {
      const candidateSlice = candidates.slice(0, 6);
      const prompt = `
You are an Iranian e-commerce product verification AI.
User is searching for: "${query}"

Candidates:
${candidateSlice
  .map(
    (c, i) =>
      `[${i + 1}] Title: "${c.title}" | Price: ${c.price.toLocaleString('en-US')} Toman | Status: ${c.status || 'New'}`
  )
  .join('\n')}

Task: Select the EXACT genuine new matching product index (1-based), or return null if all are accessories/used/fake.
Return ONLY JSON: {"selectedIndex": number | null}
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
        if (
          typeof parsed.selectedIndex === 'number' &&
          parsed.selectedIndex >= 1 &&
          parsed.selectedIndex <= candidateSlice.length
        ) {
          const aiChosen = candidateSlice[parsed.selectedIndex - 1];
          if (
            !isAccessoryProduct(aiChosen.title, query) &&
            !isUsedOrFakeProduct(aiChosen.title, aiChosen.status, query) &&
            isPriceRealistic(aiChosen.title, aiChosen.price, query)
          ) {
            return aiChosen;
          }
        }
      }
    } catch {
      // Return deterministicBest on error
    }
  }

  return deterministicBest;
}
