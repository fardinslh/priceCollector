import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { compareAllPrices, type ProductResult } from '../services/priceService.js';
import { toAffiliateUrl } from '../utils/affiliate.js';

/**
 * Log helper strictly writing to stderr to protect stdout JSON-RPC stream integrity.
 */
function logError(message: string): void {
  process.stderr.write(`[iran-shopping-engine] ${message}\n`);
}

/**
 * Input validation schema for compare_prices tool.
 */
const ComparePricesArgsSchema = z.object({
  query: z.string().min(1, 'Query parameter cannot be empty'),
});

/**
 * Format comparison results into high-readability Markdown.
 */
function formatComparisonMarkdown(query: string, results: ProductResult[]): string {
  if (!results || results.length === 0) {
    return (
      `## 🔍 نتایج جستجو برای: "${query}"\n\n` +
      `❌ هیچ محصول فعالی در دیجی‌کالا و ترب برای این عبارت یافت نشد.\n\n` +
      `> *No available products found across Digikala and Torob for query: "${query}".*`
    );
  }

  const cheapest = results[0];
  const cheapestAffiliateUrl = toAffiliateUrl(cheapest.url, cheapest.source);

  const markdownParts: string[] = [];

  markdownParts.push(`# 🛍️ مقایسه قیمت کالا در دیجی‌کالا و ترب\n`);
  markdownParts.push(`**عبارت جستجو شده:** \`${query}\`\n`);

  // 1. Cheapest Store Highlight
  markdownParts.push(`## 🏆 بهترین قیمت (Best Deal)`);
  markdownParts.push(`- **فروشگاه:** **${cheapest.source}**`);
  markdownParts.push(`- **قیمت:** **${cheapest.formattedPrice}**`);
  markdownParts.push(`- **عنوان محصول:** ${cheapest.title}`);
  markdownParts.push(`- **لینک مستقیم خرید:** [مشاهده در ${cheapest.source}](${cheapestAffiliateUrl})\n`);

  // 2. Full Comparison Table
  markdownParts.push(`## 📊 جدول مقایسه قیمت‌ها (Comparison Table)`);
  markdownParts.push(`| رتبه | فروشگاه | قیمت | وضعیت | لینک خرید |`);
  markdownParts.push(`| :---: | :---: | :---: | :---: | :---: |`);

  results.forEach((item, index) => {
    const medal = index === 0 ? '🥇 ' : index === 1 ? '🥈 ' : '';
    const statusText = item.isAvailable ? '✅ موجود' : '❌ ناموجود';
    const affiliateLink = toAffiliateUrl(item.url, item.source);
    const linkText = `[خرید از ${item.source}](${affiliateLink})`;
    markdownParts.push(
      `| ${medal}${index + 1} | **${item.source}** | **${item.formattedPrice}** | ${statusText} | ${linkText} |`
    );
  });

  markdownParts.push('');

  // 3. Direct Product Links
  markdownParts.push(`## 🔗 لینک‌های مستقیم فروشگاه‌ها (Direct Links)`);
  results.forEach((item, index) => {
    const affiliateLink = toAffiliateUrl(item.url, item.source);
    markdownParts.push(`${index + 1}. **${item.source}:** [${item.title}](${affiliateLink})`);
  });

  return markdownParts.join('\n');
}

/**
 * Initialize and start the MCP Server
 */
async function main() {
  const server = new Server(
    {
      name: 'iran-shopping-engine',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tools list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'compare_prices',
          description:
            'Searches Digikala and Torob in Iran across all categories (electronics, home appliances, apparel, cosmetics, groceries), compares real-time prices, and identifies the cheapest vendor with direct verified product links.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  "Product search terms (e.g. 'iPhone 13 128GB', 'MacBook Air M3', 'اتو بخار تفال', 'جاروبرقی فیلیپس').",
              },
            },
            required: ['query'],
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'compare_prices') {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool requested: ${request.params.name}`
      );
    }

    const parseResult = ComparePricesArgsSchema.safeParse(request.params.arguments);
    if (!parseResult.success) {
      const errorMsg = parseResult.error.message || 'Invalid parameters';
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for compare_prices: ${errorMsg}`
      );
    }

    const { query } = parseResult.data;
    logError(`Executing compare_prices for query: "${query}"`);

    try {
      const results = await compareAllPrices(query);
      const formattedOutput = formatComparisonMarkdown(query, results);

      return {
        content: [
          {
            type: 'text',
            text: formattedOutput,
          },
        ],
      };
    } catch (err: any) {
      logError(`Error executing compare_prices: ${err?.message || err}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to retrieve prices: ${err?.message || 'Unknown error'}`
      );
    }
  });

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logError('MCP server started and listening on stdio transport.');
}

main().catch((error) => {
  logError(`Fatal server initialization error: ${error?.message || error}`);
  process.exit(1);
});
