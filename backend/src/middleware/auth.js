const jwt = require("jsonwebtoken");

const { resolveApiKeyFromDb } = require("../lib/apiKeyDb");



const parseEnvApiKeys = () => {

    const raw = process.env.API_KEYS || "";

    const defaultDeptIds = () => {
        const rawDef =
            process.env.API_KEY_DEFAULT_DEPT_IDS || process.env.DEV_USER_DEPT_IDS || "101";
        return String(rawDef)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
    };

    return raw

        .split(";")

        .map((x) => x.trim())

        .filter(Boolean)

        .map((e) => {
            const idx = e.indexOf("=");
            /* 仅密钥、无「=部门」时：用 API_KEY_DEFAULT_DEPT_IDS 或 DEV_USER_DEPT_IDS，方便对接方「一头一 JSON」 */
            if (idx === -1) {
                const key = e.trim();
                if (!key) return null;
                return { key, deptIds: defaultDeptIds() };
            }
            const k = e.slice(0, idx).trim();
            const v = e.slice(idx + 1).trim();
            if (!k || !v) return null;
            return { key: k, deptIds: v.split(",").map((x) => x.trim()).filter(Boolean) };

        })

        .filter(Boolean);

};



const tryEnvApiKey = (apiKey) => {

    if (!apiKey || typeof apiKey !== "string") return null;

    const found = parseEnvApiKeys().find((x) => x.key === apiKey);

    if (!found) return null;

    return {

        loginId: `api_key:${apiKey.slice(0, 8)}`,

        role: "service",

        userDeptIds: found.deptIds

    };

};



const tryJwt = (req, res) => {

    const header = req.headers.authorization;

    if (!header || typeof header !== "string") {

        res.status(401).json({ code: 401, msg: "未登录", data: {} });

        return null;

    }

    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {

        res.status(401).json({ code: 401, msg: "Token 无效", data: {} });

        return null;

    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {

        res.status(500).json({ code: 500, msg: "服务未配置 JWT_SECRET", data: {} });

        return null;

    }

    try {

        const decoded = jwt.verify(token, secret);

        return {
            loginId: decoded.loginId || decoded.sub || null,
            role: decoded.role || "user",
            userDeptIds: decoded.userDeptIds || [],
            displayName: decoded.displayName || "",
            ehrEmpId: decoded.ehrEmpId || "",
            ehrEmpType: decoded.ehrEmpType || "",
            ehrDeptname: decoded.ehrDeptname || "",
            ehrStaname: decoded.ehrStaname || "",
            ehrJobname: decoded.ehrJobname || "",
            ehrMobile: decoded.ehrMobile || ""
        };

    } catch (e) {

        res.status(401).json({ code: 401, msg: "Token 无效/过期", data: {} });

        return null;

    }

};



/** 仅 JWT（供改密等路由）；失败抛错，由调用方映射 401 */

const decodeBearerUser = (req) => {

    const header = req.headers.authorization;

    if (!header || typeof header !== "string") {

        throw new Error("UNAUTHORIZED");

    }

    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {

        throw new Error("UNAUTHORIZED");

    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {

        throw new Error("NO_SECRET");

    }

    const decoded = jwt.verify(token, secret);

    return {
        loginId: decoded.loginId || decoded.sub || null,
        role: decoded.role || "user",
        userDeptIds: decoded.userDeptIds || [],
        displayName: decoded.displayName || "",
        ehrEmpId: decoded.ehrEmpId || "",
        ehrEmpType: decoded.ehrEmpType || "",
        ehrDeptname: decoded.ehrDeptname || "",
        ehrStaname: decoded.ehrStaname || "",
        ehrJobname: decoded.ehrJobname || "",
        ehrMobile: decoded.ehrMobile || ""
    };

};

const requireAuthAsync = async (req, res, next) => {
    const apiKey = req.headers["x-api-key"] || req.headers["X-API-Key"];

    if (apiKey && typeof apiKey === "string") {

        const envUser = tryEnvApiKey(apiKey);

        if (envUser) {

            req.user = envUser;

            return next();

        }

        const dbUser = await resolveApiKeyFromDb(apiKey);

        if (dbUser) {

            req.user = dbUser;

            return next();

        }

        return res.status(401).json({ code: 401, msg: "API Key 无效", data: {} });

    }



    const user = tryJwt(req, res);

    if (!user) return;

    req.user = user;

    return next();

};



/**

 * Express 4：用 Promise 包裹异步鉴权，避免 void async 导致未正确进入后续路由。

 */

const requireAuth = (req, res, next) => {

    requireAuthAsync(req, res, next).catch(next);

};



module.exports = { requireAuth, tryJwt, decodeBearerUser };


