/**
 * PRD §5.8：登录防暴力破解。配置 REDIS_URL 时多实例共享计数；否则进程内 Map。
 */

const { getRedis } = require("./rateLimitRedis");

const store = new Map();

const clientIp = (req) => {
    const xff = req.headers["x-forwarded-for"];
    if (xff && typeof xff === "string") {
        const first = xff.split(",")[0].trim();
        if (first) return first;
    }
    return req.ip || req.socket?.remoteAddress || "unknown";
};

const enabled = () => String(process.env.LOGIN_RATE_LIMIT_ENABLED || "1") !== "0";

const maxFails = () => {
    const n = Number(process.env.LOGIN_MAX_FAILS_PER_IP);
    return Number.isFinite(n) && n >= 3 ? Math.min(50, Math.floor(n)) : 8;
};

const lockoutMs = () => {
    const n = Number(process.env.LOGIN_LOCKOUT_MS);
    return Number.isFinite(n) && n >= 60_000 ? Math.min(24 * 60 * 60 * 1000, n) : 15 * 60 * 1000;
};

const lockKey = (ip) => `kb_login:lock:${ip}`;
const failsKey = (ip) => `kb_login:fails:${ip}`;

/**
 * @returns {Promise<null | { retryAfterSec: number }>}
 */
const checkLoginLockout = async (req) => {
    if (!enabled()) return null;
    const ip = clientIp(req);
    const now = Date.now();

    const r = getRedis();
    if (r) {
        try {
            const ttl = await r.pttl(lockKey(ip));
            if (ttl > 0) {
                return { retryAfterSec: Math.max(1, Math.ceil(ttl / 1000)) };
            }
        } catch (_) {
            /* fall back to memory */
        }
    }

    const e = store.get(ip);
    if (e && e.lockedUntil > now) {
        return { retryAfterSec: Math.max(1, Math.ceil((e.lockedUntil - now) / 1000)) };
    }
    if (e && e.lockedUntil && e.lockedUntil <= now) {
        store.delete(ip);
    }
    return null;
};

/**
 * @returns {Promise<void>}
 */
const recordLoginFailure = async (req) => {
    if (!enabled()) return;
    const ip = clientIp(req);
    const now = Date.now();
    const max = maxFails();
    const lockMs = lockoutMs();

    const r = getRedis();
    if (r) {
        try {
            const lkTtl = await r.pttl(lockKey(ip));
            if (lkTtl > 0) return;
            const n = await r.incr(failsKey(ip));
            if (n === 1) {
                await r.pexpire(failsKey(ip), Math.min(3600_000, lockMs * 4));
            }
            if (n >= max) {
                await r.set(lockKey(ip), "1", "PX", lockMs);
                await r.del(failsKey(ip));
            }
            return;
        } catch (_) {
            /* memory fallback */
        }
    }

    let e = store.get(ip);
    if (!e) e = { fails: 0, lockedUntil: 0 };
    if (e.lockedUntil > now) return;
    e.fails += 1;
    if (e.fails >= max) {
        e.lockedUntil = now + lockMs;
        e.fails = 0;
    }
    store.set(ip, e);
};

/**
 * @returns {Promise<void>}
 */
const clearLoginFailures = async (req) => {
    if (!enabled()) return;
    const ip = clientIp(req);
    const r = getRedis();
    if (r) {
        try {
            await r.del(lockKey(ip), failsKey(ip));
        } catch (_) {
            /* ignore */
        }
    }
    store.delete(ip);
};

module.exports = {
    checkLoginLockout,
    recordLoginFailure,
    clearLoginFailures
};
