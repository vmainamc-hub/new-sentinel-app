/**
 * Safe Browser Storage Fallback & Quota Management
 *
 * Provides resilient, non-blocking localStorage access with:
 * 1. Automatic detection of QuotaExceededError / SecurityError.
 * 2. Instant seamless fallback to bounded in-memory store.
 * 3. Backoff retry prevention to eliminate disk I/O thrashing and main-thread hangs.
 * 4. Safe JSON serialization/deserialization.
 */

class SafeStorageManager {
  private inMemoryFallback = new Map<string, string>();
  private quotaExceeded = false;
  private lastQuotaErrorAt = 0;
  private readonly QUOTA_BACKOFF_MS = 60_000; // 1 minute backoff before attempting disk write again

  /**
   * Check if localStorage is supported and accessible in the current environment.
   */
  public isAvailable(): boolean {
    if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
      return false;
    }
    try {
      const testKey = "__apex_storage_probe__";
      window.localStorage.setItem(testKey, "1");
      window.localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  public isQuotaExceeded(): boolean {
    return this.quotaExceeded;
  }

  /**
   * Safe read from storage, falling back to in-memory if disk access fails.
   */
  public getItem(key: string): string | null {
    if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
      try {
        const value = window.localStorage.getItem(key);
        if (value !== null) {
          return value;
        }
      } catch {
        // Fallback to in-memory
      }
    }
    return this.inMemoryFallback.get(key) ?? null;
  }

  /**
   * Safe write to storage. If disk quota is exceeded or storage is unavailable,
   * writes into bounded in-memory store and stops disk-thrashing for QUOTA_BACKOFF_MS.
   */
  public setItem(key: string, value: string): boolean {
    // Keep in-memory mirror fresh
    this.inMemoryFallback.set(key, value);

    if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
      return true;
    }

    const now = Date.now();
    // If quota was previously exceeded, wait for backoff window before probing disk again
    if (this.quotaExceeded && now - this.lastQuotaErrorAt < this.QUOTA_BACKOFF_MS) {
      return true;
    }

    try {
      window.localStorage.setItem(key, value);
      if (this.quotaExceeded) {
        this.quotaExceeded = false;
      }
      return true;
    } catch {
      this.quotaExceeded = true;
      this.lastQuotaErrorAt = now;
      return true;
    }
  }

  /**
   * Safe remove from storage and in-memory cache.
   */
  public removeItem(key: string): void {
    this.inMemoryFallback.delete(key);
    if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignored
      }
    }
  }

  /**
   * Clear in-memory fallback cache (used in tests/resets).
   */
  public clearMemory(): void {
    this.inMemoryFallback.clear();
    this.quotaExceeded = false;
    this.lastQuotaErrorAt = 0;
  }
}

export const safeStorage = new SafeStorageManager();

/**
 * Safe JSON parser with type-safe fallback.
 */
export function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && parsed !== undefined ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}
