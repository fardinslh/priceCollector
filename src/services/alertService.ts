import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Bot, InlineKeyboard } from 'grammy';
import { compareAllPrices, formatTomanPrice } from './priceService.js';
import { toAffiliateUrl } from '../utils/affiliate.js';

export interface PriceAlert {
  id: string;
  userId: number;
  chatId: number;
  query: string;
  productTitle: string;
  initialPrice: number;
  targetPrice?: number;
  lastCheckedPrice: number;
  lowestObservedPrice: number;
  storeName: string;
  productUrl: string;
  isActive: boolean;
  createdAt: string;
  lastNotifiedAt?: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ALERTS_FILE_PATH = path.join(DATA_DIR, 'alerts.json');

class AlertService {
  private alerts: PriceAlert[] = [];
  private saveTimeout: NodeJS.Timeout | null = null;
  private isChecking = false;

  constructor() {
    this.alerts = this.loadAlerts();
  }

  private loadAlerts(): PriceAlert[] {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(ALERTS_FILE_PATH)) {
        const content = fs.readFileSync(ALERTS_FILE_PATH, 'utf-8');
        return JSON.parse(content);
      }
    } catch (err) {
      process.stderr.write(`[alertService] Warning loading alerts: ${err}\n`);
    }
    return [];
  }

  private scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      try {
        if (!fs.existsSync(DATA_DIR)) {
          fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(ALERTS_FILE_PATH, JSON.stringify(this.alerts, null, 2), 'utf-8');
        process.stderr.write(`[alertService] Alerts successfully persisted to disk (${this.alerts.length} total)\n`);
      } catch (err) {
        process.stderr.write(`[alertService] Error saving alerts: ${err}\n`);
      }
    }, 1000);
  }

  /**
   * Creates or activates a price alert for a user.
   */
  public addAlert(
    userId: number,
    chatId: number,
    query: string,
    productTitle: string,
    currentPrice: number,
    storeName: string,
    productUrl: string,
    targetPrice?: number
  ): { alert: PriceAlert; isNew: boolean } {
    const existing = this.alerts.find(
      (a) => a.userId === userId && a.query.trim().toLowerCase() === query.trim().toLowerCase() && a.isActive
    );

    if (existing) {
      existing.lastCheckedPrice = currentPrice;
      if (targetPrice) existing.targetPrice = targetPrice;
      this.scheduleSave();
      return { alert: existing, isNew: false };
    }

    const newAlert: PriceAlert = {
      id: `alt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId,
      chatId,
      query: query.trim(),
      productTitle,
      initialPrice: currentPrice,
      targetPrice: targetPrice || Math.round(currentPrice * 0.95), // Default to 5% drop
      lastCheckedPrice: currentPrice,
      lowestObservedPrice: currentPrice,
      storeName,
      productUrl,
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    this.alerts.push(newAlert);
    this.scheduleSave();
    return { alert: newAlert, isNew: true };
  }

  /**
   * Retrieves all active alerts for a user.
   */
  public getUserAlerts(userId: number): PriceAlert[] {
    return this.alerts.filter((a) => a.userId === userId && a.isActive);
  }

  /**
   * Removes or deactivates an alert.
   */
  public removeAlert(userId: number, alertId: string): boolean {
    const alert = this.alerts.find((a) => a.userId === userId && a.id === alertId);
    if (alert) {
      alert.isActive = false;
      this.scheduleSave();
      return true;
    }
    return false;
  }

  /**
   * Background checker that iterates active alerts and pushes notifications to users when price drops.
   */
  public async checkAllAlerts(bot: Bot): Promise<number> {
    if (this.isChecking) return 0;
    this.isChecking = true;
    let notificationCount = 0;

    try {
      const activeAlerts = this.alerts.filter((a) => a.isActive);
      process.stderr.write(`[alertService] Checking price drops for ${activeAlerts.length} active alerts...\n`);

      for (const alert of activeAlerts) {
        try {
          const results = await compareAllPrices(alert.query);
          const available = results.filter((r) => r.isAvailable && r.price > 0);

          if (available.length === 0) continue;

          const currentCheapest = available[0];
          alert.lastCheckedPrice = currentCheapest.price;

          // Check if price dropped below lowest observed or target price
          if (currentCheapest.price < alert.initialPrice) {
            const dropAmount = alert.initialPrice - currentCheapest.price;
            const dropPercent = Math.round((dropAmount / alert.initialPrice) * 100);

            // Avoid spamming: Only notify once per 12 hours unless price drops even lower
            const shouldNotify =
              currentCheapest.price < alert.lowestObservedPrice ||
              !alert.lastNotifiedAt ||
              Date.now() - new Date(alert.lastNotifiedAt).getTime() > 12 * 3600 * 1000;

            if (shouldNotify) {
              alert.lowestObservedPrice = currentCheapest.price;
              alert.lastNotifiedAt = new Date().toISOString();

              const affiliateUrl = toAffiliateUrl(
                currentCheapest.url,
                currentCheapest.source as any
              );

              const keyboard = new InlineKeyboard()
                .url(`🛒 خرید با قیمت جدید از ${currentCheapest.source}`, affiliateUrl)
                .row()
                .text('🔕 لغو هشدار این کالا', `del_alert:${alert.id}`);

              const message = `
🔔 <b>کاهش قیمت کالا رصد شد!</b> 📉

📦 <b>کالا:</b> <code>${alert.query}</code>
🏆 <b>فروشگاه:</b> <b>${currentCheapest.source}</b>

💰 <b>قیمت قبلی:</b> <s>${formatTomanPrice(alert.initialPrice)}</s>
🔥 <b>قیمت جدید و شگفت‌انگیز:</b> <b>${formatTomanPrice(currentCheapest.price)}</b>
🎁 <b>میزان تخفیف:</b> <b>${formatTomanPrice(dropAmount)}</b> (${dropPercent}٪ ارزان‌تر)

<i>هم‌اکنون می‌توانید با کمترین قیمت بازار خرید کنید:</i>
`.trim();

              try {
                await bot.api.sendMessage(alert.chatId, message, {
                  parse_mode: 'HTML',
                  reply_markup: keyboard,
                });
                notificationCount++;
                process.stderr.write(
                  `[alertService] Sent price drop alert to user ${alert.userId} for "${alert.query}"\n`
                );
              } catch (sendErr: any) {
                // If user blocked bot, deactivate alert
                if (sendErr?.error_code === 403) {
                  alert.isActive = false;
                }
              }
            }
          }

          // Small delay to be polite with rate limits
          await new Promise((r) => setTimeout(r, 1000));
        } catch (itemErr) {
          process.stderr.write(`[alertService] Error checking alert for "${alert.query}": ${itemErr}\n`);
        }
      }

      this.scheduleSave();
    } finally {
      this.isChecking = false;
    }

    return notificationCount;
  }

  /**
   * Starts periodic background checker timer (every 60 minutes).
   */
  public startBackgroundTracker(bot: Bot, intervalMinutes = 60): NodeJS.Timeout {
    process.stderr.write(`[alertService] Price tracker timer started (interval: ${intervalMinutes}m)\n`);
    // Run initial check after 1 minute
    setTimeout(() => {
      this.checkAllAlerts(bot).catch(() => {});
    }, 60 * 1000);

    return setInterval(() => {
      this.checkAllAlerts(bot).catch(() => {});
    }, intervalMinutes * 60 * 1000);
  }
}

export const alertService = new AlertService();
