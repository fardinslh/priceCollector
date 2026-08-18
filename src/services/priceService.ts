import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { priceCache } from './cacheService.js';

/**
 * Product result structure representing price and availability information across platforms.
 */
export interface ProductResult {
  source: 'Digikala' | 'Torob' | 'Technolife';
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
 * Multi-Query variation & transliteration dictionary for handling Persian spelling variations.
 */
const KEYWORD_SYNONYMS: [RegExp, string][] = [
  [/\bمک\s*بوک\b|\bمکبوک\b/gi, 'macbook'],
  [/\bایرپاد\b|\bایرفون\b/gi, 'airpods'],
  [/\bآیفون\b|\bایفون\b/gi, 'iphone'],
  [/\bآیپد\b|\bایپد\b/gi, 'ipad'],
  [/\bسامسونگ\b/gi, 'samsung'],
  [/\bشیائومی\b|\bشیاومی\b/gi, 'xiaomi'],
  [/\bپلی\s*استیشن\b|\bپلی‌استیشن\b|\bپلیستیشن\b/gi, 'playstation'],
  [/\bاپل\s*واچ\b|\bاپلواچ\b/gi, 'apple watch'],
  [/\bگلکسی\b/gi, 'galaxy'],
  [/\bهندزفری\b/gi, 'handsfree'],
  [/\bهدفون\b/gi, 'headphone'],
  [/\bساعت\s*هوشمند\b/gi, 'smartwatch'],
  [/\bلپ\s*تاپ\b|\bلپتاپ\b/gi, 'laptop'],
];

export function getQueryVariations(query: string): string[] {
  const trimmed = query.trim();
  const variations = new Set<string>([trimmed]);

  // 1. Space normalization (e.g. مکبوک -> مک بوک, لپتاپ -> لپ تاپ)
  const spaced = trimmed
    .replace(/مکبوک/g, 'مک بوک')
    .replace(/لپتاپ/g, 'لپ تاپ')
    .replace(/ایفون/g, 'آیفون')
    .replace(/ایپد/g, 'آیپد')
    .replace(/اپلواچ/g, 'اپل واچ')
    .replace(/پلیستیشن/g, 'پلی استیشن');
  variations.add(spaced);

  // 2. Transliterated / English conversion
  let englishTransliterated = trimmed;
  for (const [regex, replacement] of KEYWORD_SYNONYMS) {
    englishTransliterated = englishTransliterated.replace(regex, replacement);
  }
  if (englishTransliterated !== trimmed) {
    variations.add(englishTransliterated.replace(/\s+/g, ' ').trim());
  }

  // 3. Persian converted if user typed english (e.g. macbook -> مک بوک, iphone -> آیفون)
  const persianTransliterated = trimmed
    .replace(/\bmacbook\b/gi, 'مک بوک')
    .replace(/\bairpods\b/gi, 'ایرپاد')
    .replace(/\biphone\b/gi, 'آیفون')
    .replace(/\bipad\b/gi, 'آیپد')
    .replace(/\bsamsung\b/gi, 'سامسونگ')
    .replace(/\bxiaomi\b/gi, 'شیائومی')
    .replace(/\bplaystation\b/gi, 'پلی استیشن')
    .replace(/\bapple watch\b/gi, 'اپل واچ');
  if (persianTransliterated !== trimmed) {
    variations.add(persianTransliterated.replace(/\s+/g, ' ').trim());
  }

  return Array.from(variations).filter((q) => q.length > 0);
}

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

  // Check if query is looking for an accessory
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

  // Check chip / generation tags (e.g. m1, m2, m3, m4, m5)
  const chipPattern = /\b(m[1-9])\b/i;
  const queryChipMatch = normalizedQuery.match(chipPattern);
  if (queryChipMatch) {
    const requestedChip = queryChipMatch[1].toLowerCase();
    const titleChipMatch = normalizedTitle.match(chipPattern);
    if (titleChipMatch && titleChipMatch[1].toLowerCase() !== requestedChip) {
      // Conflicting generation found in title (e.g. requested M4 but title is M3)
      return false;
    }
  }

  // Check model number tags (e.g., iphone 13, 14, 15, 16 / s22, s23, s24)
  const modelNumPattern = /\b(\d{1,2}|s\d{2})\b/i;
  const queryModelMatch = normalizedQuery.match(modelNumPattern);
  if (queryModelMatch) {
    const requestedModel = queryModelMatch[1].toLowerCase();
    if (!normalizedTitle.includes(requestedModel)) {
      return false;
    }
  }

  // Title must contain at least one significant query token
  const matchedTokensCount = queryTokens.filter((token) => normalizedTitle.includes(token)).length;
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
  } else if (selectedProduct.url && typeof selectedProduct.url === 'object' && selectedProduct.url.uri) {
    productUrl = selectedProduct.url.uri.startsWith('http')
      ? selectedProduct.url.uri
      : `https://www.digikala.com${selectedProduct.url.uri.startsWith('/') ? '' : '/'}${selectedProduct.url.uri}`;
  } else if (selectedProduct.id) {
    productUrl = `https://www.digikala.com/product/dkp-${selectedProduct.id}/`;
  }

  const imageUrl =
    selectedProduct.images?.main?.url?.[0] || selectedProduct.images?.main?.webp_url?.[0] || undefined;

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
  const queryVariations = getQueryVariations(query);
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
  const apiUrl = `https://api.torob.com/v4/base-product/search/?query=${encodedQuery}&page=0&size=10`;

  const response = await axios.get(apiUrl, {
    headers: torobHeaders,
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const parsedData = TorobResponseSchema.safeParse(response.data);
  if (!parsedData.success || !parsedData.data.results.length) {
    return null;
  }

  const items = parsedData.data.results;
  const relevantItems = items.filter((item) => {
    const fullTitle = `${item.name1 || ''} ${item.name2 || ''}`.trim();
    return isRelevantProduct(fullTitle, query);
  });

  if (relevantItems.length === 0) {
    return null;
  }

  // Find FIRST item that is BOTH relevant and IN STOCK
  const inStockItem = relevantItems.find(
    (i) => (i.price || 0) > 0 && i.stock_status !== 'unavailable'
  );
  const selectedItem = inStockItem || relevantItems[0];

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
    `[priceService] [Torob] Found ${items.length} items (${relevantItems.length} relevant), selected ${isAvailable ? 'IN-STOCK' : 'OUT-OF-STOCK'} item: "${title.slice(0, 40)}..." at ${priceInTomans} Toman\n`
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
  const queryVariations = getQueryVariations(query);
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
   3. Technolife Service
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
  const apiUrl = `https://www.technolife.ir/api/v1/product/search?keyword=${encodedQuery}&page=1`;

  const response = await axios.get(apiUrl, {
    headers: technolifeHeaders,
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const parsedData = TechnolifeResponseSchema.safeParse(response.data);
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

  const relevantProducts = products.filter((p) => {
    const fullTitle = `${p.title || ''} ${p.name || ''} ${p.product_name || ''}`.trim();
    return isRelevantProduct(fullTitle, query);
  });

  if (relevantProducts.length === 0) {
    return null;
  }

  // Find FIRST product that is BOTH relevant and IN STOCK
  const inStockProduct = relevantProducts.find((p) => {
    const rawPrice = p.price || p.selling_price || p.discounted_price || 0;
    const numPrice =
      typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0 : rawPrice;
    return (p.is_available ?? p.available ?? p.in_stock ?? true) && numPrice > 0;
  });

  const selectedProduct = inStockProduct || relevantProducts[0];
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
    `[priceService] [Technolife] Found ${products.length} items (${relevantProducts.length} relevant), selected ${isAvailable ? 'IN-STOCK' : 'OUT-OF-STOCK'} item: "${title.slice(0, 40)}..." at ${priceInTomans} Toman\n`
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
  const queryVariations = getQueryVariations(query);
  for (const q of queryVariations) {
    try {
      const result = await fetchTechnolifeSingleQuery(q);
      if (result) return result;
    } catch (error: any) {
      process.stderr.write(
        `[priceService] [Technolife] Error fetching "${q}": ${error?.message || error} (status: ${error?.response?.status})\n`
      );
    }
  }
  return null;
}

/* ==========================================================================
   4. Price Aggregator (Returns Full 3-Store Matrix)
   ========================================================================== */

/**
 * Scrapes all supported Iranian e-commerce platforms concurrently.
 * Returns the FULL status matrix for all 3 stores (Digikala, Torob, Technolife),
 * with available items sorted ascending by price at the top, followed by unavailable stores.
 *
 * @param query Search keyword (e.g. "MacBook Air M4", "iPhone 15", "مکبوک پرو m3")
 * @returns Array containing entries for all 3 stores
 */
export async function compareAllPrices(query: string): Promise<ProductResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  // Check cache first for instant sub-second response
  const cached = priceCache.get(normalizedQuery);
  if (cached && Array.isArray(cached) && cached.length === 3) {
    return cached;
  }

  const settledResults = await Promise.allSettled([
    fetchDigikalaPrice(normalizedQuery),
    fetchTorobPrice(normalizedQuery),
    fetchTechnolifePrice(normalizedQuery),
  ]);

  const digikalaRes = settledResults[0].status === 'fulfilled' ? settledResults[0].value : null;
  const torobRes = settledResults[1].status === 'fulfilled' ? settledResults[1].value : null;
  const technolifeRes = settledResults[2].status === 'fulfilled' ? settledResults[2].value : null;

  const encodedQuery = encodeURIComponent(normalizedQuery);

  // Guarantee all 3 stores are populated in the matrix
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
      console.log(`\n📦 Status Matrix for all 3 Stores:\n`);

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
