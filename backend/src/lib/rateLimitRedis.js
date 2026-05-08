/**
 * 多实例限流：配置 REDIS_URL 时使用 ioredis；未配置或出错时由调用方回退到进程内 Map。
 * 供 apiRateLimit.js、loginRateLimit.js 使用。
 */

const Redis = require("ioredis");

let _client = null;

/**
 * @returns {import("ioredis").default | null}
 */
const getRedis = () => {
    const url = String(process.env.REDIS_URL || "").trim();
    if (!url) return null;
    if (_client) return _client;
    try {
        _client = new Redis(url, {
            maxRetriesPerRequest: 2,
            lazyConnect: false,
            enableReadyCheck: true
        });
        _client.on("error", () => {
            /* 避免未处理 rejection；限流会回退到内存 */
        });
        return _client;
    } catch {
        _client = null;
        return null;
    }
};

/**
 * 固定时间窗计数（按 epoch 对齐的窗口，与多实例一致）。
 * @param {{ key: string, windowMs: number, max: number }} opts
 * @returns {Promise<null | { count: number, resetAt: number }>} 无 Redis 或失败时返回 null
 */
const redisIncrWindow = async ({ key, windowMs }) => {
    const r = getRedis();
    if (!r) return null;
    const safeKey = String(key || "k").replace(/[^\w:.-]/g, "_").slice(0, 200);
    const now = Date.now();
    const w = Math.max(1000, Math.floor(windowMs));
    const slot = Math.floor(now / w);
    const redisKey = `kb_rl:w:${safeKey}:${slot}`;
    try {
        const n = await r.incr(redisKey);
        if (n === 1) {
            await r.pexpire(redisKey, Math.min(86_400_000, w + 5000));
        }
        const resetAt = (slot + 1) * w;
        return { count: n, resetAt };
    } catch {
        return null;
    }
};

module.exports = { getRedis, redisIncrWindow };
