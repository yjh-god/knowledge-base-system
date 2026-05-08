/**
 * 知识图谱：实体类型 / 关系类型维护（管理员）。
 */

const express = require("express");
const crypto = require("crypto");

const { runQuery, runQueryTsv, escapeSql } = require("../lib/sqlcmd");
const { writeAuditLog } = require("../lib/auditLog");

const kgAdminRouter = express.Router();

const parseIntOr = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : d;
};

kgAdminRouter.get("/entity-types", async (req, res) => {
    try {
        const rows = await runQueryTsv(
            `
            SELECT
                CONVERT(VARCHAR(36), id),
                REPLACE(REPLACE(REPLACE(ISNULL(code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(display_name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(description, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                ISNULL(sort_order, 0),
                ISNULL(is_active, 1),
                CONVERT(NVARCHAR(40), created_at, 127)
            FROM dbo.kg_entity_types
            ORDER BY sort_order ASC, code ASC;
            `,
            { variableLengthY: 8000 }
        );
        const items = [];
        for (const p of rows || []) {
            if (!p || p.length < 7) continue;
            items.push({
                id: String(p[0] || "").trim(),
                code: String(p[1] || "").trim(),
                displayName: String(p[2] || "").trim(),
                description: String(p[3] || "").trim(),
                sortOrder: Number(p[4]) || 0,
                isActive: String(p[5]) === "1" || String(p[5]).toLowerCase() === "true",
                createdAt: String(p[6] || "").trim()
            });
        }
        return res.status(200).json({ code: 200, msg: "ok", data: { items } });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (/Invalid object name|kg_entity_types/i.test(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/010_kg_schema.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

kgAdminRouter.post("/entity-types", async (req, res) => {
    const body = req.body || {};
    const code = String(body.code || "").trim();
    const displayName = String(body.displayName || body.display_name || "").trim();
    if (!code || !displayName) {
        return res.status(400).json({ code: 400, msg: "code 与 displayName 必填", data: {} });
    }
    if (code.length > 64 || displayName.length > 128) {
        return res.status(400).json({ code: 400, msg: "字段过长", data: {} });
    }
    const description = String(body.description || "").trim().slice(0, 500);
    const sortOrder = parseIntOr(body.sortOrder ?? body.sort_order, 0);
    const id = crypto.randomUUID();
    try {
        await runQuery(`
            INSERT INTO dbo.kg_entity_types (id, code, display_name, description, sort_order, is_active)
            VALUES (
                CAST('${id.replace(/'/g, "''")}' AS UNIQUEIDENTIFIER),
                N'${escapeSql(code)}',
                N'${escapeSql(displayName)}',
                ${description ? `N'${escapeSql(description)}'` : "NULL"},
                ${sortOrder},
                1
            );
        `);
        try {
            await writeAuditLog({
                actorLoginId: req.user?.loginId || null,
                action: "kg.entity_type.create",
                targetType: "kg_entity_type",
                targetId: id,
                summary: `新增实体类型 ${code}`,
                metadata: { code, displayName }
            });
        } catch (_) {
            /* ignore */
        }
        return res.status(200).json({ code: 200, msg: "ok", data: { id } });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (/UQ_kg_entity_types_code|duplicate|2627|2601/i.test(msg)) {
            return res.status(409).json({ code: 409, msg: "code 已存在", data: {} });
        }
        if (/Invalid object name|kg_entity_types/i.test(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/010_kg_schema.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

kgAdminRouter.get("/relation-types", async (req, res) => {
    try {
        const rows = await runQueryTsv(
            `
            SELECT
                CONVERT(VARCHAR(36), id),
                REPLACE(REPLACE(REPLACE(ISNULL(code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(display_name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(description, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(domain_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(range_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                ISNULL(sort_order, 0),
                ISNULL(is_active, 1),
                CONVERT(NVARCHAR(40), created_at, 127)
            FROM dbo.kg_relation_types
            ORDER BY sort_order ASC, code ASC;
            `,
            { variableLengthY: 8000 }
        );
        const items = [];
        for (const p of rows || []) {
            if (!p || p.length < 9) continue;
            items.push({
                id: String(p[0] || "").trim(),
                code: String(p[1] || "").trim(),
                displayName: String(p[2] || "").trim(),
                description: String(p[3] || "").trim(),
                domainTypeCode: String(p[4] || "").trim() || null,
                rangeTypeCode: String(p[5] || "").trim() || null,
                sortOrder: Number(p[6]) || 0,
                isActive: String(p[7]) === "1" || String(p[7]).toLowerCase() === "true",
                createdAt: String(p[8] || "").trim()
            });
        }
        return res.status(200).json({ code: 200, msg: "ok", data: { items } });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (/Invalid object name|kg_relation_types/i.test(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/010_kg_schema.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

kgAdminRouter.post("/relation-types", async (req, res) => {
    const body = req.body || {};
    const code = String(body.code || "").trim();
    const displayName = String(body.displayName || body.display_name || "").trim();
    if (!code || !displayName) {
        return res.status(400).json({ code: 400, msg: "code 与 displayName 必填", data: {} });
    }
    if (code.length > 64 || displayName.length > 128) {
        return res.status(400).json({ code: 400, msg: "字段过长", data: {} });
    }
    const description = String(body.description || "").trim().slice(0, 500);
    const domainTypeCode = String(body.domainTypeCode || body.domain_type_code || "")
        .trim()
        .slice(0, 64);
    const rangeTypeCode = String(body.rangeTypeCode || body.range_type_code || "")
        .trim()
        .slice(0, 64);
    const sortOrder = parseIntOr(body.sortOrder ?? body.sort_order, 0);
    const id = crypto.randomUUID();
    try {
        await runQuery(`
            INSERT INTO dbo.kg_relation_types (
                id, code, display_name, description,
                domain_type_code, range_type_code, sort_order, is_active
            )
            VALUES (
                CAST('${id.replace(/'/g, "''")}' AS UNIQUEIDENTIFIER),
                N'${escapeSql(code)}',
                N'${escapeSql(displayName)}',
                ${description ? `N'${escapeSql(description)}'` : "NULL"},
                ${domainTypeCode ? `N'${escapeSql(domainTypeCode)}'` : "NULL"},
                ${rangeTypeCode ? `N'${escapeSql(rangeTypeCode)}'` : "NULL"},
                ${sortOrder},
                1
            );
        `);
        try {
            await writeAuditLog({
                actorLoginId: req.user?.loginId || null,
                action: "kg.relation_type.create",
                targetType: "kg_relation_type",
                targetId: id,
                summary: `新增关系类型 ${code}`,
                metadata: { code, displayName }
            });
        } catch (_) {
            /* ignore */
        }
        return res.status(200).json({ code: 200, msg: "ok", data: { id } });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (/UQ_kg_relation_types_code|duplicate|2627|2601/i.test(msg)) {
            return res.status(409).json({ code: 409, msg: "code 已存在", data: {} });
        }
        if (/Invalid object name|kg_relation_types/i.test(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/010_kg_schema.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

module.exports = { kgAdminRouter };
