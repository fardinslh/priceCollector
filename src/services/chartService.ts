import { toPersianDigits, formatTomanPrice } from './priceService.js';

export interface PricePoint {
  date: string;
  price: number;
}

export interface PriceTrendAnalysis {
  chartUrl: string;
  minPrice: number;
  maxPrice: number;
  currentPrice: number;
  trend: 'falling' | 'stable' | 'rising';
  advicePersian: string;
}

/**
 * Generates ESTIMATED price history points around the current observed price.
 * NOTE: This is an illustrative estimate, NOT real recorded price history.
 */
export function generatePriceHistory(currentPrice: number, days = 14): PricePoint[] {
  const points: PricePoint[] = [];
  const now = new Date();

  // Create realistic slight historical variance (±3-8%) around observed price
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayLabel = `${d.getMonth() + 1}/${d.getDate()}`;

    // Recent trend formula
    const factor = i === 0 ? 1.0 : 1.0 + (Math.sin(i * 0.8) * 0.04) + ((i / days) * 0.02);
    const price = Math.round(currentPrice * factor);

    points.push({
      date: dayLabel,
      price,
    });
  }

  return points;
}

/**
 * Builds a high-resolution dark-mode QuickChart.io URL representing an ESTIMATED price trend.
 */
export function generatePriceChartUrl(productTitle: string, currentPrice: number): PriceTrendAnalysis {
  const history = generatePriceHistory(currentPrice, 10);
  const labels = history.map((h) => toPersianDigits(h.date));
  const dataPrices = history.map((h) => Math.round(h.price / 1000)); // in thousands of Tomans for clean axis

  const minPrice = Math.min(...history.map((h) => h.price));
  const maxPrice = Math.max(...history.map((h) => h.price));

  let trend: 'falling' | 'stable' | 'rising' = 'stable';
  let advicePersian = '🟡 قیمت فعلی نسبت به بازه برآوردی در وضعیت تعادل قرار دارد (تخمینی).';

  if (currentPrice <= minPrice * 1.01) {
    trend = 'falling';
    advicePersian = '🟢 <b>برآورد:</b> قیمت فعلی نسبت به بازه برآوردی نسبتاً پایین است (تخمینی، نه تاریخچه واقعی).';
  } else if (currentPrice >= maxPrice * 0.99) {
    trend = 'rising';
    advicePersian = '🔴 <b>برآورد:</b> قیمت فعلی نسبت به بازه برآوردی نسبتاً بالاست؛ در صورت عدم عجله، صبر کنید (تخمینی).';
  }

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'قیمت (هزار تومان)',
          data: dataPrices,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.15)',
          fill: true,
          tension: 0.35,
          pointRadius: 4,
          pointBackgroundColor: '#34d399',
          borderWidth: 3,
        },
      ],
    },
    options: {
      title: {
        display: true,
        text: `نمودار تقریبی قیمت: ${productTitle.slice(0, 30)}`,
        fontColor: '#ffffff',
        fontSize: 14,
      },
      legend: {
        display: false,
      },
      scales: {
        xAxes: [
          {
            gridLines: { color: 'rgba(255, 255, 255, 0.1)' },
            ticks: { fontColor: '#94a3b8' },
          },
        ],
        yAxes: [
          {
            gridLines: { color: 'rgba(255, 255, 255, 0.1)' },
            ticks: { fontColor: '#94a3b8' },
          },
        ],
      },
    },
  };

  const encodedConfig = encodeURIComponent(JSON.stringify(chartConfig));
  const chartUrl = `https://quickchart.io/chart?c=${encodedConfig}&bkg=%230f172a&w=600&h=320&devicePixelRatio=2`;

  return {
    chartUrl,
    minPrice,
    maxPrice,
    currentPrice,
    trend,
    advicePersian,
  };
}
