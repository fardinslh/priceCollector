import process from 'node:process';

/**
 * Transforms standard product or search URLs into monetized affiliate URLs
 * by appending tracking tags configured in environment variables.
 *
 * @param url Original store or search URL
 * @param source E-commerce store name ('Digikala' or 'Torob')
 * @returns Affiliate URL or original URL if no tag is configured / URL is invalid
 */
export function toAffiliateUrl(url: string, source: 'Digikala' | 'Torob'): string {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return url;
  }

  try {
    const parsedUrl = new URL(url);

    switch (source) {
      case 'Digikala': {
        const tag = process.env.DIGIKALA_AFFILIATE_TAG?.trim();
        if (tag) {
          parsedUrl.searchParams.set('utm_source', 'affiliate');
          parsedUrl.searchParams.set('utm_medium', 'ap');
          parsedUrl.searchParams.set('utm_campaign', tag);
        }
        break;
      }

      case 'Torob': {
        const tag = process.env.TOROB_AFFILIATE_TAG?.trim();
        if (tag) {
          parsedUrl.searchParams.set('utm_source', 'affiliate');
          parsedUrl.searchParams.set('utm_campaign', tag);
          parsedUrl.searchParams.set('aff_id', tag);
        }
        break;
      }
    }

    return parsedUrl.toString();
  } catch {
    // If URL parsing fails, safely return the original url
    return url;
  }
}
