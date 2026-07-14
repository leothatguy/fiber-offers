import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { RedisRateLimiter } from "../src/redis-rate-limiter.js";

const redisUrl = process.env.TEST_REDIS_URL;
const limiters = [];

after(async () => Promise.all(limiters.map((limiter) => limiter.close())));

test("Redis rate limit is shared across resolver instances", { skip: !redisUrl }, async () => {
  const prefix = `fiber-offers-test:${randomUUID()}`;
  const first = new RedisRateLimiter({ url: redisUrl, prefix, max: 2, windowMs: 60000 });
  const second = new RedisRateLimiter({ url: redisUrl, prefix, max: 2, windowMs: 60000 });
  limiters.push(first, second);

  assert.equal((await first.healthCheck()).backend, "redis");
  assert.equal((await first.take("invoice:client-a")).allowed, true);
  assert.equal((await second.take("invoice:client-a")).allowed, true);
  const blocked = await first.take("invoice:client-a");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.resetAt > Date.now());
});
