const express = require("express");

const { requireAuth } = require("../middleware/auth");
const { searchRouter } = require("./search");
const { documentsRouter } = require("./documents");
const { runQueryScalarInt } = require("../lib/sqlcmd");
const { pingQdrant } = require("../lib/qdrantRestClient");

const apiRouter = express.Router();

apiRouter.get("/health", (req, res) => {
    res.status(200).json({ code: 200, msg: "ok", data: {} });
});

/** PRD §13.2：依赖就绪（SQL Server + Qdrant），供编排/探针使用；无需登录 */
apiRouter.get("/ready", async (req, res) => {
    const data = { sql: false, qdrant: false };
    try {
        const n = await runQueryScalarInt("SELECT 1 AS n;");
        data.sql = Number(n) === 1;
    } catch (e) {
        data.sqlError = String((e && e.message) || e).slice(0, 240);
    }
    try {
        await pingQdrant({ qdrantUrl: process.env.QDRANT_URL || "http://127.0.0.1:6333" });
        data.qdrant = true;
    } catch (e) {
        data.qdrantError = String((e && e.message) || e).slice(0, 240);
    }
    const ok = data.sql && data.qdrant;
    return res.status(ok ? 200 : 503).json({
        code: ok ? 200 : 503,
        msg: ok ? "ready" : "degraded",
        data
    });
});

apiRouter.get("/openapi.json", (req, res) => {
    // eslint-disable-next-line global-require
    const { openapiRoute } = require("./openapi");
    return openapiRoute(req, res);
});

/** 简易运行指标（可给 Prometheus 旁路抓取或运维探针；无需登录） */
apiRouter.get("/metrics", (req, res) => {
    const m = process.memoryUsage();
    return res.status(200).json({
        code: 200,
        msg: "ok",
        data: {
            uptimeSeconds: Math.floor(process.uptime()),
            rssBytes: m.rss,
            heapUsedBytes: m.heapUsed,
            pid: process.pid,
            nodeVersion: process.version
        }
    });
});

apiRouter.use("/auth", require("./auth").authRouter);
apiRouter.use("/departments", require("./departments").departmentsRouter);

apiRouter.use(requireAuth);

apiRouter.use("/users", require("./users").usersRouter);

apiRouter.use("/search", searchRouter);
apiRouter.use("/documents", documentsRouter);
apiRouter.use("/index-jobs", require("./indexJobs").indexJobsRouter);
// /admin 已在 app.js 层挂载为 /api/v1/admin，避免嵌套路由 404

module.exports = { apiRouter };

