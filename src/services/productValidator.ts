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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

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
  'سری سیلیکونی',
];

/**
 * Keywords indicating car, ceiling, commercial sound systems or bulk packs that are not portable consumer speakers.
 */
export const AUDIO_COMMERCIAL_KEYWORDS = [
  'سقفی',
  'بلندگو سقفی',
  'اسپیکر سقفی',
  'بلندگو بیضی',
  'میدرنج',
  'تیوتر',
  'ساب ووفر',
  'ساب‌ووفر',
  'آمپلی فایر',
  'آمپلی‌فایر',
  'میکسر',
  'پک 4 عددی',
  'پک 2 عددی',
  'پک 6 عددی',
  'ceiling',
  'midrange',
  'tweeter',
  'subwoofer',
  'amplifier',
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
 * Known product series/sub-brand identifiers.
 */
export const KNOWN_SERIES = [
  // Audio & Speakers
  'charge',
  'flip',
  'xtreme',
  'boombox',
  'partybox',
  'clip',
  'go',
  'pulse',
  'wind',
  'soundcore',
  'emberton',
  'middleton',
  'stanmore',
  // Phones & Tablets
  'airpods',
  'galaxy',
  'redmi',
  'poco',
  // Laptops
  'macbook',
  'thinkpad',
  'ideapad',
  'legion',
  'yoga',
  'zenbook',
  'vivobook',
  'rog',
  'tuf',
  'pavilion',
  'envy',
  'spectre',
  'omen',
  'victus',
  'surface',
];

/**
 * Detects if a product title is an accessory using strict word boundaries to avoid false positives (e.g. "قابل حمل" or "برند").
 */
export function isAccessoryProduct(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  for (const acc of ACCESSORY_KEYWORDS) {
    if (q.includes(acc)) {
      return false; // User explicitly asked for the accessory
    }
    // Strict word boundary regex
    const regex = new RegExp(`(^|[\\s\\/_–—-])${acc}($|[\\s\\/_–—-])`, 'iu');
    if (regex.test(t)) {
      return true;
    }
  }

  return false;
}

/**
 * Detects if a product is commercial/ceiling audio when the user searched for a consumer device.
 */
export function isCommercialAudioProduct(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  for (const com of AUDIO_COMMERCIAL_KEYWORDS) {
    if (q.includes(com)) {
      return false; // User explicitly asked for ceiling/commercial speaker
    }
    if (t.includes(com)) {
      return true;
    }
  }

  return false;
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
  for (const f of FAKE_KEYWORDS) {
    const regex = new RegExp(`(^|[\\s\\/_–—-])${f}($|[\\s\\/_–—-])`, 'iu');
    if (regex.test(fullText)) {
      return true;
    }
  }

  // Used / Refurbished check
  for (const u of USED_KEYWORDS) {
    if (q.includes(u)) {
      return false; // User explicitly asked for used/stock
    }
    const regex = new RegExp(`(^|[\\s\\/_–—-])${u}($|[\\s\\/_–—-])`, 'iu');
    if (regex.test(fullText)) {
      return true;
    }
  }

  return false;
}

/**
 * Enforces product series matching (e.g. Charge vs Flip vs Xtreme vs Boombox vs MacBook Pro vs Air).
 */
export function matchesProductSeries(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  for (const s of KNOWN_SERIES) {
    if (q.includes(s) && !t.includes(s)) {
      return false; // Query explicitly specified series 's', but title lacks it!
    }
  }

  // Sub-models: Pro vs Air
  const qHasPro = /(?:^|\s)(pro|پرو)(?:\s|$)/i.test(q);
  const qHasAir = /(?:^|\s)(air|ایر)(?:\s|$)/i.test(q);
  const tHasPro = /(?:^|\s)(pro|پرو)(?:\s|$)/i.test(t);
  const tHasAir = /(?:^|\s)(air|ایر)(?:\s|$)/i.test(t);

  if (qHasPro && !qHasAir && tHasAir && !tHasPro) return false;
  if (qHasAir && !qHasPro && tHasPro && !tHasAir) return false;

  // Ultra vs standard
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
 * Checks whether generation number / model numbers match (e.g. Charge 6 vs 5, iPhone 13 vs 14, M4 vs M5).
 */
export function matchesGenerationAndNumber(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  // 1. Audio Model Numbers (e.g. Charge 6, Flip 7, Clip 5, Xtreme 4, Boombox 3)
  const audioSeriesMatch = q.match(/(?:charge|flip|xtreme|boombox|partybox|clip|go|pulse)\s*(\d+)/i);
  if (audioSeriesMatch) {
    const series = audioSeriesMatch[0].toLowerCase();
    const num = audioSeriesMatch[1];
    if (!t.includes(`${series.split(/\s+/)[0]} ${num}`) && !t.includes(`${series.split(/\s+/)[0]}${num}`) && !t.includes(num)) {
      return false;
    }
  }

  // 2. Apple Silicon M-Series (M1, M2, M3, M4, M5)
  const chipMatch = q.match(/(?:^|\s)(m[1-9])(?:\s|$)/i);
  if (chipMatch) {
    const requestedChip = chipMatch[1].toLowerCase();
    const allMChips = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const otherMChips = allMChips.filter((c) => c !== requestedChip);

    if (otherMChips.some((c) => new RegExp(`(?:^|\\s|-)${c}(?:\\s|-|$)`, 'i').test(t))) {
      return false;
    }

    const oldIntel = ['core i3', 'core i5', 'core i7', 'core i9', 'i3', 'i5', 'i7', 'i9', 'intel', '2017', '2018', '2019', '2020'];
    if (oldIntel.some((old) => t.includes(old)) && !q.includes('intel')) {
      return false;
    }

    if (!t.includes(requestedChip)) {
      return false;
    }
  }

  // 3. Numerical Generation (iPhone 11/12/13/14/15/16, S23/S24/S25, AirPods 2/3/4)
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

  // 1. Portable Speakers (JBL Charge / Flip / Xtreme / Boombox)
  if (q.includes('charge') || q.includes('flip') || q.includes('xtreme') || q.includes('boombox')) {
    if (q.includes('charge') && price < 10000000) return false;
    if (q.includes('flip') && price < 7000000) return false;
    if (q.includes('xtreme') && price < 15000000) return false;
    if (q.includes('boombox') && price < 25000000) return false;
  }

  // 2. AirPods
  if (q.includes('airpods') || q.includes('ایرپاد') || t.includes('airpods') || t.includes('ایرپاد')) {
    if (price < 10000000) return false;
  }

  // 3. Laptops (MacBook)
  const isMacBook = ['macbook', 'مکبوک', 'مک بوک'].some((k) => q.includes(k) || t.includes(k));
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

  // 4. Flagship Phones (iPhone, Galaxy S-series)
  const isFlagshipPhone = ['iphone', 'آیفون', 'ایفون', 's23', 's24', 's25'].some((k) => q.includes(k) || t.includes(k));
  if (isFlagshipPhone && price < 25000000) {
    return false;
  }

  // 5. Gaming Consoles (PS5, Xbox Series X)
  const isConsole = ['ps5', 'پلی استیشن', 'playstation', 'xbox series'].some((k) => q.includes(k) || t.includes(k));
  if (isConsole && price < 20000000) {
    return false;
  }

  // 6. Apple Watch
  const isAppleWatch = ['apple watch', 'اپل واچ', 'اپلواچ'].some((k) => q.includes(k) || t.includes(k));
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
  if (isCommercialAudioProduct(title, query)) return 0;
  if (isUsedOrFakeProduct(title, status, query)) return 0;
  if (!matchesProductSeries(title, query)) return 0;
  if (!matchesGenerationAndNumber(title, query)) return 0;
  if (!isPriceRealistic(title, price, query)) return 0;

  let score = 60;
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  // Exact Series match bonus
  for (const s of KNOWN_SERIES) {
    if (q.includes(s) && t.includes(s)) {
      score += 20;
      break;
    }
  }

  // Exact Chip bonus
  const chipMatch = q.match(/(?:^|\s)(m[1-9])(?:\s|$)/i);
  if (chipMatch) {
    const chip = chipMatch[1].toLowerCase();
    if (t.includes(`${chip} pro`) && !q.includes('pro')) {
      score -= 10;
    } else {
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
  if (deterministicBest) {
    return deterministicBest;
  }

  // Fallback to Gemini 3.6 Flash if deterministic filter did not find a match
  if (aiInstance) {
    try {
      const candidateSlice = candidates.slice(0, 6);
      const prompt = `
You are an expert Iranian e-commerce product verification AI.
User search: "${query}"

Candidate Products:
${candidateSlice
  .map((c, i) => `[${i + 1}] Title: "${c.title}" | Price: ${c.price.toLocaleString('en-US')} Toman | Status: ${c.status || 'New'}`)
  .join('\n')}

Task: Select the EXACT matching product index (1-based), strictly filtering out accessories, ceiling speakers, fakes, or wrong series/models.
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
            !isCommercialAudioProduct(aiChosen.title, query) &&
            !isUsedOrFakeProduct(aiChosen.title, aiChosen.status, query) &&
            matchesProductSeries(aiChosen.title, query) &&
            isPriceRealistic(aiChosen.title, aiChosen.price, query)
          ) {
            return aiChosen;
          }
        }
      }
    } catch {
      // Fallback
    }
  }

  return deterministicBest;
}
