/**
 * PRD §5.9：对 API Key 与 IP 做限流（进程内固定窗口；多实例配置 REDIS_URL 时走 Redis）。
 * 在 requireAuth 之后挂载，以便区分 DB API Key（_apiKeyId）与普通 JWT/IP。
 */

const { redisIncrWindow } = require("./rateLimitRedis");

const store = new Map();

const clientIp = (req) => {
    const xff = req.headers["x-forwarded-for"];
    if (xff && typeof xff === "string") {
        const first = xff.split(",")[0].trim();
        if (first) return first;
    }
    return req.ip || req.socket?.remoteAddress || "unknown";
};

const enabled = () => String(process.env.API_RATE_LIMIT_ENABLED || "1") !== "0";

const rateKeyForRequest = (req) => {
    if (req.user && req.user._apiKeyId) {
        return `ak:${String(req.user._apiKeyId)}`;
    }
    if (req.user && typeof req.user.loginId === "string" && req.user.loginId.startsWith("api_key:")) {
        return `ak_env:${req.user.loginId}`;
    }
    return `ip:${clientIp(req)}`;
};

/**
 * @param {object} opts
 * @param {string} opts.bucketSuffix - 如 search、doc_write
 * @param {string} opts.envMax
 * @param {number} opts.defaultMax
 * @param {string} [opts.envWindowMs]
 * @param {number} [opts.defaultWindowMs]
 */
const createFixedWindowLimiter = (opts) => {
    const { bucketSuffix, envMax, defaultMax, envWindowMs, defaultWindowMs } = opts;
    return async (req, res, next) => {
        if (!enabled()) return next();

        const windowMsRaw = envWindowMs ? Number(process.env[envWindowMs]) : NaN;
        const windowMs =
            Number.isFinite(windowMsRaw) && windowMsRaw >= 1000
                ? Math.min(3600_000, Math.floor(windowMsRaw))
                : defaultWindowMs ?? 60_000;

        const maxRaw = Number(process.env[envMax]);
        const max =
            Number.isFinite(maxRaw) && maxRaw >= 1
                ? Math.min(10_000, Math.floor(maxRaw))
                : defaultMax;

        const mapKey = `${bucketSuffix}:${rateKeyForRequest(req)}`;

        const redisHit = await redisIncrWindow({
            key: mapKey,
            windowMs,
            max
        });

        if (redisHit) {
            if (redisHit.count > max) {
                const retryAfterSec = Math.max(1, Math.ceil((redisHit.resetAt - Date.now()) / 1000));
                res.setHeader("Retry-After", String(retryAfterSec));
                return res.status(429).json({
                    code: 429,
                    msg: `请求过于频繁，请在 ${retryAfterSec} 秒后重试`,
                    data: {}
                });
            }
            return next();
        }

        const now = Date.now();
        let b = store.get(mapKey);
        if (!b || now >= b.resetAt) {
            b = { count: 0, resetAt: now + windowMs };
            store.set(mapKey, b);
        }
        b.count += 1;
        if (b.count > max) {
            const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
            res.setHeader("Retry-After", String(retryAfterSec));
            return res.status(429).json({
                code: 429,
                msg: `请求过于频繁，请在 ${retryAfterSec} 秒后重试`,
                data: {}
            });
        }
        return next();
    };
};

/** POST /search：Embedding + Qdrant + 可选 vLLM，默认每窗口 120 次 */
const searchPostRateLimit = createFixedWindowLimiter({
    bucketSuffix: "search",
    envMax: "API_SEARCH_MAX_PER_WINDOW",
    defaultMax: 120,
    envWindowMs: "API_SEARCH_WINDOW_MS",
    defaultWindowMs: 60_000
});

/** 上传与重新入库：默认每窗口 40 次 */
const documentWriteRateLimit = createFixedWindowLimiter({
    bucketSuffix: "doc_write",
    envMax: "API_DOC_WRITE_MAX_PER_WINDOW",
    defaultMax: 40,
    envWindowMs: "API_DOC_WRITE_WINDOW_MS",
    defaultWindowMs: 60_000
});

module.exports = {
    searchPostRateLimit,
    documentWriteRateLimit
};
