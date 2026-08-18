import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

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
 * Common HTTP request configuration.
 */
const DEFAULT_TIMEOUT_MS = 7000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const baseHeaders = {
  'User-Agent': USER_AGENT,
  'Accept-Language': 'fa-IR,fa;q=0.9',
  'Accept': 'application/json, text/plain, */*',
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
  try {
    const encodedQuery = encodeURIComponent(query.trim());
    const apiUrl = `https://api.digikala.com/v1/search/?q=${encodedQuery}&page=1`;

    const response = await fetchWithRedirection(apiUrl);
    const parsedData = DigikalaResponseSchema.safeParse(response.data);

    if (!parsedData.success || !parsedData.data.data.products.length) {
      return null;
    }

    // Pick first marketable product or fallback to the first item
    const products = parsedData.data.data.products;
    const product = products.find((p) => p.status === 'marketable') || products[0];

    if (!product) {
      return null;
    }

    const title = product.title_fa || product.title_en || query;

    // Digikala prices are in Iranian Rials -> convert to Tomans (1 Toman = 10 Rials)
    const rialPrice =
      product.default_variant?.price?.selling_price ||
      product.default_variant?.price?.rrp_price ||
      0;
    const priceInTomans = Math.round(rialPrice / 10);

    const isAvailable = product.status === 'marketable' && priceInTomans > 0;

    let productUrl = `https://www.digikala.com/search/?q=${encodedQuery}`;
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
      formattedPrice: formatTomanPrice(priceInTomans),
      url: productUrl,
      isAvailable,
      imageUrl,
    };
  } catch (error) {
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
  try {
    const encodedQuery = encodeURIComponent(query.trim());
    const apiUrl = `https://api.torob.com/v4/base-product/search/?sort=price&query=${encodedQuery}&page=0&size=1`;

    const response = await axios.get(apiUrl, {
      headers: baseHeaders,
      timeout: DEFAULT_TIMEOUT_MS,
    });

    const parsedData = TorobResponseSchema.safeParse(response.data);
    if (!parsedData.success || !parsedData.data.results.length) {
      return null;
    }

    const item = parsedData.data.results[0];
    const title = item.name1 || item.name2 || query;

    // Torob prices are already in Tomans
    const priceInTomans = item.price || 0;
    const isAvailable = priceInTomans > 0 && item.stock_status !== 'unavailable';

    let productUrl = `https://torob.com/search/?query=${encodedQuery}`;
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
      formattedPrice: formatTomanPrice(priceInTomans),
      url: productUrl,
      isAvailable,
      imageUrl,
    };
  } catch (error) {
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
  data: z.union([z.array(TechnolifeProductSchema), z.object({ products: z.array(TechnolifeProductSchema).optional() })]).optional(),
  products: z.array(TechnolifeProductSchema).optional(),
});

export async function fetchTechnolifePrice(query: string): Promise<ProductResult | null> {
  try {
    const encodedQuery = encodeURIComponent(query.trim());
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
    } else if (parsedData.data.data && typeof parsedData.data.data === 'object' && parsedData.data.data.products) {
      products = parsedData.data.data.products;
    } else if (parsedData.data.products && parsedData.data.products.length > 0) {
      products = parsedData.data.products;
    }

    if (!products.length) {
      return null;
    }

    const product = products[0];
    const title = product.title || product.name || product.product_name || query;

    const rawPrice = product.price || product.selling_price || product.discounted_price || 0;
    const numericPrice = typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0 : rawPrice;

    // Technolife prices are usually in Tomans
    const priceInTomans = Math.round(numericPrice);
    const isAvailable =
      (product.is_available ?? product.available ?? product.in_stock ?? true) && priceInTomans > 0;

    let productUrl = `https://www.technolife.ir/product/search?keyword=${encodedQuery}`;
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
      formattedPrice: formatTomanPrice(priceInTomans),
      url: productUrl,
      isAvailable,
      imageUrl,
    };
  } catch (error) {
    return null;
  }
}

/* ==========================================================================
   4. Price Aggregator
   ========================================================================== */

/**
 * Scrapes all supported Iranian e-commerce platforms concurrently using Promise.allSettled,
 * filters unavailable/null items, and returns available products sorted ascending by price.
 *
 * @param query Search keyword (e.g. "AirPods Pro 2")
 * @returns Array of sorted ProductResult items
 */
export async function compareAllPrices(query: string): Promise<ProductResult[]> {
  const settledResults = await Promise.allSettled([
    fetchDigikalaPrice(query),
    fetchTorobPrice(query),
    fetchTechnolifePrice(query),
  ]);

  const validProducts: ProductResult[] = [];

  for (const item of settledResults) {
    if (item.status === 'fulfilled' && item.value !== null && item.value.isAvailable && item.value.price > 0) {
      validProducts.push(item.value);
    }
  }

  // Sort ascending by price (lowest to highest)
  return validProducts.sort((a, b) => a.price - b.price);
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
      if (results.length === 0) {
        console.log('❌ No available products found for the given query.');
        return;
      }

      console.log(`✅ Found ${results.length} available offer(s), sorted by lowest price:\n`);
      
      console.table(
        results.map((r, idx) => ({
          '#': idx + 1,
          Store: r.source,
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
