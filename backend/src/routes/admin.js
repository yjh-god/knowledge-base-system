const express = require("express");
const cron = require("node-cron");

const crypto = require("crypto");



const { syncEhrToSql } = require("../services/ehrSync");

const { hashPassword } = require("../lib/passwordHash");

const { runQuery, runQueryTsv, runQueryScalarInt } = require("../lib/sqlcmd");

const { writeAuditLog, escapeSql } = require("../lib/auditLog");

const { hashKey } = require("../lib/apiKeyDb");

const { getCollectionInfo } = require("../lib/qdrantRestClient");

const { searchPostRateLimit } = require("../lib/apiRateLimit");

const { performKnowledgeSearch } = require("./search");

const { kgAdminRouter } = require("./kgAdmin");
const { kgInstancesRouter } = require("./kgInstancesAdmin");

const kgAdminMerged = express.Router();
kgAdminMerged.use(kgAdminRouter);
kgAdminMerged.use(kgInstancesRouter);

const { loadKbSyncSettings, saveKbSyncSettings } = require("../lib/kbSyncSettings");
const {
    runFolderSyncPipeline,
    parseProcessNames,
    checkProcessTokensDetail,
    resolveWecomUrl,
    postWecomTextWithResult,
    isLikelyWecomWebhookUrl
} = require("../services/folderSyncService");
const { reloadFolderSyncScheduler } = require("../scheduler/folderSyncScheduler");
const { listFolderSyncRuns } = require("../lib/kbFolderSyncRuns");

const adminRouter = express.Router();



const requireAdmin = (req, res, next) => {

    const role = req.user?.role || "";

    if (role !== "admin") {

        return res.status(403).json({ code: 403, msg: "没有权限", data: {} });

    }

    return next();

};

/** 知识图谱：实体类型 / 关系类型（需 sql/010_kg_schema.sql） */
adminRouter.use("/kg", requireAdmin, kgAdminMerged);

/** PRD §5.3.3：管理员审计检索（跨部门，全量写入 audit_logs） */
adminRouter.post("/search", requireAdmin, (req, res, next) => {
    void searchPostRateLimit(req, res, () =>
        performKnowledgeSearch(req, res, { auditSearch: true }).catch(next)
    ).catch(next);
});



adminRouter.get("/config", requireAdmin, (req, res) => {

    return res.status(200).json({

        code: 200,

        msg: "ok",

        data: {

            qdrantDashboardUrl: process.env.QDRANT_DASHBOARD_PUBLIC_URL || "",

            qdrantCollection: process.env.QDRANT_COLLECTION || "kb_chunks",

            embeddingModel: process.env.EMBEDDING_MODEL || "",

            ehrSyncSource: process.env.EHR_SYNC_SOURCE || "mock",

            ehrMssqlServer: process.env.EHR_MSSQL_SERVER || "",

            ehrMssqlDatabase: process.env.EHR_MSSQL_DATABASE || "",

            ehrSyncFrom: process.env.EHR_SYNC_FROM || ""

        }

    });

});



adminRouter.get("/dashboard", requireAdmin, async (req, res) => {

    try {

        const docStatRows = await runQueryTsv(`

            SELECT ISNULL(status, N''), CAST(COUNT(*) AS VARCHAR(20))

            FROM dbo.documents

            GROUP BY status

        `);

        const docsByStatus = docStatRows.map((r) => ({

            status: r[0] || "",

            cnt: Number(r[1]) || 0

        }));



        const jobStatRows = await runQueryTsv(`

            SELECT ISNULL(status, N''), CAST(COUNT(*) AS VARCHAR(20))

            FROM dbo.index_jobs

            GROUP BY status

        `);

        const jobsByStatus = jobStatRows.map((r) => ({

            status: r[0] || "",

            cnt: Number(r[1]) || 0

        }));



        let jobs24h = { successCount: 0, failedCount: 0, pendingCount: 0 };

        try {

            const jobs24Raw = await runQuery(`

                SELECT CONCAT(

                    CAST(ISNULL(SUM(CASE WHEN status = N'success' THEN 1 ELSE 0 END), 0) AS VARCHAR(20)), ',',

                    CAST(ISNULL(SUM(CASE WHEN status = N'failed' THEN 1 ELSE 0 END), 0) AS VARCHAR(20)), ',',

                    CAST(ISNULL(SUM(CASE WHEN status IN (N'queued', N'running') THEN 1 ELSE 0 END), 0) AS VARCHAR(20))

                )

                FROM dbo.index_jobs

                WHERE created_at >= DATEADD(hour, -24, SYSDATETIMEOFFSET());

            `);

            for (const raw of String(jobs24Raw || "").split(/\r?\n/)) {

                const t = raw.trim();

                if (!t || /^\(\d+/.test(t)) continue;

                const c = t.replace(/\s+/g, "");

                if (/^\d+,\d+,\d+$/.test(c)) {

                    const [successCount, failedCount, pendingCount] = c.split(",").map((x) => Number(x));

                    jobs24h = { successCount, failedCount, pendingCount };

                    break;

                }

            }

        } catch (_) {

            jobs24h = { successCount: 0, failedCount: 0, pendingCount: 0 };

        }



        const auditRows = await runQueryTsv(`

            SELECT

                CONVERT(VARCHAR(10), CAST(created_at AS DATE), 23),

                CAST(COUNT(*) AS VARCHAR(20))

            FROM dbo.audit_logs

            WHERE created_at >= DATEADD(day, -14, SYSDATETIMEOFFSET())

            GROUP BY CAST(created_at AS DATE)

            ORDER BY CAST(created_at AS DATE)

        `);

        const auditDaily = auditRows.map((r) => ({

            day: r[0] || "",

            cnt: Number(r[1]) || 0

        }));



        const qdrantUrl = process.env.QDRANT_URL || "http://127.0.0.1:6333";

        const collection = process.env.QDRANT_COLLECTION || "kb_chunks";

        let vectorPoints = null;

        let qdrantOk = true;

        let qdrantMessage = "";

        try {

            const info = await getCollectionInfo({ qdrantUrl, collection });

            vectorPoints = info?.result?.points_count ?? info?.result?.vectors_count ?? null;

        } catch (e) {

            const msg = (e && e.message) || String(e);

            /* reset-kb 或首次部署后集合尚未创建：Qdrant 服务正常，仅集合不存在 */

            const collectionMissing =

                /404/.test(msg) &&

                /not\s*found|doesn'?t\s+exist|collection/i.test(msg);

            if (collectionMissing) {

                vectorPoints = 0;

                qdrantOk = true;

                qdrantMessage = "";

            } else {

                qdrantOk = false;

                qdrantMessage = msg;

            }

        }



        return res.status(200).json({

            code: 200,

            msg: "ok",

            data: {

                documentsByStatus: Array.isArray(docsByStatus) ? docsByStatus : [],

                indexJobsByStatus: Array.isArray(jobsByStatus) ? jobsByStatus : [],

                jobs24hSummary: jobs24h && typeof jobs24h === "object" ? jobs24h : {},

                auditDaily: Array.isArray(auditDaily) ? auditDaily : [],

                vectorPoints,

                qdrantOk,

                qdrantMessage: qdrantOk ? "" : qdrantMessage

            }

        });

    } catch (e) {

        // eslint-disable-next-line no-console

        console.error("dashboard error:", e);

        return res.status(500).json({ code: 500, msg: "看板数据读取失败", data: {} });

    }

});



adminRouter.get("/audit-logs", requireAdmin, async (req, res) => {

    const page = req.query?.page ? Number(req.query.page) : 1;

    const pageSize = req.query?.pageSize ? Number(req.query.pageSize) : 20;

    const safePageSize = Math.max(1, Math.min(100, pageSize));

    const offset = Math.max(0, (page - 1) * safePageSize);



    const action = req.query?.action ? String(req.query.action) : "";

    const actorLoginId = req.query?.actorLoginId ? String(req.query.actorLoginId) : "";

    const from = req.query?.from ? String(req.query.from) : "";

    const to = req.query?.to ? String(req.query.to) : "";

    const q = req.query?.q ? String(req.query.q) : "";



    const conds = ["1=1"];

    if (action) conds.push(`action = N'${escapeSql(action)}'`);

    if (actorLoginId) conds.push(`actor_login_id = N'${escapeSql(actorLoginId)}'`);

    if (from) conds.push(`created_at >= N'${escapeSql(from)}'`);

    if (to) conds.push(`created_at < DATEADD(day, 1, CAST(N'${escapeSql(to)}' AS DATE))`);

    if (q) conds.push(`summary LIKE N'%${escapeSql(q)}%'`);



    const where = conds.join(" AND ");



    try {

        const total = await runQueryScalarInt(`

            SELECT COUNT(*) FROM dbo.audit_logs WHERE ${where};

        `);



        const logRows = await runQueryTsv(`

            SELECT

                CAST(id AS VARCHAR(24)),

                ISNULL(CONVERT(VARCHAR(36), actor_user_id), N''),

                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(actor_login_id, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),

                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(action, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),

                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(target_type, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),

                ISNULL(CONVERT(VARCHAR(36), target_id), N''),

                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(summary, N''), 500), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),

                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(metadata_json, N''), 3500), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),

                CONVERT(VARCHAR(40), created_at, 126)

            FROM dbo.audit_logs

            WHERE ${where}

            ORDER BY id DESC

            OFFSET ${offset} ROWS FETCH NEXT ${safePageSize} ROWS ONLY

        `);

        const items = logRows.map((c) => ({

            id: Number(c[0]) || c[0],

            actor_user_id: c[1] && c[1].length >= 32 ? c[1] : null,

            actor_login_id: c[2] || "",

            action: c[3] || "",

            target_type: c[4] || "",

            target_id: c[5] && c[5].length >= 32 ? c[5] : null,

            summary: c[6] || "",

            metadata_json: c[7] || "",

            created_at: c[8] || ""

        }));



        return res.status(200).json({

            code: 200,

            msg: "ok",

            data: {

                page,

                pageSize: safePageSize,

                total,

                items

            }

        });

    } catch (e) {

        // eslint-disable-next-line no-console

        console.error("audit-logs:", e);

        return res.status(500).json({ code: 500, msg: "查询失败", data: {} });

    }

});



adminRouter.get("/api-keys", requireAdmin, async (req, res) => {

    try {

        const keyRows = await runQueryTsv(`

            SELECT

                CONVERT(VARCHAR(36), id),

                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(key_prefix, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),

                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),

                ISNULL(CONVERT(VARCHAR(36), bound_user_id), N''),

                CONVERT(VARCHAR(40), created_at, 126),

                ISNULL(CONVERT(VARCHAR(40), revoked_at, 126), N''),

                ISNULL(CONVERT(VARCHAR(40), last_used_at, 126), N'')

            FROM dbo.api_keys

            WHERE revoked_at IS NULL

            ORDER BY created_at DESC

        `);

        const items = keyRows.map((c) => ({

            id: c[0] || "",

            keyPrefix: c[1] || "",

            name: c[2] || "",

            boundUserId: c[3] || "",

            createdAt: c[4] || "",

            revokedAt: c[5] || null,

            lastUsedAt: c[6] || null

        }));

        return res.status(200).json({

            code: 200,

            msg: "ok",

            data: { items }

        });

    } catch (e) {

        // eslint-disable-next-line no-console

        console.error("api-keys list:", e);

        return res.status(500).json({ code: 500, msg: "读取失败（请先执行 sql/003_api_keys.sql）", data: {} });

    }

});



adminRouter.post("/api-keys", requireAdmin, async (req, res) => {

    const name = req.body?.name ? String(req.body.name) : "";

    const boundLoginId = req.body?.boundLoginId ? String(req.body.boundLoginId) : "";

    if (!name || !boundLoginId) {

        return res.status(400).json({ code: 400, msg: "name 与 boundLoginId 必填", data: {} });

    }

    try {

        const userRows = await runQueryTsv(`

            SELECT TOP 1 CONVERT(VARCHAR(36), id)

            FROM dbo.users

            WHERE login_id = N'${escapeSql(boundLoginId)}'

        `);

        const uid = userRows[0] && userRows[0][0];

        if (!uid) {

            return res.status(400).json({ code: 400, msg: "未找到绑定用户 login_id", data: {} });

        }

        const u = { id: uid };



        const id = crypto.randomUUID();

        const secret = `kb_${crypto.randomBytes(24).toString("hex")}`;

        const keyPrefix = secret.slice(0, 14);

        const keyHash = hashKey(secret);



        await runQuery(`

            INSERT INTO dbo.api_keys (id, key_prefix, key_hash, bound_user_id, name)

            VALUES (

                CAST(N'${escapeSql(id)}' AS UNIQUEIDENTIFIER),

                N'${escapeSql(keyPrefix)}',

                N'${escapeSql(keyHash)}',

                CAST(N'${escapeSql(u.id)}' AS UNIQUEIDENTIFIER),

                N'${escapeSql(name)}'

            );

        `);



        await writeAuditLog({

            actorLoginId: req.user?.loginId || null,

            action: "admin.api_key_create",

            targetType: "api_key",

            targetId: id,

            summary: `创建 API Key：${name}`

        });



        return res.status(200).json({

            code: 200,

            msg: "ok（完整密钥仅显示一次，请保存）",

            data: { id, keyPrefix, secret }

        });

    } catch (e) {

        // eslint-disable-next-line no-console

        console.error("api-keys create:", e);

        return res.status(500).json({ code: 500, msg: "创建失败（表是否存在？）", data: {} });

    }

});



adminRouter.post("/api-keys/:id/revoke", requireAdmin, async (req, res) => {

    const { id } = req.params || {};

    if (!id) {

        return res.status(400).json({ code: 400, msg: "id 必填", data: {} });

    }

    try {

        await runQuery(`

            UPDATE dbo.api_keys

            SET revoked_at = SYSDATETIMEOFFSET()

            WHERE id = CAST(N'${escapeSql(id)}' AS UNIQUEIDENTIFIER)

              AND revoked_at IS NULL;

        `);

        await writeAuditLog({

            actorLoginId: req.user?.loginId || null,

            action: "admin.api_key_revoke",

            targetType: "api_key",

            targetId: id,

            summary: "吊销 API Key"

        });

        return res.status(200).json({ code: 200, msg: "已吊销", data: {} });

    } catch (e) {

        // eslint-disable-next-line no-console

        console.error("api-keys revoke:", e);

        return res.status(500).json({ code: 500, msg: "操作失败", data: {} });

    }

});



adminRouter.post("/ehr-sync", requireAdmin, async (req, res) => {

    try {

        const source = process.env.EHR_SYNC_SOURCE || "mock";

        await syncEhrToSql({ source });

        await writeAuditLog({

            actorLoginId: req.user?.loginId || null,

            action: "admin.ehr_sync_trigger",

            summary: `EHR 同步 source=${source}`

        });

        return res.status(200).json({ code: 200, msg: "EHR 同步完成", data: {} });

    } catch (e) {

        // eslint-disable-next-line no-console

        console.error("ehr-sync error:", e);

        return res.status(500).json({ code: 500, msg: "EHR 同步失败", data: {} });

    }

});



adminRouter.post("/night-reconcile", requireAdmin, async (req, res) => {

    try {

        const { runNightReconcileOnce } = require("../worker/nightBatch");

        const data = await runNightReconcileOnce();

        await writeAuditLog({

            actorLoginId: req.user?.loginId || null,

            action: "admin.night_reconcile_trigger",

            summary: "手动触发夜间向量对账",

            metadata: {}

        });

        return res.status(200).json({ code: 200, msg: "ok", data });

    } catch (e) {

        // eslint-disable-next-line no-console

        console.error("night-reconcile:", e);

        return res.status(500).json({ code: 500, msg: (e && e.message) || "对账失败", data: {} });

    }

});

adminRouter.get("/sync-settings", requireAdmin, async (req, res, next) => {
    try {
        const data = await loadKbSyncSettings();
        return res.status(200).json({ code: 200, msg: "ok", data });
    } catch (e) {
        return next(e);
    }
});

adminRouter.put("/sync-settings", requireAdmin, async (req, res, next) => {
    try {
        const body = req.body || {};
        const tp = String(body.stagingPath ?? "").trim();
        const e1 = String(body.cronExpr1 ?? "").trim();
        const e2 = String(body.cronExpr2 ?? "").trim();
        if (e1 && !cron.validate(e1)) {
            return res.status(400).json({ code: 400, msg: "定时表达式 cronExpr1 非法（node-cron 格式）", data: {} });
        }
        if (e2 && !cron.validate(e2)) {
            return res.status(400).json({ code: 400, msg: "定时表达式 cronExpr2 非法（node-cron 格式）", data: {} });
        }
        await saveKbSyncSettings({
            ...body,
            stagingPath: tp,
            sharePath: "",
            cronExpr1: e1,
            cronExpr2: e2
        });
        await reloadFolderSyncScheduler();
        try {
            const { reloadMirrorScanPollerFromSettings } = require("../worker/mirrorScanPoller");
            await reloadMirrorScanPollerFromSettings();
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error("[mirror-scan] 重载失败", e);
        }
        const data = await loadKbSyncSettings();
        await writeAuditLog({
            actorLoginId: req.user?.loginId || null,
            action: "admin.sync_settings_update",
            summary: "更新镜像同步配置",
            metadata: {}
        });
        return res.status(200).json({ code: 200, msg: "ok", data });
    } catch (e) {
        return next(e);
    }
});

adminRouter.post("/sync-settings/run", requireAdmin, async (req, res, next) => {
    try {
        const force = req.body?.force !== false;
        const r = await runFolderSyncPipeline({ trigger: "manual", force });
        await writeAuditLog({
            actorLoginId: req.user?.loginId || null,
            action: "admin.folder_sync_run",
            summary: "手动触发镜像目录扫描入库",
            metadata: { ok: r.ok, skipped: Boolean(r.skipped), offline: Boolean(r.offline) }
        });
        return res.status(200).json({ code: 200, msg: "ok", data: r });
    } catch (e) {
        return next(e);
    }
});

adminRouter.get("/sync-settings/process-check", requireAdmin, async (req, res, next) => {
    try {
        const s = await loadKbSyncSettings();
        const tokens = parseProcessNames(s.processNames);
        const data = await checkProcessTokensDetail(tokens);
        return res.status(200).json({ code: 200, msg: "ok", data: { tokens, ...data } });
    } catch (e) {
        return next(e);
    }
});

adminRouter.get("/sync-runs", requireAdmin, async (req, res, next) => {
    try {
        const page = req.query?.page ? Number(req.query.page) : 1;
        const pageSize = req.query?.pageSize ? Number(req.query.pageSize) : 20;
        const data = await listFolderSyncRuns(page, pageSize);
        return res.status(200).json({ code: 200, msg: "ok", data });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (/kb_folder_sync_runs|Invalid object name/i.test(msg)) {
            return res.status(200).json({
                code: 200,
                msg: "ok",
                data: { page: 1, pageSize: 20, total: 0, items: [] }
            });
        }
        return next(e);
    }
});

adminRouter.post("/sync-settings/test-wecom", requireAdmin, async (req, res) => {
    try {
        const s = await loadKbSyncSettings();
        const url = resolveWecomUrl(s);
        if (!url) {
            return res.status(400).json({
                code: 400,
                msg: "未配置企业微信 Webhook（同步配置页或 KB_FOLDER_SYNC_WECOM_WEBHOOK / WECOM_WEBHOOK_URL）",
                data: {}
            });
        }
        if (!isLikelyWecomWebhookUrl(url)) {
            return res.status(400).json({
                code: 400,
                msg: "URL 应为 https 且为企业微信机器人地址（域名含 weixin.qq.com），请勿填占位符或非 webhook 链接",
                data: {}
            });
        }
        const r = await postWecomTextWithResult(url, "[知识库-同步配置] 测试消息：告警通道正常。");
        const ok = r.ok === true;
        return res.status(ok ? 200 : 502).json({
            code: ok ? 200 : 502,
            msg: ok ? "ok" : r.errmsg || r.error || "企业微信返回失败",
            data: r
        });
    } catch (e) {
        return res.status(500).json({ code: 500, msg: (e && e.message) || "失败", data: {} });
    }
});

adminRouter.post("/users/:loginId/reset-password", requireAdmin, async (req, res) => {

    const { loginId } = req.params || {};

    const newPassword = req.body?.password || process.env.DEV_DEFAULT_USER_PASSWORD || "";
    if (!String(newPassword).trim()) {
        return res.status(400).json({
            code: 400,
            msg: "请在请求体中提供 password，或在服务端环境变量 DEV_DEFAULT_USER_PASSWORD 中配置（开源版不再内置默认口令）",
            data: {}
        });
    }



    try {

        const passwordHash = await hashPassword(String(newPassword));

        await runQuery(`

            UPDATE dbo.users

            SET password_hash = N'${escapeSql(passwordHash)}',

                password_changed_at = SYSDATETIMEOFFSET(),

                must_change_password = 1

            WHERE login_id = N'${escapeSql(loginId)}';

        `);



        await writeAuditLog({

            actorLoginId: req.user?.loginId || null,

            action: "admin.user_password_reset",

            targetType: "user",

            summary: `重置用户密码：${loginId}`

        });



        return res.status(200).json({ code: 200, msg: "密码已重置", data: {} });

    } catch (e) {

        // eslint-disable-next-line no-console

        console.error("reset-password error:", e);

        return res.status(500).json({ code: 500, msg: "重置失败", data: {} });

    }

});



module.exports = { adminRouter };


