const cors = require("cors");
const express = require("express");
const dotenv = require("dotenv");

const { appendDebug } = require("./lib/debugSessionLog");
const { errorMiddleware } = require("./middleware/errorMiddleware");
const { requireAuth } = require("./middleware/auth");
const { adminRouter } = require("./routes/admin");
const { apiRouter } = require("./routes/api");

dotenv.config({ path: process.env.BACKEND_ENV_PATH || ".env" });

const createApp = () => {
    const app = express();

    const parseAllowedOrigins = () => {
        const raw = process.env.CORS_ORIGIN || "";
        const allowed = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        // Dev-friendly defaults: Vite 常用端口 5173/5174 + localhost / 127.0.0.1
        [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:5174",
            "http://127.0.0.1:5174"
        ].forEach((o) => allowed.push(o));

        return Array.from(new Set(allowed));
    };

    const allowedOrigins = parseAllowedOrigins();
    const isProd = process.env.NODE_ENV === "production";

    const logAdminRequest = (req, res, next) => {
        if (process.env.DEBUG_ADMIN_REQUESTS === "1") {
            const origin = req.headers.origin || "";
            // eslint-disable-next-line no-console
            console.debug("[backend] admin request", {
                originalUrl: req.originalUrl,
                path: req.path,
                hasBearer: !!req.headers.authorization,
                origin
            });
            appendDebug({
                runId: "debug-iter3",
                hypothesisId: "H2",
                location: "backend/src/app.js:admin-request",
                message: "admin request reached backend",
                data: {
                    path: req.originalUrl,
                    backendPort: req.socket && req.socket.localPort,
                    host: req.headers.host || "",
                    origin,
                    hasBearer: !!req.headers.authorization,
                    hasApiKey: !!(req.headers["x-api-key"] || req.headers["X-API-Key"])
                }
            });
        }
        next();
    };

    app.use(
        cors({
            origin: (origin, cb) => {
                // Some requests (like same-origin or curl) may not include an Origin header.
                if (!origin) return cb(null, true);
                if (allowedOrigins.includes(origin)) return cb(null, true);
                // 开发环境：直接回显任意 Origin（含 Vite Network、自定义 hosts、非 5173 端口的前端临时地址），避免白名单漏配导致整站 API 不可用。
                // 生产环境务必设置 NODE_ENV=production，仅走上方白名单。
                if (!isProd) return cb(null, origin);
                // #region agent log
                // eslint-disable-next-line no-console
                console.error("[backend] cors denied (prod)", { origin });
                appendDebug({
                    runId: "debug-iter3",
                    hypothesisId: "H3",
                    location: "backend/src/app.js:cors-deny",
                    message: "CORS denied in production",
                    data: {
                        nodeEnv: process.env.NODE_ENV,
                        origin,
                        allowedOriginsIncludes: allowedOrigins.includes(origin)
                    }
                });
                // #endregion
                return cb(null, false);
            },
            credentials: true
        })
    );
    app.use(express.json({ limit: "20mb" }));

    app.use((req, res, next) => {
        const sendJson = res.json.bind(res);
        res.json = (body) => {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            return sendJson(body);
        };
        next();
    });

    if (!isProd) {
        app.post("/api/v1/__debug/client-log", (req, res) => {
            appendDebug({
                runId: req.body?.runId || "client",
                hypothesisId: req.body?.hypothesisId || "H1",
                location: req.body?.location || "client",
                message: req.body?.message || "client log",
                data: req.body?.data || {}
            });
            res.status(204).end();
        });
    }

    app.get("/health", (req, res) => {
        res.status(200).json({
            code: 200,
            msg: "ok",
            data: {}
        });
    });

    // 管理接口固定在 app 层注册（先于 /api/v1 总路由），避免嵌套 Router 匹配不到导致 404
    app.use("/api/v1/admin", logAdminRequest, requireAuth, adminRouter);
    app.use("/api/v1", apiRouter);
    // 兼容：无 /api/v1 前缀时 /admin/* 同等生效
    app.use("/admin", logAdminRequest, requireAuth, adminRouter);

    app.use((req, res) => {
        const isAdminPath = req.originalUrl && (req.originalUrl.startsWith("/api/v1/admin") || req.originalUrl.startsWith("/admin"));
        if (isAdminPath) {
            const origin = req.headers.origin || "";
            // eslint-disable-next-line no-console
            console.error("[backend] admin fell to 404", { originalUrl: req.originalUrl, origin });
            // #region agent log
            appendDebug({
                runId: "debug-iter3",
                hypothesisId: "H4",
                location: "backend/src/app.js:404-admin-fallback",
                message: "admin path fell to 404",
                data: {
                    path: req.originalUrl,
                    nodeEnv: process.env.NODE_ENV,
                    backendPort: req.socket && req.socket.localPort,
                    origin
                }
            });
            // #endregion
        }
        res.status(404).json({ code: 404, msg: "Not Found", data: { path: req.originalUrl } });
    });

    app.use(errorMiddleware);
    return app;
};

module.exports = { createApp };

