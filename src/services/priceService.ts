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

const baseHeaders = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://www.google.com/',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
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

  // If user didn't ask for an accessory, reject titles that start with or are accessory products
  if (!queryWantsAccessory) {
    const isAccessory = ACCESSORY_KEYWORDS.some((kw) => {
      const kwLower = kw.toLowerCase();
      // Match accessory keyword as full word or at start
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
      ...baseHeaders,
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

export async function fetchDigikalaPrice(query: string): Promise<ProductResult | null> {
  const encodedQuery = encodeURIComponent(query.trim());
  const fallbackUrl = `https://www.digikala.com/search/?q=${encodedQuery}`;

  try {
    const apiUrl = `https://api.digikala.com/v1/search/?q=${encodedQuery}&page=1`;
    const response = await fetchWithRedirection(apiUrl);
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

    // Pick first marketable matching product
    const product = relevantProducts.find((p) => p.status === 'marketable') || relevantProducts[0];
    const title = product.title_fa || product.title_en || query;

    const rialPrice =
      product.default_variant?.price?.selling_price ||
      product.default_variant?.price?.rrp_price ||
      0;
    const priceInTomans = Math.round(rialPrice / 10);
    const isAvailable = product.status === 'marketable' && priceInTomans > 0;

    let productUrl = fallbackUrl;
    if (typeof product.url === 'string' && product.url.length > 0) {
      productUrl = product.url.startsWith('http')
        ? product.url
        : `https://www.digikala.com${product.url.startsWith('/') ? '' : '/'}${product.url}`;
    } else if (product.url && typeof product.url === 'object' && product.url.uri) {
      productUrl = product.url.uri.startsWith('http')
        ? product.url.uri
        : `https://www.digikala.com${product.url.uri.startsWith('/') ? '' : '/'}${product.url.uri}`;
    } else if (product.id) {
      productUrl = `https://www.digikala.com/product/dkp-${product.id}/`;
    }

    const imageUrl =
      product.images?.main?.url?.[0] || product.images?.main?.webp_url?.[0] || undefined;

    return {
      source: 'Digikala',
      title,
      price: priceInTomans,
      formattedPrice: isAvailable ? formatTomanPrice(priceInTomans) : '❌ ناموجود / یافت نشد',
      url: productUrl,
      isAvailable,
      imageUrl,
    };
  } catch (error: any) {
    process.stderr.write(
      `[priceService] [Digikala] Error fetching "${query}": ${error?.message || error} (status: ${error?.response?.status})\n`
    );
    return null;
  }
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

export async function fetchTorobPrice(query: string): Promise<ProductResult | null> {
  const encodedQuery = encodeURIComponent(query.trim());
  const fallbackUrl = `https://torob.com/search/?query=${encodedQuery}`;

  try {
    // Note: Do NOT use sort=price to avoid matching cheap accessories instead of main devices
    const apiUrl = `https://api.torob.com/v4/base-product/search/?query=${encodedQuery}&page=0&size=10`;

    const response = await axios.get(apiUrl, {
      headers: baseHeaders,
      timeout: DEFAULT_TIMEOUT_MS,
    });

    const parsedData = TorobResponseSchema.safeParse(response.data);
    if (!parsedData.success || !parsedData.data.results.length) {
      return null;
    }

    const items = parsedData.data.results;

    // Filter relevant products
    const relevantItems = items.filter((item) => {
      const fullTitle = `${item.name1 || ''} ${item.name2 || ''}`.trim();
      return isRelevantProduct(fullTitle, query);
    });

    if (relevantItems.length === 0) {
      return null;
    }

    // Pick top relevant item with price
    const item = relevantItems.find((i) => (i.price || 0) > 0) || relevantItems[0];
    const title = item.name1 || item.name2 || query;
    const priceInTomans = item.price || 0;
    const isAvailable = priceInTomans > 0 && item.stock_status !== 'unavailable';

    let productUrl = fallbackUrl;
    if (item.web_client_absolute_url) {
      productUrl = item.web_client_absolute_url.startsWith('http')
        ? item.web_client_absolute_url
        : `https://torob.com${item.web_client_absolute_url.startsWith('/') ? '' : '/'}${item.web_client_absolute_url}`;
    } else if (item.more_info_url) {
      productUrl = item.more_info_url;
    }

    const imageUrl = item.image_url || item.media_urls?.[0]?.url || undefined;

    return {
      source: 'Torob',
      title,
      price: priceInTomans,
      formattedPrice: isAvailable ? formatTomanPrice(priceInTomans) : '❌ ناموجود / یافت نشد',
      url: productUrl,
      isAvailable,
      imageUrl,
    };
  } catch (error: any) {
    process.stderr.write(
      `[priceService] [Torob] Error fetching "${query}": ${error?.message || error} (status: ${error?.response?.status})\n`
    );
    return null;
  }
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

export async function fetchTechnolifePrice(query: string): Promise<ProductResult | null> {
  const encodedQuery = encodeURIComponent(query.trim());
  const fallbackUrl = `https://www.technolife.ir/product/search?keyword=${encodedQuery}`;

  try {
    const apiUrl = `https://www.technolife.ir/api/v1/product/search?keyword=${encodedQuery}&page=1`;

    const response = await axios.get(apiUrl, {
      headers: baseHeaders,
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

    const product = relevantProducts[0];
    const title = product.title || product.name || product.product_name || query;

    const rawPrice = product.price || product.selling_price || product.discounted_price || 0;
    const numericPrice =
      typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0 : rawPrice;

    const priceInTomans = Math.round(numericPrice);
    const isAvailable =
      (product.is_available ?? product.available ?? product.in_stock ?? true) && priceInTomans > 0;

    let productUrl = fallbackUrl;
    if (product.url) {
      productUrl = product.url.startsWith('http')
        ? product.url
        : `https://www.technolife.ir${product.url.startsWith('/') ? '' : '/'}${product.url}`;
    } else if (product.code || product.slug) {
      productUrl = `https://www.technolife.ir/product-${product.code || product.slug}`;
    }

    const imageUrl = product.image_url || product.image || undefined;

    return {
      source: 'Technolife',
      title,
      price: priceInTomans,
      formattedPrice: isAvailable ? formatTomanPrice(priceInTomans) : '❌ ناموجود / یافت نشد',
      url: productUrl,
      isAvailable,
      imageUrl,
    };
  } catch (error: any) {
    process.stderr.write(
      `[priceService] [Technolife] Error fetching "${query}": ${error?.message || error} (status: ${error?.response?.status})\n`
    );
    return null;
  }
}

/* ==========================================================================
   4. Price Aggregator (Returns Full 3-Store Matrix)
   ========================================================================== */

/**
 * Scrapes all supported Iranian e-commerce platforms concurrently.
 * Returns the FULL status matrix for all 3 stores (Digikala, Torob, Technolife),
 * with available items sorted ascending by price at the top, followed by unavailable stores.
 *
 * @param query Search keyword (e.g. "MacBook Air M4", "iPhone 15")
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
      console.log(`📦 Status Matrix for all 3 Stores:\n`);

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
