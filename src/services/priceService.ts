import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { priceCache } from './cacheService.js';

/**
 * Product result structure representing price and availability information across platforms.
 */
export interface ProductResult {
  source: 'Digikala' | 'Torob' | 'Technolife' | 'Emalls' | 'SnappShop';
  title: string;
  price: number; // in Iranian Tomans
  formattedPrice: string; // Persian digits + "تومان"
  url: string;
  isAvailable: boolean;
  imageUrl?: string;
}

/**
 * Modern browser HTTP request configuration.
 */
const DEFAULT_TIMEOUT_MS = 7000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const commonHeaders = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

const digikalaHeaders = {
  ...commonHeaders,
  'Referer': 'https://www.digikala.com/',
  'Origin': 'https://www.digikala.com',
};

const torobHeaders = {
  ...commonHeaders,
  'Referer': 'https://torob.com/',
  'Origin': 'https://torob.com',
};

const technolifeHeaders = {
  ...commonHeaders,
  'Referer': 'https://www.technolife.ir/',
  'Origin': 'https://www.technolife.ir',
};

const emallsHeaders = {
  ...commonHeaders,
  'Referer': 'https://emalls.ir/',
  'Origin': 'https://emalls.ir',
};

const snappShopHeaders = {
  ...commonHeaders,
  'Referer': 'https://snappshop.ir/',
  'Origin': 'https://snappshop.ir',
};

/**
 * Convert English digits to Persian digits.
 */
export function toPersianDigits(input: number | string): string {
  const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  return input.toString().replace(/\d/g, (d) => persianDigits[parseInt(d, 10)]);
}

/**
 * Format a number in Tomans with Persian digits and the "تومان" suffix.
 */
export function formatTomanPrice(price: number): string {
  const formattedWithCommas = Math.round(price).toLocaleString('en-US');
  const persianDigitsWithCommas = toPersianDigits(formattedWithCommas);
  return `${persianDigitsWithCommas} تومان`;
}

/**
 * Common accessory keywords to avoid matching when searching for main devices.
 */
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

/**
 * Normalizes Persian/Arabic characters and English terms for accurate string matching.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[ة]/g, 'ه')
    .replace(/[\u200B-\u200D\uFEFF]/g, ' ') // zero-width spaces
    .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Smart bilingual query normalizer that generates English and Persian query variations,
 * prioritizing English tech model names for optimal indexing accuracy in Iranian e-commerce databases.
 */
export function normalizeSearchQueries(rawQuery: string): string[] {
  const trimmed = rawQuery.trim();
  if (!trimmed) return [];

  const variations = new Set<string>();

  // 1. Generate English translation / transliteration for tech & electronics
  let englishQuery = trimmed
    .replace(/(?:^|\s)(مک\s*بوک\s*پرو|مکبوک\s*پرو)(?:\s|$)/gi, ' MacBook Pro ')
    .replace(/(?:^|\s)(مک\s*بوک\s*ایر|مکبوک\s*ایر)(?:\s|$)/gi, ' MacBook Air ')
    .replace(/(?:^|\s)(مک\s*بوک|مکبوک)(?:\s|$)/gi, ' MacBook ')
    .replace(/(?:^|\s)(آیفون|ایفون)(?:\s|$)/gi, ' iPhone ')
    .replace(/(?:^|\s)(ایرپاد\s*پرو|ایرفون\s*پرو)(?:\s|$)/gi, ' AirPods Pro ')
    .replace(/(?:^|\s)(ایرپاد|ایرفون)(?:\s|$)/gi, ' AirPods ')
    .replace(/(?:^|\s)(آیپد\s*پرو|ایپد\s*پرو)(?:\s|$)/gi, ' iPad Pro ')
    .replace(/(?:^|\s)(آیپد\s*ایر|ایپد\s*ایر)(?:\s|$)/gi, ' iPad Air ')
    .replace(/(?:^|\s)(آیپد|ایپد)(?:\s|$)/gi, ' iPad ')
    .replace(/(?:^|\s)(اپل\s*واچ\s*اولترا|اپلواچ\s*اولترا)(?:\s|$)/gi, ' Apple Watch Ultra ')
    .replace(/(?:^|\s)(اپل\s*واچ|اپلواچ)(?:\s|$)/gi, ' Apple Watch ')
    .replace(/(?:^|\s)(سامسونگ\s*گلکسی|سامسونگ)(?:\s|$)/gi, ' Samsung Galaxy ')
    .replace(/(?:^|\s)(گلکسی)(?:\s|$)/gi, ' Galaxy ')
    .replace(/(?:^|\s)(اولترا|الترا)(?:\s|$)/gi, ' Ultra ')
    .replace(/(?:^|\s)(پرو\s*مکس)(?:\s|$)/gi, ' Pro Max ')
    .replace(/(?:^|\s)(پرو)(?:\s|$)/gi, ' Pro ')
    .replace(/(?:^|\s)(پلاس)(?:\s|$)/gi, ' Plus ')
    .replace(/(?:^|\s)(شیائومی|شیاومی)(?:\s|$)/gi, ' Xiaomi ')
    .replace(/(?:^|\s)(پلی\s*استیشن|پلی‌استیشن|پلیستیشن)(?:\s|$)/gi, ' PlayStation ')
    .replace(/(?:^|\s)(ردمی)(?:\s|$)/gi, ' Redmi ')
    .replace(/(?:^|\s)(پوکو)(?:\s|$)/gi, ' Poco ')
    .replace(/(?:^|\s)(تفال)(?:\s|$)/gi, ' Tefal ')
    .replace(/(?:^|\s)(فیلیپس)(?:\s|$)/gi, ' Philips ')
    .replace(/(?:^|\s)(بوش)(?:\s|$)/gi, ' Bosch ')
    .replace(/(?:^|\s)(براون)(?:\s|$)/gi, ' Braun ')
    .replace(/(?:^|\s)(پاناسونیک)(?:\s|$)/gi, ' Panasonic ')
    .replace(/(?:^|\s)(هندزفری|هدفون|گوشی)(?:\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // If an English variation was produced, place it first
  if (englishQuery && englishQuery !== trimmed) {
    variations.add(englishQuery);
  }

  // 2. Cleaned Persian variation (with standardized spaces)
  const persianNormalized = trimmed
    .replace(/مکبوک/g, 'مک بوک')
    .replace(/لپتاپ/g, 'لپ تاپ')
    .replace(/ایفون/g, 'آیفون')
    .replace(/ایپد/g, 'آیپد')
    .replace(/اپلواچ/g, 'اپل واچ')
    .replace(/پلیستیشن/g, 'پلی استیشن')
    .replace(/جاروبرقی/g, 'جارو برقی')
    .replace(/سرخکن/g, 'سرخ کن')
    .replace(/اتوبخار/g, 'اتو بخار')
    .replace(/\s+/g, ' ')
    .trim();

  variations.add(persianNormalized);
  variations.add(trimmed);

  return Array.from(variations).filter((q) => q.length > 0);
}

const BRAND_FAMILY_MAP: Record<string, string[]> = {
  iphone: ['iphone', 'ایفون', 'آیفون', 'apple', 'اپل'],
  macbook: ['macbook', 'مکبوک', 'مک بوک', 'apple', 'اپل'],
  airpods: ['airpods', 'ایرپاد', 'apple', 'اپل'],
  ipad: ['ipad', 'ایپد', 'آیپد', 'apple', 'اپل'],
  samsung: ['samsung', 'سامسونگ', 'galaxy', 'گلکسی'],
  xiaomi: ['xiaomi', 'شیائومی', 'شیاومی', 'redmi', 'ردمی', 'poco', 'پوکو'],
  playstation: ['playstation', 'پلی استیشن', 'پلی‌استیشن', 'ps4', 'ps5', 'sony', 'سونی'],
  tefal: ['tefal', 'تفال'],
  philips: ['philips', 'فیلیپس'],
  bosch: ['bosch', 'بوش'],
};

/**
 * Verifies that a product title is genuinely relevant to the user query,
 * preventing accidental matching of screen protectors, wrong generations, or irrelevant accessories.
 */
export function isRelevantProduct(title: string, query: string): boolean {
  if (!title || !query) return false;

  const normalizedTitle = normalizeText(title);
  const normalizedQuery = normalizeText(query);

  const queryTokens = normalizedQuery.split(' ').filter((t) => t.length > 1);
  if (queryTokens.length === 0) return true;

  // 1. Check if query is looking for an accessory
  const queryWantsAccessory = ACCESSORY_KEYWORDS.some((kw) =>
    normalizedQuery.includes(kw.toLowerCase())
  );

  // If user didn't ask for an accessory, reject titles that are accessory products
  if (!queryWantsAccessory) {
    const isAccessory = ACCESSORY_KEYWORDS.some((kw) => {
      const kwLower = kw.toLowerCase();
      const regex = new RegExp(`(^|\\s)${kwLower}(\\s|$)`, 'i');
      return regex.test(normalizedTitle);
    });

    if (isAccessory) {
      return false;
    }
  }

  // 2. Brand / Product family validation
  for (const [, aliases] of Object.entries(BRAND_FAMILY_MAP)) {
    const queryHasBrand = aliases.some((alias) => {
      const regex = new RegExp(`(^|\\s)${alias}(\\s|$)`, 'i');
      return regex.test(normalizedQuery);
    });

    if (queryHasBrand) {
      const titleHasBrand = aliases.some((alias) => {
        const regex = new RegExp(`(^|\\s)${alias}(\\s|$)`, 'i');
        return regex.test(normalizedTitle);
      });

      if (!titleHasBrand) {
        return false;
      }
    }
  }

  // 3. Check chip / generation tags (e.g. m1, m2, m3, m4, m5)
  const chipPattern = /(?:^|\s)(m[1-9])(?:\s|$)/i;
  const queryChipMatch = normalizedQuery.match(chipPattern);
  if (queryChipMatch) {
    const requestedChip = queryChipMatch[1].toLowerCase();
    const titleChipMatch = normalizedTitle.match(chipPattern);
    if (titleChipMatch && titleChipMatch[1].toLowerCase() !== requestedChip) {
      return false;
    }
  }

  // 4. Check model number tags (e.g., iphone 13, 14, 15, 16 / s22, s23, s24)
  const modelNumPattern = /(?:^|\s)(\d{1,2}|s\d{2})(?:\s|$)/i;
  const queryModelMatch = normalizedQuery.match(modelNumPattern);
  if (queryModelMatch) {
    const requestedModel = queryModelMatch[1].toLowerCase();
    const modelInTitleRegex = new RegExp(`(^|\\s)${requestedModel}(\\s|$)`, 'i');
    if (!modelInTitleRegex.test(normalizedTitle)) {
      return false;
    }
  }

  // 5. Title must contain at least one significant query token
  const matchedTokensCount = queryTokens.filter((token) => {
    const regex = new RegExp(`(^|\\s)${token}(\\s|$)`, 'i');
    return regex.test(normalizedTitle) || normalizedTitle.includes(token);
  }).length;

  return matchedTokensCount >= Math.min(queryTokens.length, 1);
}

/**
 * Helper to perform HTTP GET requests with custom headers, 7s timeout, and DigiCDN 307 cookie redirection support.
 */
async function fetchWithRedirection<T = any>(
  url: string,
  config: AxiosRequestConfig = {}
): Promise<AxiosResponse<T>> {
  const mergedConfig: AxiosRequestConfig = {
    timeout: DEFAULT_TIMEOUT_MS,
    headers: {
      ...digikalaHeaders,
      ...(config.headers || {}),
    },
    maxRedirects: 0,
    validateStatus: (status) => status < 400 || status === 301 || status === 302 || status === 307,
    ...config,
  };

  let response = await axios.get<T>(url, mergedConfig);

  // Handle DigiCDN 307 or 301/302 redirects with Set-Cookie preservation
  if (response.status === 307 || response.status === 302 || response.status === 301) {
    const rawCookies = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(rawCookies)
      ? rawCookies.map((c) => c.split(';')[0]).join('; ')
      : rawCookies
      ? String(rawCookies).split(';')[0]
      : '';

    const nextUrl = response.headers.location || url;
    response = await axios.get<T>(nextUrl, {
      ...mergedConfig,
      headers: {
        ...mergedConfig.headers,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  return response;
}

/* ==========================================================================
   1. Digikala Service
   ========================================================================== */

const DigikalaProductSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  title_fa: z.string().optional().nullable(),
  title_en: z.string().optional().nullable(),
  url: z
    .union([
      z.string(),
      z.object({
        uri: z.string().optional().nullable(),
      }),
    ])
    .optional()
    .nullable(),
  status: z.string().optional().nullable(),
  default_variant: z
    .object({
      price: z
        .object({
          selling_price: z.number().optional().nullable(),
          rrp_price: z.number().optional().nullable(),
        })
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
  images: z
    .object({
      main: z
        .object({
          url: z.array(z.string()).optional().nullable(),
          webp_url: z.array(z.string()).optional().nullable(),
        })
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
});

const DigikalaResponseSchema = z.object({
  status: z.number().optional().nullable(),
  data: z
    .object({
      products: z.array(DigikalaProductSchema).optional().default([]),
    })
    .optional()
    .default({ products: [] }),
});

async function fetchDigikalaSingleQuery(query: string): Promise<ProductResult | null> {
  const encodedQuery = encodeURIComponent(query.trim());
  const fallbackUrl = `https://www.digikala.com/search/?q=${encodedQuery}`;
  const apiUrl = `https://api.digikala.com/v1/search/?q=${encodedQuery}&page=1`;

  const response = await fetchWithRedirection(apiUrl, { headers: digikalaHeaders });
  const parsedData = DigikalaResponseSchema.safeParse(response.data);

  if (!parsedData.success || !parsedData.data.data.products.length) {
    return null;
  }

  const products = parsedData.data.data.products;

  // Filter relevant products that match the requested query
  const relevantProducts = products.filter((p) => {
    const fullTitle = `${p.title_fa || ''} ${p.title_en || ''}`.trim();
    return isRelevantProduct(fullTitle, query);
  });

  if (relevantProducts.length === 0) {
    return null;
  }

  // Pick first product that is BOTH relevant and IN STOCK
  const inStockProduct = relevantProducts.find((p) => {
    const rialPrice =
      p.default_variant?.price?.selling_price || p.default_variant?.price?.rrp_price || 0;
    return p.status === 'marketable' && rialPrice > 0;
  });

  const selectedProduct = inStockProduct || relevantProducts[0];
  const title = selectedProduct.title_fa || selectedProduct.title_en || query;

  const rialPrice =
    selectedProduct.default_variant?.price?.selling_price ||
    selectedProduct.default_variant?.price?.rrp_price ||
    0;
  const priceInTomans = Math.round(rialPrice / 10);
  const isAvailable = selectedProduct.status === 'marketable' && priceInTomans > 0;

  let productUrl = fallbackUrl;
  if (typeof selectedProduct.url === 'string' && selectedProduct.url.length > 0) {
    productUrl = selectedProduct.url.startsWith('http')
      ? selectedProduct.url
      : `https://www.digikala.com${selectedProduct.url.startsWith('/') ? '' : '/'}${selectedProduct.url}`;
  } else if (
    selectedProduct.url &&
    typeof selectedProduct.url === 'object' &&
    selectedProduct.url.uri
  ) {
    productUrl = selectedProduct.url.uri.startsWith('http')
      ? selectedProduct.url.uri
      : `https://www.digikala.com${selectedProduct.url.uri.startsWith('/') ? '' : '/'}${selectedProduct.url.uri}`;
  } else if (selectedProduct.id) {
    productUrl = `https://www.digikala.com/product/dkp-${selectedProduct.id}/`;
  }

  const imageUrl =
    selectedProduct.images?.main?.url?.[0] ||
    selectedProduct.images?.main?.webp_url?.[0] ||
    undefined;

  process.stderr.write(
    `[priceService] [Digikala] Found ${products.length} items (${relevantProducts.length} relevant), selected ${isAvailable ? 'IN-STOCK' : 'OUT-OF-STOCK'} item: "${title.slice(0, 40)}..." at ${priceInTomans} Toman\n`
  );

  return {
    source: 'Digikala',
    title,
    price: priceInTomans,
    formattedPrice: isAvailable ? formatTomanPrice(priceInTomans) : '❌ ناموجود / یافت نشد',
    url: productUrl,
    isAvailable,
    imageUrl,
  };
}

export async function fetchDigikalaPrice(query: string): Promise<ProductResult | null> {
  const queryVariations = normalizeSearchQueries(query);
  for (const q of queryVariations) {
    try {
      const result = await fetchDigikalaSingleQuery(q);
      if (result) return result;
    } catch (error: any) {
      process.stderr.write(
        `[priceService] [Digikala] Error fetching "${q}": ${error?.message || error} (status: ${error?.response?.status})\n`
      );
    }
  }
  return null;
}

/* ==========================================================================
   2. Torob Service
   ========================================================================== */

const TorobItemSchema = z.object({
  name1: z.string().optional().nullable(),
  name2: z.string().optional().nullable(),
  price: z.number().optional().nullable(),
  price_text: z.string().optional().nullable(),
  web_client_absolute_url: z.string().optional().nullable(),
  more_info_url: z.string().optional().nullable(),
  stock_status: z.string().optional().nullable(),
  image_url: z.string().optional().nullable(),
  media_urls: z
    .array(
      z.object({
        url: z.string().optional().nullable(),
      })
    )
    .optional()
    .nullable(),
});

const TorobResponseSchema = z.object({
  results: z.array(TorobItemSchema).optional().default([]),
});

async function fetchTorobSingleQuery(query: string): Promise<ProductResult | null> {
  const encodedQuery = encodeURIComponent(query.trim());
  const fallbackUrl = `https://torob.com/search/?query=${encodedQuery}`;
  const apiUrl = `https://api.torob.com/v4/base-product/search/?q=${encodedQuery}&query=${encodedQuery}&page=0&size=10`;

  const response = await axios.get(apiUrl, {
    headers: torobHeaders,
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const parsedData = TorobResponseSchema.safeParse(response.data);
  if (!parsedData.success || !parsedData.data.results.length) {
    return null;
  }

  const items = parsedData.data.results;
  process.stderr.write(`[Torob] Found ${items.length} items for "${query}":\n`);
  items.forEach((it, idx) => {
    const fullTitle = `${it.name1 || ''} ${it.name2 || ''}`.trim();
    process.stderr.write(
      `  [${idx + 1}] ${fullTitle.slice(0, 45)}... -> ${it.price || 0} Toman (${it.stock_status || 'available'})\n`
    );
  });

  const relevantItems = items.filter((item) => {
    const fullTitle = `${item.name1 || ''} ${item.name2 || ''}`.trim();
    return isRelevantProduct(fullTitle, query) && (item.price || 0) > 0;
  });

  // 1. Pick FIRST item that is BOTH relevant and IN STOCK
  let selectedItem: (typeof items)[number] | undefined =
    relevantItems.find((i) => (i.price || 0) > 0 && i.stock_status !== 'unavailable') ||
    relevantItems[0];

  // 2. Fallback: If strict filter didn't match, pick the 1st in-stock item from Torob results
  if (!selectedItem) {
    selectedItem = items.find(
      (item) => (item.price || 0) > 0 && item.stock_status !== 'unavailable'
    );
  }

  if (!selectedItem) {
    process.stderr.write(`[Torob] No valid in-stock items found for "${query}"\n`);
    return null;
  }

  const title = selectedItem.name1 || selectedItem.name2 || query;
  const priceInTomans = selectedItem.price || 0;
  const isAvailable = priceInTomans > 0 && selectedItem.stock_status !== 'unavailable';

  let productUrl = fallbackUrl;
  if (selectedItem.web_client_absolute_url) {
    productUrl = selectedItem.web_client_absolute_url.startsWith('http')
      ? selectedItem.web_client_absolute_url
      : `https://torob.com${selectedItem.web_client_absolute_url.startsWith('/') ? '' : '/'}${selectedItem.web_client_absolute_url}`;
  } else if (selectedItem.more_info_url) {
    productUrl = selectedItem.more_info_url;
  }

  const imageUrl = selectedItem.image_url || selectedItem.media_urls?.[0]?.url || undefined;

  process.stderr.write(
    `[priceService] [Torob] Selected ${isAvailable ? 'IN-STOCK' : 'OUT-OF-STOCK'} item: "${title.slice(0, 40)}..." at ${priceInTomans} Toman\n`
  );

  return {
    source: 'Torob',
    title,
    price: priceInTomans,
    formattedPrice: isAvailable ? formatTomanPrice(priceInTomans) : '❌ ناموجود / یافت نشد',
    url: productUrl,
    isAvailable,
    imageUrl,
  };
}

export async function fetchTorobPrice(query: string): Promise<ProductResult | null> {
  const queryVariations = normalizeSearchQueries(query);
  for (const q of queryVariations) {
    try {
      const result = await fetchTorobSingleQuery(q);
      if (result) return result;
    } catch (error: any) {
      process.stderr.write(
        `[priceService] [Torob] Error fetching "${q}": ${error?.message || error} (status: ${error?.response?.status})\n`
      );
    }
  }
  return null;
}

/* ==========================================================================
   3. Emalls Service
   ========================================================================== */

const EmallsProductSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  title: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
  title_fa: z.string().optional().nullable(),
  price: z.union([z.number(), z.string()]).optional().nullable(),
  min_price: z.union([z.number(), z.string()]).optional().nullable(),
  url: z.string().optional().nullable(),
  link: z.string().optional().nullable(),
  image: z.string().optional().nullable(),
  image_url: z.string().optional().nullable(),
  is_available: z.boolean().optional().nullable(),
  in_stock: z.boolean().optional().nullable(),
});

const EmallsResponseSchema = z.object({
  results: z.array(EmallsProductSchema).optional(),
  data: z
    .union([
      z.array(EmallsProductSchema),
      z.object({ products: z.array(EmallsProductSchema).optional() }),
    ])
    .optional(),
  products: z.array(EmallsProductSchema).optional(),
});

async function fetchEmallsSingleQuery(query: string): Promise<ProductResult | null> {
  const encodedQuery = encodeURIComponent(query.trim());
  const fallbackUrl = `https://emalls.ir/Search.aspx?query=${encodedQuery}`;

  const endpoints = [
    `https://api.emalls.ir/api/v1/search?query=${encodedQuery}&page=1`,
    `https://emalls.ir/api/products/search?title=${encodedQuery}`,
  ];

  let responseData: any = null;

  for (const endpoint of endpoints) {
    try {
      const response = await axios.get(endpoint, {
        headers: emallsHeaders,
        timeout: DEFAULT_TIMEOUT_MS,
      });
      if (response.data) {
        responseData = response.data;
        break;
      }
    } catch {
      // Continue trying fallback endpoints
    }
  }

  if (!responseData) {
    process.stderr.write(`[Emalls] Unavailable\n`);
    return null;
  }

  const parsedData = EmallsResponseSchema.safeParse(responseData);
  if (!parsedData.success) {
    return null;
  }

  let products: z.infer<typeof EmallsProductSchema>[] = [];
  if (parsedData.data.results && parsedData.data.results.length > 0) {
    products = parsedData.data.results;
  } else if (Array.isArray(parsedData.data.data)) {
    products = parsedData.data.data;
  } else if (
    parsedData.data.data &&
    typeof parsedData.data.data === 'object' &&
    parsedData.data.data.products
  ) {
    products = parsedData.data.data.products;
  } else if (parsedData.data.products && parsedData.data.products.length > 0) {
    products = parsedData.data.products;
  }

  if (!products.length) {
    return null;
  }

  process.stderr.write(`[Emalls] Found ${products.length} items for "${query}"\n`);

  const relevantProducts = products.filter((p) => {
    const fullTitle = `${p.title || ''} ${p.name || ''} ${p.title_fa || ''}`.trim();
    return isRelevantProduct(fullTitle, query);
  });

  const inStockProduct = relevantProducts.find((p) => {
    const rawPrice = p.price || p.min_price || 0;
    const numPrice =
      typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0 : rawPrice;
    return (p.is_available ?? p.in_stock ?? true) && numPrice > 0;
  });

  const selectedProduct = inStockProduct || relevantProducts[0] || products[0];
  if (!selectedProduct) {
    return null;
  }

  const title =
    selectedProduct.title || selectedProduct.name || selectedProduct.title_fa || query;

  const rawPrice = selectedProduct.price || selectedProduct.min_price || 0;
  const numericPrice =
    typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0 : rawPrice;

  const priceInTomans = Math.round(numericPrice);
  const isAvailable =
    (selectedProduct.is_available ?? selectedProduct.in_stock ?? true) && priceInTomans > 0;

  let productUrl = fallbackUrl;
  const rawUrl = selectedProduct.url || selectedProduct.link;
  if (rawUrl) {
    productUrl = rawUrl.startsWith('http')
      ? rawUrl
      : `https://emalls.ir${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
  } else if (selectedProduct.id) {
    productUrl = `https://emalls.ir/مشخصات_کالا~${selectedProduct.id}`;
  }

  const imageUrl = selectedProduct.image_url || selectedProduct.image || undefined;

  process.stderr.write(
    `[priceService] [Emalls] Selected ${isAvailable ? 'IN-STOCK' : 'OUT-OF-STOCK'} item: "${title.slice(0, 40)}..." at ${priceInTomans} Toman\n`
  );

  return {
    source: 'Emalls',
    title,
    price: priceInTomans,
    formattedPrice: isAvailable ? formatTomanPrice(priceInTomans) : '❌ ناموجود / یافت نشد',
    url: productUrl,
    isAvailable,
    imageUrl,
  };
}

export async function fetchEmallsPrice(query: string): Promise<ProductResult | null> {
  const queryVariations = normalizeSearchQueries(query);
  for (const q of queryVariations) {
    try {
      const result = await fetchEmallsSingleQuery(q);
      if (result) return result;
    } catch {
      // Endpoint unavailable
    }
  }
  return null;
}

/* ==========================================================================
   4. SnappShop Service
   ========================================================================== */

const SnappShopProductSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  title: z.string().optional().nullable(),
  title_fa: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
  price: z.union([z.number(), z.string()]).optional().nullable(),
  selling_price: z.union([z.number(), z.string()]).optional().nullable(),
  discounted_price: z.union([z.number(), z.string()]).optional().nullable(),
  final_price: z.union([z.number(), z.string()]).optional().nullable(),
  price_toman: z.union([z.number(), z.string()]).optional().nullable(),
  slug: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
  is_available: z.boolean().optional().nullable(),
  in_stock: z.boolean().optional().nullable(),
  image: z.string().optional().nullable(),
  image_url: z.string().optional().nullable(),
});

const SnappShopResponseSchema = z.object({
  results: z.array(SnappShopProductSchema).optional(),
  data: z
    .union([
      z.array(SnappShopProductSchema),
      z.object({
        products: z.array(SnappShopProductSchema).optional(),
        items: z.array(SnappShopProductSchema).optional(),
      }),
    ])
    .optional(),
  products: z.array(SnappShopProductSchema).optional(),
});

async function fetchSnappShopSingleQuery(query: string): Promise<ProductResult | null> {
  const encodedQuery = encodeURIComponent(query.trim());
  const fallbackUrl = `https://snappshop.ir/search?q=${encodedQuery}`;

  const endpoints = [
    `https://api.snappshop.ir/api/v1/search/products?query=${encodedQuery}&page=1`,
    `https://api.snappshop.ir/api/v2/search/products?query=${encodedQuery}`,
  ];

  let responseData: any = null;

  for (const endpoint of endpoints) {
    try {
      const response = await axios.get(endpoint, {
        headers: snappShopHeaders,
        timeout: DEFAULT_TIMEOUT_MS,
      });
      if (response.data) {
        responseData = response.data;
        break;
      }
    } catch {
      // Continue trying fallback endpoints
    }
  }

  if (!responseData) {
    process.stderr.write(`[SnappShop] Unavailable\n`);
    return null;
  }

  const parsedData = SnappShopResponseSchema.safeParse(responseData);
  if (!parsedData.success) {
    return null;
  }

  let products: z.infer<typeof SnappShopProductSchema>[] = [];
  if (parsedData.data.results && parsedData.data.results.length > 0) {
    products = parsedData.data.results;
  } else if (Array.isArray(parsedData.data.data)) {
    products = parsedData.data.data;
  } else if (
    parsedData.data.data &&
    typeof parsedData.data.data === 'object' &&
    parsedData.data.data.products
  ) {
    products = parsedData.data.data.products;
  } else if (
    parsedData.data.data &&
    typeof parsedData.data.data === 'object' &&
    parsedData.data.data.items
  ) {
    products = parsedData.data.data.items;
  } else if (parsedData.data.products && parsedData.data.products.length > 0) {
    products = parsedData.data.products;
  }

  if (!products.length) {
    return null;
  }

  process.stderr.write(`[SnappShop] Found ${products.length} items for "${query}"\n`);

  const relevantProducts = products.filter((p) => {
    const fullTitle = `${p.title || ''} ${p.title_fa || ''} ${p.name || ''}`.trim();
    return isRelevantProduct(fullTitle, query);
  });

  const inStockProduct = relevantProducts.find((p) => {
    const rawPrice =
      p.price_toman ||
      p.selling_price ||
      p.discounted_price ||
      p.final_price ||
      p.price ||
      0;
    const numPrice =
      typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0 : rawPrice;
    return (p.is_available ?? p.in_stock ?? true) && numPrice > 0;
  });

  const selectedProduct = inStockProduct || relevantProducts[0] || products[0];
  if (!selectedProduct) {
    return null;
  }

  const title =
    selectedProduct.title || selectedProduct.title_fa || selectedProduct.name || query;

  const rawPrice =
    selectedProduct.price_toman ||
    selectedProduct.selling_price ||
    selectedProduct.discounted_price ||
    selectedProduct.final_price ||
    selectedProduct.price ||
    0;
  let numericPrice =
    typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0 : rawPrice;

  // Convert Rials to Tomans if not labeled as price_toman and realistic value suggests Rials
  if (!selectedProduct.price_toman && numericPrice > 500000000) {
    numericPrice = numericPrice / 10;
  }

  const priceInTomans = Math.round(numericPrice);
  const isAvailable =
    (selectedProduct.is_available ?? selectedProduct.in_stock ?? true) && priceInTomans > 0;

  let productUrl = fallbackUrl;
  if (selectedProduct.url) {
    productUrl = selectedProduct.url.startsWith('http')
      ? selectedProduct.url
      : `https://snappshop.ir${selectedProduct.url.startsWith('/') ? '' : '/'}${selectedProduct.url}`;
  } else if (selectedProduct.slug) {
    productUrl = `https://snappshop.ir/product/${selectedProduct.slug}`;
  } else if (selectedProduct.id) {
    productUrl = `https://snappshop.ir/product/${selectedProduct.id}`;
  }

  const imageUrl = selectedProduct.image_url || selectedProduct.image || undefined;

  process.stderr.write(
    `[priceService] [SnappShop] Selected ${isAvailable ? 'IN-STOCK' : 'OUT-OF-STOCK'} item: "${title.slice(0, 40)}..." at ${priceInTomans} Toman\n`
  );

  return {
    source: 'SnappShop',
    title,
    price: priceInTomans,
    formattedPrice: isAvailable ? formatTomanPrice(priceInTomans) : '❌ ناموجود / یافت نشد',
    url: productUrl,
    isAvailable,
    imageUrl,
  };
}

export async function fetchSnappShopPrice(query: string): Promise<ProductResult | null> {
  const queryVariations = normalizeSearchQueries(query);
  for (const q of queryVariations) {
    try {
      const result = await fetchSnappShopSingleQuery(q);
      if (result) return result;
    } catch {
      // Endpoint unavailable
    }
  }
  return null;
}

/* ==========================================================================
   5. Technolife Service
   ========================================================================== */

const TechnolifeProductSchema = z.object({
  title: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
  product_name: z.string().optional().nullable(),
  price: z.union([z.number(), z.string()]).optional().nullable(),
  selling_price: z.union([z.number(), z.string()]).optional().nullable(),
  discounted_price: z.union([z.number(), z.string()]).optional().nullable(),
  url: z.string().optional().nullable(),
  slug: z.string().optional().nullable(),
  code: z.string().optional().nullable(),
  is_available: z.boolean().optional().nullable(),
  available: z.boolean().optional().nullable(),
  in_stock: z.boolean().optional().nullable(),
  image: z.string().optional().nullable(),
  image_url: z.string().optional().nullable(),
});

const TechnolifeResponseSchema = z.object({
  results: z.array(TechnolifeProductSchema).optional(),
  data: z
    .union([
      z.array(TechnolifeProductSchema),
      z.object({ products: z.array(TechnolifeProductSchema).optional() }),
    ])
    .optional(),
  products: z.array(TechnolifeProductSchema).optional(),
});

async function fetchTechnolifeSingleQuery(query: string): Promise<ProductResult | null> {
  const encodedQuery = encodeURIComponent(query.trim());
  const fallbackUrl = `https://www.technolife.ir/product/search?keyword=${encodedQuery}`;

  const endpoints = [
    `https://api.technolife.ir/api/v1/search?keyword=${encodedQuery}`,
    `https://www.technolife.ir/api/v1/products/search?keyword=${encodedQuery}`,
    `https://api.technolife.ir/api/v1/products/search?keyword=${encodedQuery}`,
  ];

  let responseData: any = null;

  for (const endpoint of endpoints) {
    try {
      const response = await axios.get(endpoint, {
        headers: technolifeHeaders,
        timeout: DEFAULT_TIMEOUT_MS,
      });
      if (response.data) {
        responseData = response.data;
        break;
      }
    } catch {
      // Continue trying fallback endpoints
    }
  }

  if (!responseData) {
    process.stderr.write(`[Technolife] Unavailable\n`);
    return null;
  }

  const parsedData = TechnolifeResponseSchema.safeParse(responseData);
  if (!parsedData.success) {
    return null;
  }

  let products: z.infer<typeof TechnolifeProductSchema>[] = [];
  if (parsedData.data.results && parsedData.data.results.length > 0) {
    products = parsedData.data.results;
  } else if (Array.isArray(parsedData.data.data)) {
    products = parsedData.data.data;
  } else if (
    parsedData.data.data &&
    typeof parsedData.data.data === 'object' &&
    parsedData.data.data.products
  ) {
    products = parsedData.data.data.products;
  } else if (parsedData.data.products && parsedData.data.products.length > 0) {
    products = parsedData.data.products;
  }

  if (!products.length) {
    return null;
  }

  process.stderr.write(`[Technolife] Found ${products.length} items for "${query}"\n`);

  const relevantProducts = products.filter((p) => {
    const fullTitle = `${p.title || ''} ${p.name || ''} ${p.product_name || ''}`.trim();
    return isRelevantProduct(fullTitle, query);
  });

  const inStockProduct = relevantProducts.find((p) => {
    const rawPrice = p.price || p.selling_price || p.discounted_price || 0;
    const numPrice =
      typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0 : rawPrice;
    return (p.is_available ?? p.available ?? p.in_stock ?? true) && numPrice > 0;
  });

  const selectedProduct = inStockProduct || relevantProducts[0] || products[0];
  if (!selectedProduct) {
    return null;
  }

  const title =
    selectedProduct.title || selectedProduct.name || selectedProduct.product_name || query;

  const rawPrice =
    selectedProduct.price || selectedProduct.selling_price || selectedProduct.discounted_price || 0;
  const numericPrice =
    typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0 : rawPrice;

  const priceInTomans = Math.round(numericPrice);
  const isAvailable =
    (selectedProduct.is_available ??
      selectedProduct.available ??
      selectedProduct.in_stock ??
      true) &&
    priceInTomans > 0;

  let productUrl = fallbackUrl;
  if (selectedProduct.url) {
    productUrl = selectedProduct.url.startsWith('http')
      ? selectedProduct.url
      : `https://www.technolife.ir${selectedProduct.url.startsWith('/') ? '' : '/'}${selectedProduct.url}`;
  } else if (selectedProduct.code || selectedProduct.slug) {
    productUrl = `https://www.technolife.ir/product-${selectedProduct.code || selectedProduct.slug}`;
  }

  const imageUrl = selectedProduct.image_url || selectedProduct.image || undefined;

  process.stderr.write(
    `[priceService] [Technolife] Selected ${isAvailable ? 'IN-STOCK' : 'OUT-OF-STOCK'} item: "${title.slice(0, 40)}..." at ${priceInTomans} Toman\n`
  );

  return {
    source: 'Technolife',
    title,
    price: priceInTomans,
    formattedPrice: isAvailable ? formatTomanPrice(priceInTomans) : '❌ ناموجود / یافت نشد',
    url: productUrl,
    isAvailable,
    imageUrl,
  };
}

export async function fetchTechnolifePrice(query: string): Promise<ProductResult | null> {
  const queryVariations = normalizeSearchQueries(query);
  for (const q of queryVariations) {
    try {
      const result = await fetchTechnolifeSingleQuery(q);
      if (result) return result;
    } catch {
      // Endpoint unavailable
    }
  }
  return null;
}

/* ==========================================================================
   6. Price Aggregator (Returns Full 5-Store Matrix)
   ========================================================================== */

/**
 * Scrapes all supported Iranian e-commerce platforms concurrently:
 * Digikala, Torob, Emalls, SnappShop, and Technolife.
 * Returns the FULL status matrix for all 5 stores,
 * with available items sorted ascending by price at the top, followed by unavailable stores.
 *
 * @param query Search keyword (e.g. "MacBook Air M4", "اتو بخار تفال", "جاروبرقی فیلیپس")
 * @returns Array containing entries for all 5 stores
 */
export async function compareAllPrices(query: string): Promise<ProductResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  // Check cache first for instant sub-second response
  const cached = priceCache.get(normalizedQuery);
  if (cached && Array.isArray(cached) && cached.length === 5) {
    return cached;
  }

  process.stderr.write(
    `[priceService] Starting parallel price search for "${normalizedQuery}" across Digikala, Torob, Emalls, SnappShop, and Technolife...\n`
  );

  const settledResults = await Promise.allSettled([
    fetchDigikalaPrice(normalizedQuery),
    fetchTorobPrice(normalizedQuery),
    fetchEmallsPrice(normalizedQuery),
    fetchSnappShopPrice(normalizedQuery),
    fetchTechnolifePrice(normalizedQuery),
  ]);

  const digikalaRes = settledResults[0].status === 'fulfilled' ? settledResults[0].value : null;
  const torobRes = settledResults[1].status === 'fulfilled' ? settledResults[1].value : null;
  const emallsRes = settledResults[2].status === 'fulfilled' ? settledResults[2].value : null;
  const snappShopRes = settledResults[3].status === 'fulfilled' ? settledResults[3].value : null;
  const technolifeRes = settledResults[4].status === 'fulfilled' ? settledResults[4].value : null;

  process.stderr.write(
    `[priceService] Parallel search finished for "${normalizedQuery}": Digikala=${digikalaRes?.isAvailable ? digikalaRes.formattedPrice : 'Out of Stock'}, Torob=${torobRes?.isAvailable ? torobRes.formattedPrice : 'Out of Stock'}, Emalls=${emallsRes?.isAvailable ? emallsRes.formattedPrice : 'Out of Stock'}, SnappShop=${snappShopRes?.isAvailable ? snappShopRes.formattedPrice : 'Out of Stock'}, Technolife=${technolifeRes?.isAvailable ? technolifeRes.formattedPrice : 'Out of Stock'}\n`
  );

  const encodedQuery = encodeURIComponent(normalizedQuery);

  // Guarantee all 5 stores are populated in the matrix
  const fullMatrix: ProductResult[] = [
    digikalaRes || {
      source: 'Digikala',
      title: 'ناموجود / یافت نشد',
      price: 0,
      formattedPrice: '❌ ناموجود / یافت نشد',
      url: `https://www.digikala.com/search/?q=${encodedQuery}`,
      isAvailable: false,
    },
    torobRes || {
      source: 'Torob',
      title: 'ناموجود / یافت نشد',
      price: 0,
      formattedPrice: '❌ ناموجود / یافت نشد',
      url: `https://torob.com/search/?query=${encodedQuery}`,
      isAvailable: false,
    },
    emallsRes || {
      source: 'Emalls',
      title: 'ناموجود / یافت نشد',
      price: 0,
      formattedPrice: '❌ ناموجود / یافت نشد',
      url: `https://emalls.ir/Search.aspx?query=${encodedQuery}`,
      isAvailable: false,
    },
    snappShopRes || {
      source: 'SnappShop',
      title: 'ناموجود / یافت نشد',
      price: 0,
      formattedPrice: '❌ ناموجود / یافت نشد',
      url: `https://snappshop.ir/search?q=${encodedQuery}`,
      isAvailable: false,
    },
    technolifeRes || {
      source: 'Technolife',
      title: 'ناموجود / یافت نشد',
      price: 0,
      formattedPrice: '❌ ناموجود / یافت نشد',
      url: `https://www.technolife.ir/product/search?keyword=${encodedQuery}`,
      isAvailable: false,
    },
  ];

  // Separate available and unavailable stores
  const availableStores = fullMatrix
    .filter((s) => s.isAvailable && s.price > 0)
    .sort((a, b) => a.price - b.price);

  const unavailableStores = fullMatrix.filter((s) => !s.isAvailable || s.price <= 0);

  // Combine: Available lowest-price first, followed by out-of-stock stores
  const finalResults = [...availableStores, ...unavailableStores];

  // Cache results for 15 minutes
  priceCache.set(normalizedQuery, finalResults);

  return finalResults;
}

/* ==========================================================================
   CLI Execution entry point
   ========================================================================== */

const isMainModule =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === process.argv[1] ||
    process.argv[1].endsWith('priceService.ts') ||
    process.argv[1].endsWith('priceService.js'));

if (isMainModule) {
  const searchTarget = process.argv[2] || 'AirPods Pro 2';
  console.log(`\n🔍 Searching Iranian stores for: "${searchTarget}"...\n`);

  compareAllPrices(searchTarget)
    .then((results) => {
      console.log(`\n📦 Status Matrix for all 5 Stores:\n`);

      console.table(
        results.map((r, idx) => ({
          '#': idx + 1,
          Store: r.source,
          Status: r.isAvailable ? '✅ In Stock' : '❌ Out of Stock',
          'Price (Toman)': r.formattedPrice,
          Title: r.title.length > 50 ? `${r.title.slice(0, 47)}...` : r.title,
          URL: r.url,
        }))
      );

      console.log('\n📦 Detailed JSON Output:');
      console.log(JSON.stringify(results, null, 2));
    })
    .catch((err) => {
      console.error('Error comparing prices:', err);
    });
}
