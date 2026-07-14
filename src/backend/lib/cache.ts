import Redis from "ioredis";

let _redis: Redis | null = null;

function getRedis(redisUrl: string): Redis {
  if (!_redis) {
    _redis = new Redis(redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
    });
    _redis.on("error", (err) => {
      console.error("[redis] connection error:", err.message);
    });
  }
  return _redis;
}

export interface CacheOptions {
  ttlSeconds: number;
}

export async function getOrFetch<T>(
  redisUrl: string,
  cacheKey: string,
  fetcher: () => Promise<T>,
  options: CacheOptions
): Promise<T> {
  const redis = getRedis(redisUrl);

  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) return JSON.parse(cached) as T;
  } catch {
    // Redis unavailable — skip cache, serve fresh data
  }

  const fresh = await fetcher();

  try {
    await redis.set(cacheKey, JSON.stringify(fresh), "EX", options.ttlSeconds);
  } catch {
    // Cache write failure is non-fatal
  }

  return fresh;
}
