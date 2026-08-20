import 'dotenv/config';
import process from 'node:process';
import { GoogleGenAI } from '@google/genai';
import { learningEngine } from './learningEngine.js';

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
 * Detects if a product title is an accessory using strict structural and contextual checks.
 * Distinguishes between actual devices (e.g. smartwatches with "بند سیلیکون") and accessory parts.
 */
export function isAccessoryProduct(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  // If user explicitly asked for the accessory (e.g. "بند ساعت گلوریمی"), do not flag as accessory
  const isQueryForAccessory = [
    'بند',
    'قاب',
    'کاور',
    'گلس',
    'محافظ',
    'کابل',
    'شارژر',
    'هولدر',
    'استند',
    'strap',
    'case',
    'cover',
    'glass',
  ].some((acc) => q.includes(acc));

  if (isQueryForAccessory) {
    return false;
  }

  // 1. Check for "مناسب برای" / "سازگار با" (e.g. "بند ... مناسب برای ساعت هوشمند گلوریمی", "کاور ... مناسب برای آیفون")
  if (/(?:مناسب برای|مناسب|سازگار با|مخصوص)\s+/i.test(t)) {
    return true;
  }

  // 2. Check if title starts with an accessory keyword
  const startsWithAccessory =
    /^(?:بند|قاب|کاور|گلس|محافظ|کابل|شارژر|پد|استند|هولدر|پایه نگهدارنده|تبدیل|مونوپاد|استیکر|برچسب|کیف|آستین|سرفصل|سری)\s+/i.test(
      t.trim()
    );
  if (startsWithAccessory) {
    return true;
  }

  // 3. Smartwatch with included strap in box (e.g. "ساعت هوشمند گلوریمی مدل M2 MAX LTD ... بند سیلیکون")
  const isMainSmartwatch =
    /^(?:ساعت\s*هوشمند|ساعت\s*مچی|smartwatch|smart\s*watch)\s+/i.test(t.trim());
  if (isMainSmartwatch) {
    // If it's a main smartwatch, "بند سیلیکون" or "بند چرم" in title is just strap material
    return false;
  }

  // 4. Main smartphone / laptop / tablet / console
  const isMainDevice =
    /^(?:گوشی|موبایل|لپ\s*تاپ|تبلت|کنسول|تلویزیون|اسپیکر|هدفون|هندزفری)\s+/i.test(t.trim());
  if (isMainDevice) {
    return false;
  }

  // 5. Fallback keyword check for generic titles
  const standaloneAccessoryKeywords = [
    'محافظ صفحه نمایش',
    'محافظ صفحه',
    'محافظ لنز',
    'محافظ پشت',
    'محافظ دوربین',
    'گلس',
    'کاور',
    'کیف گوشی',
    'کیف تبلت',
    'شارژر دیواری',
    'شارژر فندکی',
    'کابل شارژ',
    'screen protector',
    'lens protector',
    'phone case',
    'silicone case',
    'leather case',
    'watch strap',
    'charging cable',
  ];

  for (const acc of standaloneAccessoryKeywords) {
    if (t.includes(acc)) {
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
 * Enforces brand matching (e.g. iPhone/Apple vs Samsung vs Xiaomi vs Daria).
 */
export function matchesBrand(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  const isAppleQuery = ['iphone', 'apple', 'آیفون', 'ایفون', 'اپل', 'مک بوک', 'مکبوک', 'macbook', 'ipad', 'آیپد'].some(
    (k) => q.includes(k)
  );
  if (isAppleQuery) {
    const nonAppleBrands = ['شیائومی', 'xiaomi', 'redmi', 'ردمی', 'poco', 'پوکو', 'سامسونگ', 'samsung', 'داریا', 'daria', 'یونیوا', 'univa'];
    if (nonAppleBrands.some((b) => t.includes(b))) {
      return false;
    }
  }

  const isSamsungQuery = ['samsung', 'سامسونگ', 'galaxy', 'گلکسی'].some((k) => q.includes(k));
  if (isSamsungQuery) {
    const nonSamsung = ['iphone', 'آیفون', 'ایفون', 'شیائومی', 'xiaomi', 'redmi', 'ردمی', 'poco', 'پوکو', 'داریا', 'یونیوا'];
    if (nonSamsung.some((b) => t.includes(b))) {
      return false;
    }
  }

  const isXiaomiQuery = ['xiaomi', 'شیائومی', 'شیاومی', 'redmi', 'ردمی', 'poco', 'پوکو'].some((k) => q.includes(k));
  if (isXiaomiQuery) {
    const nonXiaomi = ['iphone', 'آیفون', 'ایفون', 'سامسونگ', 'samsung', 'داریا', 'یونیوا'];
    if (nonXiaomi.some((b) => t.includes(b))) {
      return false;
    }
  }

  const isPlayStationQuery = ['ps5', 'ps4', 'playstation', 'پلی استیشن', 'پلی‌استیشن'].some((k) => q.includes(k));
  if (isPlayStationQuery) {
    if (!t.includes('ps5') && !t.includes('ps4') && !t.includes('playstation') && !t.includes('پلی استیشن') && !t.includes('سونی') && !t.includes('sony')) {
      return false;
    }
    const nonConsole = ['مودم', 'modem', 'روتر', 'router', 'cpe', 'سیمکارت', 'هواوی', 'huawei'];
    if (nonConsole.some((nc) => t.includes(nc))) {
      return false;
    }
  }

  const isJBLQuery = ['jbl', 'جی بی ال'].some((k) => q.includes(k));
  if (isJBLQuery) {
    const nonJBL = ['سامسونگ', 'سونی', 'انکر', 'anker', 'تسکو', 'tsco'];
    if (nonJBL.some((b) => t.includes(b))) {
      return false;
    }
  }

  return true;
}

/**
 * Enforces exact sub-model and variant matching (Pro Max vs Pro vs Max vs Plus vs Ultra vs Mini vs FE vs Base).
 */
export function matchesSubModel(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  const qHasPro = /(?:^|\s)(pro|پرو)(?:\s|$)/i.test(q);
  const qHasMax = /(?:^|\s)(max|مکس)(?:\s|$)/i.test(q);
  const qHasPlus = /(?:^|\s)(plus|پلاس)(?:\s|$)/i.test(q);
  const qHasUltra = /(?:^|\s)(ultra|اولترا|الترا)(?:\s|$)/i.test(q);
  const qHasMini = /(?:^|\s)(mini|مینی)(?:\s|$)/i.test(q);
  const qHasFE = /(?:^|\s)(fe)(?:\s|$)/i.test(q);
  const qHasAir = /(?:^|\s)(air|ایر)(?:\s|$)/i.test(q);

  const tHasPro = /(?:^|\s)(pro|پرو)(?:\s|$)/i.test(t);
  const tHasMax = /(?:^|\s)(max|مکس)(?:\s|$)/i.test(t);
  const tHasPlus = /(?:^|\s)(plus|پلاس)(?:\s|$)/i.test(t);
  const tHasUltra = /(?:^|\s)(ultra|اولترا|الترا)(?:\s|$)/i.test(t);
  const tHasMini = /(?:^|\s)(mini|مینی)(?:\s|$)/i.test(t);
  const tHasFE = /(?:^|\s)(fe)(?:\s|$)/i.test(t);
  const tHasAir = /(?:^|\s)(air|ایر)(?:\s|$)/i.test(t);

  // 1. Pro Max (both Pro and Max required)
  if (qHasPro && qHasMax) {
    if (!tHasPro || !tHasMax) return false;
  } else if (qHasPro && !qHasMax) {
    // Only Pro requested (e.g. iPhone 16 Pro) -> Candidate MUST have Pro, and MUST NOT have Max
    if (!tHasPro || tHasMax) return false;
  } else if (!qHasPro && qHasMax) {
    // Only Max requested -> Candidate MUST have Max, and MUST NOT have Pro
    if (!tHasMax || tHasPro) return false;
  }

  // 2. Plus
  if (qHasPlus && !tHasPlus) return false;
  if (!qHasPlus && tHasPlus) return false;

  // 3. Ultra
  if (qHasUltra && !tHasUltra) return false;
  if (!qHasUltra && tHasUltra && (q.includes('s23') || q.includes('s24') || q.includes('s25') || q.includes('watch'))) return false;

  // 4. Mini
  if (qHasMini && !tHasMini) return false;
  if (!qHasMini && tHasMini) return false;

  // 5. FE
  if (qHasFE && !tHasFE) return false;
  if (!qHasFE && tHasFE) return false;

  // 6. Air
  if (qHasAir && !tHasAir) return false;
  if (!qHasAir && tHasAir && (q.includes('macbook') || q.includes('ipad'))) return false;

  // 7. Base / Standard Model check: If no modifier was in query, reject Pro / Max / Plus / Ultra / Mini / FE / Air
  const isPhoneOrTablet = ['iphone', 'آیفون', 'ایفون', 'galaxy', 'سامسونگ', 'ipad', 'آیپد', 'xiaomi', 'redmi'].some(
    (k) => q.includes(k)
  );
  if (isPhoneOrTablet && !qHasPro && !qHasMax && !qHasPlus && !qHasUltra && !qHasMini && !qHasFE && !qHasAir) {
    if (tHasPro || tHasMax || tHasPlus || tHasUltra || tHasMini || tHasFE) {
      return false;
    }
  }

  return true;
}

/**
 * Enforces storage capacity matching (e.g. 128GB vs 256GB vs 512GB vs 1TB).
 */
export function matchesStorageCapacity(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  const qCapMatch = q.match(/(?:^|\s)(64|128|256|512|1024|1tb|2tb)\s*(?:gb|گیگابایت|گیگ|g|gig|ترابایت)?(?:\s|$)/i);
  if (qCapMatch) {
    const cap = qCapMatch[1].toLowerCase();
    const allCaps = ['64', '128', '256', '512', '1024', '1tb', '2tb', '۱ ترابایت', '۲ ترابایت'];
    const otherCaps = allCaps.filter((c) => c !== cap && (cap !== '1tb' || c !== '1024') && (cap !== '1024' || c !== '1tb'));

    const hasRequested =
      t.includes(cap) ||
      (cap === '1tb' && (t.includes('1 ترابایت') || t.includes('1tb') || t.includes('1024'))) ||
      (cap === '256' && (t.includes('۲۵۶') || t.includes('256')));

    const hasOther = otherCaps.some((other) => {
      const regex = new RegExp(`(?:^|[\\s\\/_–—-])${other}(?:[\\s\\/_–—-]|gb|گیگ|گیگابایت|\\/|$)`, 'i');
      return regex.test(t);
    });

    if (!hasRequested && hasOther) {
      return false;
    }
  }

  return true;
}

/**
 * Enforces product series matching (e.g. Charge vs Flip vs Xtreme vs Boombox).
 */
export function matchesProductSeries(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  for (const s of KNOWN_SERIES) {
    const titleHasSeries =
      t.includes(s) || (s === 'airpods' && (t.includes('air pods') || t.includes('ایرپاد')));
    if (q.includes(s) && !titleHasSeries) {
      return false; // Query explicitly specified series 's', but title lacks it!
    }
  }

  return true;
}

/**
 * Checks whether generation number / model numbers match (e.g. Charge 6 vs 5, iPhone 16 vs 17 vs 15, M4 vs M5).
 */
export function matchesGenerationAndNumber(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  // AirPods generations must match explicitly. A generic "AirPods Pro" title
  // is not sufficient for an "AirPods Pro 2" or "AirPods Pro 3" query.
  const normalizedQuery = q.replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  const normalizedTitle = t.replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  const airPodsGeneration = normalizedQuery.match(
    /(?:air\s*pods|airpods|ایرپاد)(?:\s+pro|\s+پرو)?\s*(2|3)(?:nd|rd)?\b/i
  );
  if (airPodsGeneration) {
    const generation = airPodsGeneration[1];
    const generationPattern = new RegExp(
      `(?:air\\s*pods|airpods|ایرپاد)(?:\\s+pro|\\s+پرو)?\\s*(?:generation\\s*)?${generation}(?:nd|rd)?\\b`,
      'i'
    );
    if (!generationPattern.test(normalizedTitle)) {
      return false;
    }
  }

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

  // 3. iPhone / Phone Numerical Generation (iPhone 11/12/13/14/15/16/17, S23/S24/S25)
  const isPhone = ['iphone', 'آیفون', 'ایفون', 'galaxy', 'سامسونگ'].some((k) => q.includes(k));
  if (isPhone) {
    const genMatch = q.match(/(?:^|\s)(\d{2}|s\d{2})(?:\s|$)/i);
    if (genMatch) {
      const gen = genMatch[1].toLowerCase();
      // Candidate must contain the exact gen number
      const regex = new RegExp(`(^|[\\s\\/_–—-])${gen}($|[\\s\\/_–—-])`, 'i');
      if (!regex.test(t) && !t.includes(gen)) {
        return false;
      }
      // Candidate must not contain a different generation number (e.g. 17 when 16 was asked, or 15 when 16 asked)
      const allGens = ['11', '12', '13', '14', '15', '16', '17', '18'];
      const otherGens = allGens.filter((g) => g !== gen);
      for (const og of otherGens) {
        const otherRegex = new RegExp(`(?:iphone|آیفون|ایفون)\\s*${og}`, 'i');
        if (otherRegex.test(t)) {
          return false;
        }
      }
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

  // Dynamic self-learned price floor check
  const learnedFloor =
    learningEngine.getLearnedPriceFloor(query) || learningEngine.getLearnedPriceFloor(title);
  if (learnedFloor && price < learnedFloor) {
    return false;
  }

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
  if (isFlagshipPhone) {
    if ((q.includes('16 pro max') || q.includes('۱۶ پرو مکس')) && price < 150000000) return false;
    if ((q.includes('16 pro') || q.includes('۱۶ پرو')) && price < 130000000) return false;
    if ((q.includes('16') || q.includes('۱۶')) && price < 90000000) return false;
    if (price < 25000000) return false;
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
  if (!matchesBrand(title, query)) return 0;
  if (!matchesSubModel(title, query)) return 0;
  if (!matchesStorageCapacity(title, query)) return 0;
  if (!matchesProductSeries(title, query)) return 0;
  if (!matchesGenerationAndNumber(title, query)) return 0;
  if (!isPriceRealistic(title, price, query)) return 0;

  let score = 60;
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  // Exact Series match bonus
  for (const s of KNOWN_SERIES) {
    if (q.includes(s) && t.includes(s)) {
      score += 15;
      break;
    }
  }

  // Pro Max bonus
  if (q.includes('pro max') || q.includes('پرو مکس')) {
    if (t.includes('pro max') || t.includes('پرو مکس')) {
      score += 20;
    }
  }

  // Capacity match bonus
  const qCapMatch = q.match(/(?:^|\s)(64|128|256|512|1tb|2tb)(?:\s|$)/i);
  if (qCapMatch && t.includes(qCapMatch[1])) {
    score += 15;
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

Task: Select the EXACT matching product index (1-based), strictly filtering out accessories, ceiling speakers, fakes, wrong storage capacities, or wrong sub-models (e.g. Pro vs Pro Max vs base 16).
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
            matchesBrand(aiChosen.title, query) &&
            matchesSubModel(aiChosen.title, query) &&
            matchesStorageCapacity(aiChosen.title, query) &&
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
