import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { priceCache } from './cacheService.js';
import {
  validateProductCandidatesWithAI,
  type CandidateProduct,
} from './productValidator.js';

const execFileAsync = promisify(execFile);

/**
 * Product result structure representing price and availability information across Digikala and Torob.
 */
export interface ProductResult {
  source: 'Digikala' | 'Torob';
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
const DEFAULT_TIMEOUT_MS = 8000;
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

/**
 * Executes a fast, non-blocking curl request to bypass Windows TLS/EPROTO and proxy issues on Iranian national domains.
 */
async function fetchJsonViaCurl(url: string, headers: Record<string, string> = {}): Promise<any> {
  const headerArgs: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    headerArgs.push('-H', `${k}: ${v}`);
  }
  const { stdout } = await execFileAsync(
    'curl.exe',
    [
      '-s',
      '--compressed',
      '--connect-timeout',
      '5',
      '--max-time',
      '8',
      '--resolve',
      'api.torob.com:443:185.53.143.214',
      ...headerArgs,
      url,
    ],
    {
      timeout: 10000,
    }
  );
  if (!stdout || !stdout.trim()) {
    throw new Error('Empty response from curl');
  }
  return JSON.parse(stdout);
}

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

/**
 * Helper to perform HTTP GET requests with custom headers, 8s timeout, and DigiCDN 307 cookie redirection support.
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

  // Build candidate items for AI / semantic verification
  const candidates: CandidateProduct[] = products.map((p) => {
    const fullTitle = `${p.title_fa || ''} ${p.title_en || ''}`.trim();
    const rialPrice =
      p.default_variant?.price?.selling_price || p.default_variant?.price?.rrp_price || 0;
    const priceInTomans = Math.round(rialPrice / 10);
    const status = p.status === 'marketable' ? 'available' : 'unavailable';
    return {
      title: fullTitle,
      price: priceInTomans,
      status,
      raw: p,
    };
  });

  const verifiedCandidate = await validateProductCandidatesWithAI(query, candidates);
  if (!verifiedCandidate) {
    return null;
  }

  const selectedProduct = verifiedCandidate.raw as z.infer<typeof DigikalaProductSchema>;
  const title = selectedProduct.title_fa || selectedProduct.title_en || query;
  const priceInTomans = verifiedCandidate.price;
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
    `[priceService] [Digikala] Selected ${isAvailable ? 'IN-STOCK' : 'OUT-OF-STOCK'} item: "${title.slice(0, 40)}..." at ${priceInTomans} Toman\n`
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
        `[priceService] [Digikala] Error fetching "${q}": ${error?.message || error}\n`
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
  const apiUrl = `https://api.torob.com/v4/base-product/search/?q=${encodedQuery}&page=0&size=10`;

  let responseData: any = null;

  // 1. Primary: Fast, direct curl execution (bypasses Windows TLS/EPROTO issues)
  try {
    responseData = await fetchJsonViaCurl(apiUrl, torobHeaders);
  } catch {
    // 2. Fallback: Direct Axios GET
    try {
      const resp = await axios.get(apiUrl, {
        headers: torobHeaders,
        timeout: DEFAULT_TIMEOUT_MS,
      });
      responseData = resp.data;
    } catch {
      // 3. Fallback: HTTP
      try {
        const httpUrl = `http://api.torob.com/v4/base-product/search/?q=${encodedQuery}&page=0&size=10`;
        const resp = await axios.get(httpUrl, {
          headers: torobHeaders,
          timeout: DEFAULT_TIMEOUT_MS,
        });
        responseData = resp.data;
      } catch {
        // Failed
      }
    }
  }

  if (!responseData) {
    return null;
  }

  const parsedData = TorobResponseSchema.safeParse(responseData);
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

  // Build candidate items for AI / semantic verification
  const candidates: CandidateProduct[] = items.map((it) => {
    const fullTitle = `${it.name1 || ''} ${it.name2 || ''}`.trim();
    const priceInTomans = it.price || 0;
    const status = it.stock_status || 'available';
    return {
      title: fullTitle,
      price: priceInTomans,
      status,
      raw: it,
    };
  });

  const verifiedCandidate = await validateProductCandidatesWithAI(query, candidates);
  if (!verifiedCandidate) {
    process.stderr.write(`[Torob] No verified candidate found for "${query}"\n`);
    return null;
  }

  const selectedItem = verifiedCandidate.raw as z.infer<typeof TorobItemSchema>;
  const title = selectedItem.name1 || selectedItem.name2 || query;
  const priceInTomans = verifiedCandidate.price;
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
        `[priceService] [Torob] Error fetching "${q}": ${error?.message || error}\n`
      );
    }
  }
  return null;
}

/* ==========================================================================
   3. Price Aggregator (Digikala & Torob)
   ========================================================================== */

/**
 * Scrapes Digikala and Torob concurrently.
 * Returns the FULL status matrix for both stores,
 * with available items sorted ascending by price at the top, followed by unavailable stores.
 *
 * @param query Search keyword (e.g. "MacBook Air M4", "iPhone 15", "اتو بخار تفال")
 * @returns Array containing entries for Digikala and Torob
 */
export async function compareAllPrices(query: string): Promise<ProductResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  // Canonical cache key ensures Persian / English spacing differences hit the same cache!
  const canonicalKey =
    normalizeSearchQueries(normalizedQuery)[0] || normalizedQuery.toLowerCase();

  const cached = priceCache.get(canonicalKey);
  if (cached && Array.isArray(cached) && cached.length === 2) {
    process.stderr.write(`[priceService] Instant cache hit for "${canonicalKey}"\n`);
    return cached as ProductResult[];
  }

  process.stderr.write(
    `[priceService] Starting parallel price search for "${normalizedQuery}" across Digikala and Torob...\n`
  );

  const settledResults = await Promise.allSettled([
    fetchDigikalaPrice(normalizedQuery),
    fetchTorobPrice(normalizedQuery),
  ]);

  const digikalaRes = settledResults[0].status === 'fulfilled' ? settledResults[0].value : null;
  const torobRes = settledResults[1].status === 'fulfilled' ? settledResults[1].value : null;

  process.stderr.write(
    `[priceService] Parallel search finished for "${normalizedQuery}": Digikala=${digikalaRes?.isAvailable ? digikalaRes.formattedPrice : 'Out of Stock'}, Torob=${torobRes?.isAvailable ? torobRes.formattedPrice : 'Out of Stock'}\n`
  );

  const encodedQuery = encodeURIComponent(normalizedQuery);

  // Guarantee both stores are populated in the matrix
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
  ];

  // Separate available and unavailable stores
  const availableStores = fullMatrix
    .filter((s) => s.isAvailable && s.price > 0)
    .sort((a, b) => a.price - b.price);

  const unavailableStores = fullMatrix.filter((s) => !s.isAvailable || s.price <= 0);

  // Combine: Available lowest-price first, followed by out-of-stock stores
  const finalResults = [...availableStores, ...unavailableStores];

  // Cache results under both canonical and exact query for 15 minutes
  priceCache.set(canonicalKey, finalResults);
  priceCache.set(normalizedQuery.toLowerCase(), finalResults);

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
  console.log(`\n🔍 Searching Iranian stores (Digikala & Torob) for: "${searchTarget}"...\n`);

  compareAllPrices(searchTarget)
    .then((results) => {
      console.log(`\n📦 Status Matrix for Digikala & Torob:\n`);

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
