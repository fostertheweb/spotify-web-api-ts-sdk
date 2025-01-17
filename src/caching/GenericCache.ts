import { isEmptyAccessToken } from "../auth/IAuthStrategy.js";
import { ICachable, ICachingStrategy } from "../types.js";
import { ICacheStore } from "./ICacheStore.js";

export default class GenericCache implements ICachingStrategy {
  constructor(
    private storage: ICacheStore,
    private updateFunctions: Map<
      string,
      (item: any) => Promise<ICachable>
    > = new Map(),
    private autoRenewInterval: number = 0,
    private autoRenewWindow: number = 2 * 60 * 1000 // Two minutes
  ) {
    if (this.autoRenewInterval > 0) {
      setInterval(() => this.autoRenewRenewableItems(), this.autoRenewInterval);
    }
  }

  public async getOrCreate<T>(
    cacheKey: string,
    createFunction: () => Promise<T & ICachable & object>,
    updateFunction?: (item: T) => Promise<T & ICachable & object>
  ): Promise<T & ICachable> {
    if (updateFunction) {
      this.updateFunctions.set(cacheKey, updateFunction);
    }

    const item = await this.get<T>(cacheKey);
    if (item) {
      return item;
    }

    const newCacheItem = await createFunction();
    if (!newCacheItem) {
      throw new Error("Could not create cache item");
    }

    if (!isEmptyAccessToken(newCacheItem)) {
      await this.setCacheItem(cacheKey, newCacheItem);
    }

    return newCacheItem;
  }

  public async get<T>(cacheKey: string): Promise<(T & ICachable) | null> {
    let asString = await this.storage.get(cacheKey);
    let cachedItem: T & ICachable = asString ? JSON.parse(asString) : null;

    if (
      this.itemDueToExpire(cachedItem) &&
      this.updateFunctions.has(cacheKey)
    ) {
      const updateFunction = this.updateFunctions.get(cacheKey);
      await this.tryUpdateItem(cacheKey, cachedItem, updateFunction!);

      // Ensure updated item is returned
      asString = await this.storage.get(cacheKey);
      cachedItem = asString ? JSON.parse(asString) : null;
    }

    if (!cachedItem) {
      return null;
    }

    if (
      cachedItem.expires &&
      (cachedItem.expires === -1 || cachedItem.expires <= Date.now())
    ) {
      await this.remove(cacheKey);
      return null;
    }

    if (cachedItem.expiresOnAccess && cachedItem.expiresOnAccess === true) {
      await this.remove(cacheKey);
      return cachedItem;
    }

    return cachedItem;
  }

  public async set(
    cacheKey: string,
    value: object,
    expiresIn: number
  ): Promise<void> {
    const expires = Date.now() + expiresIn;
    const cacheItem: ICachable = { ...value, expires };
    await this.setCacheItem(cacheKey, cacheItem);
  }

  public async setCacheItem(
    cacheKey: string,
    cacheItem: ICachable
  ): Promise<void> {
    const asString = JSON.stringify(cacheItem);
    await this.storage.set(cacheKey, asString);
  }

  public async remove(cacheKey: string): Promise<void> {
    await this.storage.remove(cacheKey);
  }

  private itemDueToExpire(item: ICachable): boolean {
    if (!item) {
      return false;
    }

    if (!item.expires) {
      return false;
    }

    return item.expires - Date.now() < this.autoRenewWindow;
  }

  private async autoRenewRenewableItems() {
    this.updateFunctions.forEach(async (updateFunction, key) => {
      const cachedItem = await this.get(key);
      if (!cachedItem) {
        return;
      }

      if (updateFunction && this.itemDueToExpire(cachedItem)) {
        await this.tryUpdateItem(key, cachedItem, updateFunction);
      }
    });
  }

  private async tryUpdateItem(
    key: string,
    cachedItem: ICachable,
    updateFunction: (item: ICachable) => Promise<ICachable>
  ) {
    try {
      const updated = await updateFunction(cachedItem);
      if (updated) {
        await this.setCacheItem(key, updated);
      }
    } catch (e) {
      console.error(e);
    }
  }
}
