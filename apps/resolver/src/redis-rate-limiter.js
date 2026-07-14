import Redis from "ioredis";

const takeScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

export class RedisRateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 60000;
    this.max = options.max ?? 120;
    this.prefix = options.prefix ?? "fiber-offers";
    this.redis = options.redis ?? new Redis(options.url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true
    });
    this.ownsRedis = !options.redis;
  }

  async take(key, now = Date.now()) {
    if (this.max === 0 || this.windowMs === 0) return { allowed: true };
    const bucket = Math.floor(now / this.windowMs);
    const redisKey = `${this.prefix}:rate-limit:${bucket}:${key}`;
    const [count, ttl] = await this.redis.eval(takeScript, 1, redisKey, this.windowMs);
    return {
      allowed: Number(count) <= this.max,
      remaining: Math.max(0, this.max - Number(count)),
      resetAt: now + Math.max(0, Number(ttl))
    };
  }

  async close() {
    if (this.ownsRedis && this.redis.status !== "end") await this.redis.quit();
  }

  async healthCheck() {
    await this.redis.ping();
    return { ok: true, backend: "redis" };
  }
}
