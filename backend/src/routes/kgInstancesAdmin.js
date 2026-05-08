/**
 * 知识图谱实例：实体节点与关系边（管理员）。
 * 依赖 sql/011_kg_entities_edges.sql；关系类型保留 references / belongs_to / applies_to / supersedes。
 */

const express = require("express");
const crypto = require("crypto");

const { runQuery, runQueryTsv, runQueryScalarInt } = require("../lib/sqlcmd");
const { writeAuditLog, escapeSql } = require("../lib/auditLog");

const kgInstancesRouter = express.Router();

const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const sqlSafeUuid = (id) => String(id || "").replace(/'/g, "''");

const parsePropsJson = (raw, maxLen = 120_000) => {
    if (raw == null || raw === "") return null;
    const s = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
    if (!s) return null;
    const clipped = s.slice(0, maxLen);
    try {
        JSON.parse(clipped);
        return clipped;
    } catch {
        return "__INVALID__";
    }
};

const pageParams = (req, maxPageSize = 100) => {
    const page = Math.max(1, Math.floor(Number(req.query?.page) || 1));
    const pageSize = Math.max(1, Math.min(maxPageSize, Math.floor(Number(req.query?.pageSize) || 20)));
    return { page, pageSize, offset: (page - 1) * pageSize };
};

const migration503 = (msg) =>
    /Invalid object name|kg_entities|kg_edges/i.test(String(msg || ""));

/** GET /summary */
kgInstancesRouter.get("/summary", async (req, res) => {
    try {
        const [nEnt, nEdge, nEt, nRt] = await Promise.all([
            runQueryScalarInt(`SELECT COUNT(*) FROM dbo.kg_entities;`),
            runQueryScalarInt(`SELECT COUNT(*) FROM dbo.kg_edges;`),
            runQueryScalarInt(`SELECT COUNT(*) FROM dbo.kg_entity_types WHERE is_active = 1;`),
            runQueryScalarInt(`SELECT COUNT(*) FROM dbo.kg_relation_types WHERE is_active = 1;`)
        ]);
        return res.status(200).json({
            code: 200,
            msg: "ok",
            data: {
                entityCount: Number(nEnt) || 0,
                edgeCount: Number(nEdge) || 0,
                entityTypeCount: Number(nEt) || 0,
                relationTypeCount: Number(nRt) || 0,
                relationTypesKept: ["references", "belongs_to", "applies_to", "supersedes"]
            }
        });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/** GET /entities */
kgInstancesRouter.get("/entities", async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 500);
    const docId = req.query?.docId ? String(req.query.docId).trim() : "";
    const docClause =
        docId && UUID_RE.test(docId)
            ? `AND source_doc_id = CAST('${sqlSafeUuid(docId)}' AS UNIQUEIDENTIFIER)`
            : "";
    try {
        const total = await runQueryScalarInt(`
            SELECT COUNT(*) FROM dbo.kg_entities WHERE 1=1 ${docClause};
        `);
        const rows = await runQueryTsv(
            `
            SELECT
                CONVERT(VARCHAR(36), id),
                REPLACE(REPLACE(REPLACE(ISNULL(entity_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(CAST(properties_json AS NVARCHAR(MAX)), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                CASE WHEN source_doc_id IS NULL THEN N'' ELSE CONVERT(VARCHAR(36), source_doc_id) END,
                ISNULL(source_chunk_index, -1),
                CONVERT(NVARCHAR(40), created_at, 127)
            FROM dbo.kg_entities
            WHERE 1=1 ${docClause}
            ORDER BY created_at DESC
            OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY;
            `,
            { variableLengthY: 8000 }
        );
        const items = [];
        for (const p of rows || []) {
            if (!p || p.length < 7) continue;
            const chunkIdx = Number(p[5]);
            items.push({
                id: String(p[0] || "").trim(),
                entityTypeCode: String(p[1] || "").trim(),
                name: String(p[2] || "").trim(),
                propertiesJson: String(p[3] || "").trim(),
                sourceDocId: String(p[4] || "").trim() || null,
                sourceChunkIndex: Number.isFinite(chunkIdx) && chunkIdx >= 0 ? chunkIdx : null,
                createdAt: String(p[6] || "").trim()
            });
        }
        return res.status(200).json({
            code: 200,
            msg: "ok",
            data: { items, total: Number(total) || 0, page, pageSize }
        });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/** POST /entities */
kgInstancesRouter.post("/entities", async (req, res) => {
    const body = req.body || {};
    const entityTypeCode = String(body.entityTypeCode || body.entity_type_code || "").trim();
    const name = String(body.name || "").trim().slice(0, 512);
    if (!entityTypeCode || !name) {
        return res.status(400).json({ code: 400, msg: "entityTypeCode 与 name 必填", data: {} });
    }
    const propsRaw = parsePropsJson(body.properties ?? body.propertiesJson);
    if (propsRaw === "__INVALID__") {
        return res.status(400).json({ code: 400, msg: "properties 须为合法 JSON", data: {} });
    }
    const sourceDocId = body.sourceDocId || body.source_doc_id;
    const docOk = sourceDocId == null || sourceDocId === "" || UUID_RE.test(String(sourceDocId));
    if (!docOk) {
        return res.status(400).json({ code: 400, msg: "sourceDocId 须为 UUID 或留空", data: {} });
    }
    const chunkIdxRaw = body.sourceChunkIndex ?? body.source_chunk_index;
    const chunkIdx =
        chunkIdxRaw == null || chunkIdxRaw === ""
            ? null
            : Math.floor(Number(chunkIdxRaw));
    const chunkSql =
        chunkIdx != null && Number.isFinite(chunkIdx) && chunkIdx >= 0 ? String(chunkIdx) : "NULL";
    const docSql =
        sourceDocId && UUID_RE.test(String(sourceDocId))
            ? `CAST('${sqlSafeUuid(sourceDocId)}' AS UNIQUEIDENTIFIER)`
            : "NULL";
    const propsSql = propsRaw ? `N'${escapeSql(propsRaw)}'` : "NULL";

    const id = crypto.randomUUID();
    try {
        const okType = await runQueryScalarInt(`
            SELECT COUNT(*) FROM dbo.kg_entity_types
            WHERE code = N'${escapeSql(entityTypeCode)}' AND is_active = 1;
        `);
        if (Number(okType) !== 1) {
            return res.status(400).json({ code: 400, msg: "无效或未启用的实体类型 code", data: {} });
        }
        await runQuery(`
            INSERT INTO dbo.kg_entities (
                id, entity_type_code, name, properties_json, source_doc_id, source_chunk_index
            )
            VALUES (
                CAST('${sqlSafeUuid(id)}' AS UNIQUEIDENTIFIER),
                N'${escapeSql(entityTypeCode)}',
                N'${escapeSql(name)}',
                ${propsSql},
                ${docSql},
                ${chunkSql}
            );
        `);
        try {
            await writeAuditLog({
                actorLoginId: req.user?.loginId || null,
                action: "kg.entity.create",
                targetType: "kg_entity",
                targetId: id,
                summary: `新增实体 ${entityTypeCode}: ${name.slice(0, 80)}`,
                metadata: { entityTypeCode }
            });
        } catch (_) {
            /* ignore */
        }
        return res.status(200).json({ code: 200, msg: "ok", data: { id } });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        if (/FK_kg_entities_entity_type|547|foreign key/i.test(msg)) {
            return res.status(400).json({ code: 400, msg: "实体类型不存在", data: {} });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/** DELETE /entities/:id */
kgInstancesRouter.delete("/entities/:id", async (req, res) => {
    const { id } = req.params || {};
    if (!UUID_RE.test(String(id || ""))) {
        return res.status(400).json({ code: 400, msg: "id 须为 UUID", data: {} });
    }
    const sid = sqlSafeUuid(id);
    try {
        await runQuery(`
            DELETE FROM dbo.kg_edges
            WHERE from_entity_id = CAST('${sid}' AS UNIQUEIDENTIFIER)
               OR to_entity_id = CAST('${sid}' AS UNIQUEIDENTIFIER);
            DELETE FROM dbo.kg_entities WHERE id = CAST('${sid}' AS UNIQUEIDENTIFIER);
        `);
        try {
            await writeAuditLog({
                actorLoginId: req.user?.loginId || null,
                action: "kg.entity.delete",
                targetType: "kg_entity",
                targetId: id,
                summary: "删除实体及其关联边",
                metadata: {}
            });
        } catch (_) {
            /* ignore */
        }
        return res.status(200).json({ code: 200, msg: "ok", data: {} });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/** GET /edges */
kgInstancesRouter.get("/edges", async (req, res) => {
    const { page, pageSize, offset } = pageParams(req);
    const docId = req.query?.docId ? String(req.query.docId).trim() : "";
    const docClause =
        docId && UUID_RE.test(docId)
            ? `AND e.source_doc_id = CAST('${sqlSafeUuid(docId)}' AS UNIQUEIDENTIFIER)`
            : "";
    try {
        const total = await runQueryScalarInt(`
            SELECT COUNT(*) FROM dbo.kg_edges e WHERE 1=1 ${docClause};
        `);
        const rows = await runQueryTsv(
            `
            SELECT
                CONVERT(VARCHAR(36), e.id),
                REPLACE(REPLACE(REPLACE(ISNULL(e.relation_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                CONVERT(VARCHAR(36), e.from_entity_id),
                CONVERT(VARCHAR(36), e.to_entity_id),
                REPLACE(REPLACE(REPLACE(ISNULL(fe.name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(te.name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(fe.entity_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(te.entity_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                CASE WHEN e.source_doc_id IS NULL THEN N'' ELSE CONVERT(VARCHAR(36), e.source_doc_id) END,
                ISNULL(e.confidence, -1),
                CONVERT(NVARCHAR(40), e.created_at, 127)
            FROM dbo.kg_edges e
            INNER JOIN dbo.kg_entities fe ON fe.id = e.from_entity_id
            INNER JOIN dbo.kg_entities te ON te.id = e.to_entity_id
            WHERE 1=1 ${docClause}
            ORDER BY e.created_at DESC
            OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY;
            `,
            { variableLengthY: 8000 }
        );
        const items = [];
        for (const p of rows || []) {
            if (!p || p.length < 11) continue;
            const conf = Number(p[9]);
            items.push({
                id: String(p[0] || "").trim(),
                relationTypeCode: String(p[1] || "").trim(),
                fromEntityId: String(p[2] || "").trim(),
                toEntityId: String(p[3] || "").trim(),
                fromName: String(p[4] || "").trim(),
                toName: String(p[5] || "").trim(),
                fromEntityTypeCode: String(p[6] || "").trim(),
                toEntityTypeCode: String(p[7] || "").trim(),
                sourceDocId: String(p[8] || "").trim() || null,
                confidence: Number.isFinite(conf) && conf >= 0 ? conf : null,
                createdAt: String(p[10] || "").trim()
            });
        }
        return res.status(200).json({
            code: 200,
            msg: "ok",
            data: { items, total: Number(total) || 0, page, pageSize }
        });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

const graphEdgeLimit = (req) => {
    const n = Math.floor(Number(req.query?.limit) || 400);
    return Math.max(50, Math.min(1500, n));
};

/**
 * GET /source-docs — 在 kg_entities / kg_edges 中出现过的来源文档（供双层图谱第一层列表）
 */
kgInstancesRouter.get("/source-docs", async (req, res) => {
    try {
        const rows = await runQueryTsv(
            `
            WITH doc_ids AS (
                SELECT DISTINCT source_doc_id AS doc_id
                FROM dbo.kg_entities
                WHERE source_doc_id IS NOT NULL
                UNION
                SELECT DISTINCT source_doc_id AS doc_id
                FROM dbo.kg_edges
                WHERE source_doc_id IS NOT NULL
            )
            SELECT
                CONVERT(VARCHAR(36), x.doc_id),
                REPLACE(REPLACE(REPLACE(ISNULL(d.title, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(d.storage_key, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(d.mirror_rel_path, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
            FROM doc_ids x
            LEFT JOIN dbo.documents d ON d.id = x.doc_id AND d.deleted_at IS NULL
            WHERE x.doc_id IS NOT NULL
            ORDER BY CASE WHEN d.id IS NULL THEN 1 ELSE 0 END,
                CASE WHEN d.updated_at IS NULL THEN '1970-01-01' ELSE CONVERT(VARCHAR(40), d.updated_at, 127) END DESC;
            `,
            { variableLengthY: 8000 }
        );
        const items = [];
        for (const p of rows || []) {
            if (!p || p.length < 4) continue;
            const id = String(p[0] || "").trim();
            if (!UUID_RE.test(id)) continue;
            const title = String(p[1] || "").trim();
            const storageKey = String(p[2] || "").trim();
            const mirrorRel = String(p[3] || "").trim();
            const displayTitle =
                title ||
                (mirrorRel ? mirrorRel.split("/").pop() : "") ||
                storageKey.split("/").pop() ||
                id.slice(0, 8);
            items.push({
                id,
                title: title || displayTitle,
                storageKey: storageKey || null,
                mirrorRelPath: mirrorRel || null,
                documentMissing: !title && !storageKey && !mirrorRel
            });
        }
        return res.status(200).json({ code: 200, msg: "ok", data: { items } });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/**
 * GET /library-hub-graph — 第一层：中心「知识库」+ 分支为各文件名（文档节点）
 */
kgInstancesRouter.get("/library-hub-graph", async (req, res) => {
    const lim = Math.max(20, Math.min(600, Math.floor(Number(req.query?.limit) || 400)));
    try {
        const docTotal = await runQueryScalarInt(`
            SELECT COUNT(*)
            FROM dbo.documents
            WHERE deleted_at IS NULL AND status <> N'deleted';
        `);
        const rows = await runQueryTsv(
            `
            SELECT TOP (${lim})
                CONVERT(VARCHAR(36), id),
                REPLACE(REPLACE(REPLACE(ISNULL(title, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(storage_key, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(mirror_rel_path, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
            FROM dbo.documents
            WHERE deleted_at IS NULL AND status <> N'deleted'
            ORDER BY updated_at DESC;
            `,
            { variableLengthY: 8000 }
        );
        const documents = [];
        for (const p of rows || []) {
            if (!p || p.length < 4) continue;
            const id = String(p[0] || "").trim();
            if (!UUID_RE.test(id)) continue;
            const title = String(p[1] || "").trim();
            const storageKey = String(p[2] || "").trim();
            const mirrorRel = String(p[3] || "").trim();
            const displayTitle =
                title ||
                (mirrorRel ? mirrorRel.split("/").pop() : "") ||
                (storageKey ? storageKey.split("/").pop() : "") ||
                id.slice(0, 8);
            documents.push({
                id,
                title: displayTitle,
                titleRaw: title || null,
                storageKey: storageKey || null,
                mirrorRelPath: mirrorRel || null
            });
        }
        const truncated = Number(docTotal) > lim;
        return res.status(200).json({
            code: 200,
            msg: "ok",
            data: {
                documents,
                docTotal: Number(docTotal) || 0,
                limit: lim,
                truncated
            }
        });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg) || /Invalid column name.*mirror_rel_path/i.test(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库缺少 mirror_rel_path 等列：请执行 backend/sql/005_documents_md5_and_sources.sql；图谱表请执行 011_kg_entities_edges.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/**
 * GET /entity-search-global — 第一层左侧：按实体名关键字检索，返回关联文档，供点击跳转第二层
 */
kgInstancesRouter.get("/entity-search-global", async (req, res) => {
    const q = req.query?.q != null ? String(req.query.q).trim() : "";
    const lim = Math.max(1, Math.min(120, Math.floor(Number(req.query?.limit) || 60)));
    if (q.length < 1) {
        return res.status(200).json({ code: 200, msg: "ok", data: { items: [] } });
    }
    const qPat = escapeSql(q.slice(0, 200).replace(/%/g, "").replace(/_/g, "").replace(/\[/g, ""));
    const like = `%${qPat}%`;
    try {
        const rows = await runQueryTsv(
            `
            SELECT TOP (${lim})
                CONVERT(VARCHAR(36), e.id),
                REPLACE(REPLACE(REPLACE(ISNULL(e.entity_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(e.name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                CONVERT(VARCHAR(36), e.source_doc_id),
                REPLACE(REPLACE(REPLACE(ISNULL(d.title, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(d.storage_key, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(d.mirror_rel_path, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                ISNULL(e.source_chunk_index, -1)
            FROM dbo.kg_entities e
            INNER JOIN dbo.documents d
                ON d.id = e.source_doc_id
                AND d.deleted_at IS NULL
                AND d.status <> N'deleted'
            WHERE e.source_doc_id IS NOT NULL
              AND e.name LIKE N'${like}'
            ORDER BY d.updated_at DESC, e.name;
            `,
            { variableLengthY: 8000 }
        );
        const items = [];
        for (const p of rows || []) {
            if (!p || p.length < 8) continue;
            const entityId = String(p[0] || "").trim();
            const docId = String(p[3] || "").trim();
            if (!UUID_RE.test(entityId) || !UUID_RE.test(docId)) continue;
            const title = String(p[4] || "").trim();
            const storageKey = String(p[5] || "").trim();
            const mirrorRel = String(p[6] || "").trim();
            const chunkIdx = Number(p[7]);
            const docTitle =
                title ||
                (mirrorRel ? mirrorRel.split("/").pop() : "") ||
                (storageKey ? storageKey.split("/").pop() : "") ||
                docId.slice(0, 8);
            items.push({
                id: entityId,
                name: String(p[2] || "").trim(),
                entityTypeCode: String(p[1] || "").trim(),
                sourceDocId: docId,
                docTitle,
                storageKey: storageKey || null,
                mirrorRelPath: mirrorRel || null,
                sourceChunkIndex: Number.isFinite(chunkIdx) && chunkIdx >= 0 ? chunkIdx : null
            });
        }
        return res.status(200).json({ code: 200, msg: "ok", data: { items } });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/**
 * GET /entity-search — 在当前文档图谱内按实体名称关键字检索（第二层左侧检索）
 */
kgInstancesRouter.get("/entity-search", async (req, res) => {
    const docId = req.query?.docId ? String(req.query.docId).trim() : "";
    const q = req.query?.q != null ? String(req.query.q).trim() : "";
    const lim = Math.max(1, Math.min(80, Math.floor(Number(req.query?.limit) || 30)));
    if (!docId || !UUID_RE.test(docId)) {
        return res.status(400).json({ code: 400, msg: "docId 须为 UUID", data: {} });
    }
    if (q.length < 1) {
        return res.status(200).json({ code: 200, msg: "ok", data: { items: [] } });
    }
    const qPat = escapeSql(q.slice(0, 200).replace(/%/g, "").replace(/_/g, "").replace(/\[/g, ""));
    const like = `%${qPat}%`;
    try {
        const rows = await runQueryTsv(
            `
            SELECT TOP (${lim})
                CONVERT(VARCHAR(36), id),
                REPLACE(REPLACE(REPLACE(ISNULL(entity_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                ISNULL(source_chunk_index, -1)
            FROM dbo.kg_entities
            WHERE source_doc_id = CAST('${sqlSafeUuid(docId)}' AS UNIQUEIDENTIFIER)
              AND name LIKE N'${like}'
            ORDER BY name;
            `,
            { variableLengthY: 8000 }
        );
        const items = [];
        for (const p of rows || []) {
            if (!p || p.length < 4) continue;
            const chunkIdx = Number(p[3]);
            items.push({
                id: String(p[0] || "").trim(),
                entityTypeCode: String(p[1] || "").trim(),
                name: String(p[2] || "").trim(),
                sourceChunkIndex: Number.isFinite(chunkIdx) && chunkIdx >= 0 ? chunkIdx : null
            });
        }
        return res.status(200).json({ code: 200, msg: "ok", data: { items } });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/** GET /graph — ECharts 力导图：边优先，再取端点实体 */
kgInstancesRouter.get("/graph", async (req, res) => {
    const limit = graphEdgeLimit(req);
    const docId = req.query?.docId ? String(req.query.docId).trim() : "";
    const docClause =
        docId && UUID_RE.test(docId)
            ? `AND e.source_doc_id = CAST('${sqlSafeUuid(docId)}' AS UNIQUEIDENTIFIER)`
            : "";
    if (docId && !UUID_RE.test(docId)) {
        return res.status(400).json({ code: 400, msg: "docId 须为 UUID", data: {} });
    }
    try {
        const edgeTotal = await runQueryScalarInt(`
            SELECT COUNT(*) FROM dbo.kg_edges e WHERE 1=1 ${docClause};
        `);
        const edgeRows = await runQueryTsv(
            `
            SELECT
                CONVERT(VARCHAR(36), e.from_entity_id),
                CONVERT(VARCHAR(36), e.to_entity_id),
                REPLACE(REPLACE(REPLACE(ISNULL(e.relation_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(rt.display_name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
            FROM dbo.kg_edges e
            LEFT JOIN dbo.kg_relation_types rt ON rt.code = e.relation_type_code
            WHERE 1=1 ${docClause}
            ORDER BY e.created_at DESC
            OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY;
            `,
            { variableLengthY: 4000 }
        );
        const idSet = new Set();
        const links = [];
        for (const p of edgeRows || []) {
            if (!p || p.length < 4) continue;
            const fromId = String(p[0] || "").trim();
            const toId = String(p[1] || "").trim();
            const relCode = String(p[2] || "").trim();
            let relDisp = String(p[3] || "").trim();
            if (!fromId || !toId || !UUID_RE.test(fromId) || !UUID_RE.test(toId)) continue;
            idSet.add(fromId);
            idSet.add(toId);
            if (!relDisp) relDisp = relCode;
            links.push({
                source: fromId,
                target: toId,
                relationTypeCode: relCode,
                relationDisplayName: relDisp || relCode
            });
        }
        const ids = [...idSet];
        let nodes = [];
        if (ids.length > 0) {
            const inList = ids.map((id) => `CAST('${sqlSafeUuid(id)}' AS UNIQUEIDENTIFIER)`).join(",");
            const entRows = await runQueryTsv(
                `
                SELECT
                    CONVERT(VARCHAR(36), id),
                    REPLACE(REPLACE(REPLACE(ISNULL(entity_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                    REPLACE(REPLACE(REPLACE(ISNULL(name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
                FROM dbo.kg_entities
                WHERE id IN (${inList});
                `,
                { variableLengthY: 8000 }
            );
            for (const r of entRows || []) {
                if (!r || r.length < 3) continue;
                nodes.push({
                    id: String(r[0] || "").trim(),
                    entityTypeCode: String(r[1] || "").trim(),
                    name: String(r[2] || "").trim()
                });
            }
        }
        const nodeIds = new Set(nodes.map((n) => n.id));
        const linksFiltered = links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target));
        const truncated = Number(edgeTotal) > limit;
        return res.status(200).json({
            code: 200,
            msg: "ok",
            data: {
                nodes,
                links: linksFiltered,
                edgeTotal: Number(edgeTotal) || 0,
                limit,
                truncated
            }
        });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/** POST /edges */
kgInstancesRouter.post("/edges", async (req, res) => {
    const body = req.body || {};
    const relationTypeCode = String(body.relationTypeCode || body.relation_type_code || "").trim();
    const fromEntityId = String(body.fromEntityId || body.from_entity_id || "").trim();
    const toEntityId = String(body.toEntityId || body.to_entity_id || "").trim();
    if (!relationTypeCode || !fromEntityId || !toEntityId) {
        return res.status(400).json({
            code: 400,
            msg: "relationTypeCode、fromEntityId、toEntityId 必填",
            data: {}
        });
    }
    if (!UUID_RE.test(fromEntityId) || !UUID_RE.test(toEntityId)) {
        return res.status(400).json({ code: 400, msg: "实体 id 须为 UUID", data: {} });
    }
    if (fromEntityId === toEntityId) {
        return res.status(400).json({ code: 400, msg: "不允许自环边（头尾同一实体）", data: {} });
    }
    const propsRaw = parsePropsJson(body.properties ?? body.propertiesJson);
    if (propsRaw === "__INVALID__") {
        return res.status(400).json({ code: 400, msg: "properties 须为合法 JSON", data: {} });
    }
    const sourceDocId = body.sourceDocId || body.source_doc_id;
    const docSql =
        sourceDocId && UUID_RE.test(String(sourceDocId))
            ? `CAST('${sqlSafeUuid(sourceDocId)}' AS UNIQUEIDENTIFIER)`
            : "NULL";
    const confRaw = body.confidence;
    const conf =
        confRaw == null || confRaw === ""
            ? null
            : Number(confRaw);
    const confSql =
        conf != null && Number.isFinite(conf) && conf >= 0 && conf <= 1 ? String(conf) : "NULL";
    const propsSql = propsRaw ? `N'${escapeSql(propsRaw)}'` : "NULL";

    try {
        const relRows = await runQueryTsv(
            `
            SELECT
                REPLACE(REPLACE(REPLACE(ISNULL(domain_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(range_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
            FROM dbo.kg_relation_types
            WHERE code = N'${escapeSql(relationTypeCode)}' AND is_active = 1;
            `,
            { variableLengthY: 4000 }
        );
        const rel = relRows && relRows[0];
        if (!rel || rel.length < 2) {
            return res.status(400).json({ code: 400, msg: "无效或未启用的关系类型 code", data: {} });
        }
        const domainType = String(rel[0] || "").trim() || null;
        const rangeType = String(rel[1] || "").trim() || null;

        const fromRows = await runQueryTsv(
            `
            SELECT REPLACE(REPLACE(REPLACE(ISNULL(entity_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
            FROM dbo.kg_entities WHERE id = CAST('${sqlSafeUuid(fromEntityId)}' AS UNIQUEIDENTIFIER);
            `,
            { variableLengthY: 4000 }
        );
        const toRows = await runQueryTsv(
            `
            SELECT REPLACE(REPLACE(REPLACE(ISNULL(entity_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
            FROM dbo.kg_entities WHERE id = CAST('${sqlSafeUuid(toEntityId)}' AS UNIQUEIDENTIFIER);
            `,
            { variableLengthY: 4000 }
        );
        const fromType = fromRows?.[0]?.[0] != null ? String(fromRows[0][0]).trim() : "";
        const toType = toRows?.[0]?.[0] != null ? String(toRows[0][0]).trim() : "";
        if (!fromType || !toType) {
            return res.status(400).json({ code: 400, msg: "头或尾实体不存在", data: {} });
        }
        if (domainType && fromType !== domainType) {
            return res.status(400).json({
                code: 400,
                msg: `关系「${relationTypeCode}」要求头实体类型为 ${domainType}，当前为 ${fromType}`,
                data: {}
            });
        }
        if (rangeType && toType !== rangeType) {
            return res.status(400).json({
                code: 400,
                msg: `关系「${relationTypeCode}」要求尾实体类型为 ${rangeType}，当前为 ${toType}`,
                data: {}
            });
        }

        const id = crypto.randomUUID();
        await runQuery(`
            INSERT INTO dbo.kg_edges (
                id, relation_type_code, from_entity_id, to_entity_id,
                properties_json, source_doc_id, confidence
            )
            VALUES (
                CAST('${sqlSafeUuid(id)}' AS UNIQUEIDENTIFIER),
                N'${escapeSql(relationTypeCode)}',
                CAST('${sqlSafeUuid(fromEntityId)}' AS UNIQUEIDENTIFIER),
                CAST('${sqlSafeUuid(toEntityId)}' AS UNIQUEIDENTIFIER),
                ${propsSql},
                ${docSql},
                ${confSql}
            );
        `);
        try {
            await writeAuditLog({
                actorLoginId: req.user?.loginId || null,
                action: "kg.edge.create",
                targetType: "kg_edge",
                targetId: id,
                summary: `新增关系 ${relationTypeCode}`,
                metadata: { fromEntityId, toEntityId }
            });
        } catch (_) {
            /* ignore */
        }
        return res.status(200).json({ code: 200, msg: "ok", data: { id } });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        if (/CK_kg_edges_no_self_loop|547|foreign key/i.test(msg)) {
            return res.status(400).json({ code: 400, msg: "无法创建边（实体不存在、自环或外键约束）", data: {} });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/** DELETE /edges/:id */
kgInstancesRouter.delete("/edges/:id", async (req, res) => {
    const { id } = req.params || {};
    if (!UUID_RE.test(String(id || ""))) {
        return res.status(400).json({ code: 400, msg: "id 须为 UUID", data: {} });
    }
    const sid = sqlSafeUuid(id);
    try {
        await runQuery(`
            DELETE FROM dbo.kg_edges WHERE id = CAST('${sid}' AS UNIQUEIDENTIFIER);
        `);
        try {
            await writeAuditLog({
                actorLoginId: req.user?.loginId || null,
                action: "kg.edge.delete",
                targetType: "kg_edge",
                targetId: id,
                summary: "删除关系边",
                metadata: {}
            });
        } catch (_) {
            /* ignore */
        }
        return res.status(200).json({ code: 200, msg: "ok", data: {} });
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/011_kg_entities_edges.sql",
                data: {}
            });
        }
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

module.exports = { kgInstancesRouter };
