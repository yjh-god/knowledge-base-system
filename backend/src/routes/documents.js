const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { runQuery, runQueryScalarInt, runQueryTsv } = require("../lib/sqlcmd");
const { writeAuditLog, escapeSql } = require("../lib/auditLog");
const { getIngestDebugSnapshot } = require("../lib/ingestDebugState");
const {
    getUploadsDir,
    resolveStorageKeyToAbsolute,
    formatUploadsDateSegment
} = require("../lib/storagePaths");
const { md5Hex, sha256Hex } = require("../lib/contentFingerprints");
const { decodeMultipartFilename } = require("../lib/utf8Filename");
const { sanitizeStorageBasename } = require("../lib/sanitizeStorageFilename");
const { enrichDocumentListItems } = require("../lib/documentListEnrich");
const { sqlIntOrNull, sqlNVarCharOrNull } = require("../lib/sqlLiteral");
const { tryBeginIngestSection, endIngestSection } = require("../lib/ingestConcurrency");
const { expandVisibleDeptIdsForIngest } = require("../lib/deptScopeExpand");
const { normalizeVisibleDeptIdsForPayload } = require("../lib/deptIdsForQdrant");
const { getEmbeddingModelVersion } = require("../lib/embeddingModelVersion");
const { documentWriteRateLimit } = require("../lib/apiRateLimit");
const { cancelQueuedImmediateUploadForDocument } = require("../lib/cancelQueuedIngestJobs");

const documentsRouter = express.Router();

const intCell = (s) => {
    const t = String(s ?? "").trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
};

const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const KNOWLEDGE_TYPES = new Set(["FAQ", "制度", "方案", "文档"]);

const parseKnowledgeType = (raw) => {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    return KNOWLEDGE_TYPES.has(s) ? s : null;
};

const parseOptionalString = (raw, maxLen) => {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    return s.slice(0, maxLen);
};

// 内存接收文件后由路由负责落盘与入库：便于兼容前端直接上传文件/文件夹内容
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
});

const parseVisibleDeptIds = (v) => {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    if (typeof v !== "string") return [];
    const raw = v.trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
    } catch (_) {
        /* ignore */
    }
    return raw.split(",").map((x) => x.trim()).filter(Boolean);
};

const parseDeptScopeIncludeChildren = (body) =>
    String(body?.deptScopeIncludeChildren || "") === "1" ||
    body?.deptScopeIncludeChildren === true;

const parseCategoryDeptIds = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (v == null) return [];
    if (typeof v !== "string") return [];
    const raw = v.trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch (_) {
        /* ignore */
    }
    return raw.split(",").map((x) => x.trim()).filter(Boolean);
};

const categorySameAsVisibleFromBody = (body) => {
    if (body?.categorySameAsVisible === false || String(body?.categorySameAsVisible || "") === "0") {
        return false;
    }
    return true;
};

const parseCategoryScopeIncludeChildren = (body) =>
    String(body?.categoryDeptScopeIncludeChildren || "") === "1" ||
    body?.categoryDeptScopeIncludeChildren === true;

/**
 * 可检索部门 + 文件类属部门（知识图谱分类用，写入 dept_scope_json.category_nodes）。
 */
const resolveDeptScopeForUpload = async (body, visibleDeptIds, includeChildren, companyWide) => {
    const buildNodes = (ids, inc) =>
        ids.map((id) => ({
            dept_id: String(id),
            include_children: !!inc
        }));

    if (companyWide) {
        return {
            deptScopeJson: JSON.stringify({
                nodes: [],
                is_company_wide: true,
                category_nodes: [],
                category_is_company_wide: true
            }),
            expandedVisibleDeptIds: ["*"]
        };
    }

    const nodes = buildNodes(visibleDeptIds, includeChildren);
    const sameCat = categorySameAsVisibleFromBody(body);
    const categoryDeptIds = parseCategoryDeptIds(body?.categoryDeptIds);
    const categoryInc = parseCategoryScopeIncludeChildren(body);

    let category_nodes;
    let category_is_company_wide = false;
    if (sameCat || categoryDeptIds.length === 0) {
        category_nodes = buildNodes(visibleDeptIds, includeChildren);
    } else {
        category_nodes = buildNodes(categoryDeptIds, categoryInc);
    }

    const deptScopeJson = JSON.stringify({
        nodes,
        is_company_wide: false,
        category_nodes,
        category_is_company_wide
    });

    let expanded = visibleDeptIds.map((x) => String(x).trim()).filter(Boolean);
    try {
        expanded = await expandVisibleDeptIdsForIngest(nodes);
    } catch (_) {
        /* departments 未就绪时仍用勾选 id */
    }
    return { deptScopeJson, expandedVisibleDeptIds: expanded };
};

const isSqlcmdRowCountLine = (t) =>
    /^\(\d+/.test(t) &&
    (/(rows?\s+affected|row\s+affected)/i.test(t) || t.includes("\u884c\u53d7\u5f71\u54cd"));

const parseIndexJobsAggCsv = (stdout) => {
    for (const raw of String(stdout || "").split(/\r?\n/)) {
        const t = raw.trim();
        if (!t) continue;
        if (isSqlcmdRowCountLine(t)) continue;
        const cleaned = t.replace(/\s+/g, "");
        if (/^\d+(,\d+){4}$/.test(cleaned)) {
            const parts = cleaned.split(",").map((x) => Number(x));
            return {
                total: parts[0],
                finished: parts[1],
                succeeded: parts[2],
                failed: parts[3],
                pending: parts[4]
            };
        }
    }
    return null;
};

const parseTabSeparatedErrorRows = (stdout) => {
    const out = [];
    for (const raw of String(stdout || "").split(/\r?\n/)) {
        const line = raw.trimEnd();
        const t = line.trim();
        if (!t) continue;
        if (isSqlcmdRowCountLine(t)) continue;
        const parts = line.split("\t").map((c) => c.trim());
        if (parts.length >= 3) {
            out.push({
                documentId: parts[0],
                fileName: parts[1],
                errorMessage: parts.slice(2).join("\t")
            });
        }
    }
    return out;
};

documentsRouter.get("/", async (req, res) => {
    const page = req.query?.page ? Number(req.query.page) : 1;
    const pageSize = req.query?.pageSize ? Number(req.query.pageSize) : 20;
    const safePageSize = Math.max(1, Math.min(100, pageSize));
    const offset = Math.max(0, (page - 1) * safePageSize);

    try {
        const total = await runQueryScalarInt(`
            SELECT COUNT(*) FROM dbo.documents WHERE status <> N'deleted';
        `);
        const rows = await runQueryTsv(
            `
            SELECT
                CONVERT(VARCHAR(36), d.id),
                REPLACE(REPLACE(REPLACE(ISNULL(d.title, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                ISNULL(d.status, N''),
                REPLACE(REPLACE(REPLACE(ISNULL(d.mime_type, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                CAST(d.size_bytes AS VARCHAR(30)),
                CONVERT(VARCHAR(40), d.created_at, 126),
                CONVERT(VARCHAR(40), d.updated_at, 126),
                REPLACE(REPLACE(REPLACE(ISNULL(CAST(d.dept_scope_json AS NVARCHAR(MAX)), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                ISNULL(CAST(d.vector_dim AS VARCHAR(20)), N''),
                ISNULL(CAST(d.chunk_count AS VARCHAR(20)), N''),
                ISNULL(CAST(d.embedding_batch_size AS VARCHAR(20)), N''),
                ISNULL(CAST(d.chunk_size AS VARCHAR(20)), N''),
                ISNULL(CAST(d.chunk_overlap AS VARCHAR(20)), N''),
                REPLACE(REPLACE(REPLACE(ISNULL(d.embedding_model, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(d.storage_key, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                ISNULL(CAST(last_ingest.ingest_ms AS VARCHAR(30)), N'')
            FROM dbo.documents d
            OUTER APPLY (
                SELECT TOP (1)
                    CASE
                        WHEN j.finished_at IS NOT NULL
                            AND COALESCE(j.started_at, j.created_at) IS NOT NULL
                            AND j.finished_at >= COALESCE(j.started_at, j.created_at)
                        THEN DATEDIFF(
                            MILLISECOND,
                            COALESCE(j.started_at, j.created_at),
                            j.finished_at
                        )
                        ELSE NULL
                    END AS ingest_ms
                FROM dbo.index_jobs j
                WHERE j.document_id = d.id
                  AND j.status = N'success'
                  AND j.job_type = N'immediate_upload'
                ORDER BY j.finished_at DESC
            ) last_ingest
            WHERE d.status <> N'deleted'
            ORDER BY d.updated_at DESC
            OFFSET ${offset} ROWS FETCH NEXT ${safePageSize} ROWS ONLY
            `,
            { variableLengthY: 8000 }
        );
        const rawItems = rows.map((c) => {
            const ingestRaw = (c[15] || "").trim();
            let ingestDurationMs = null;
            if (ingestRaw) {
                const n = Number(ingestRaw);
                if (Number.isFinite(n) && n >= 0) ingestDurationMs = n;
            }
            return {
                id: c[0] || "",
                title: c[1] || "",
                status: c[2] || "",
                mimeType: c[3] || "",
                sizeBytes: Number(c[4]) || 0,
                createdAt: c[5] || "",
                updatedAt: c[6] || "",
                deptScopeJsonRaw: c[7] || "",
                vectorDim: intCell(c[8]),
                chunkCount: intCell(c[9]),
                embeddingBatchSize: intCell(c[10]),
                chunkSize: intCell(c[11]),
                chunkOverlap: intCell(c[12]),
                embeddingModel: (c[13] || "").trim() || null,
                storageKey: (c[14] || "").trim() || null,
                ingestDurationMs
            };
        });
        const enriched = await enrichDocumentListItems(rawItems);
        const items = enriched.map((row) => ({
            ...row,
            absolutePath: row.storageKey ? resolveStorageKeyToAbsolute(row.storageKey) : null
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
        const msg = (e && e.message) || String(e);
        if (/Invalid column name|vector_dim|chunk_count|embedding_batch_size/i.test(msg)) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/009_documents_index_meta.sql 后重试",
                data: {}
            });
        }
        // eslint-disable-next-line no-console
        console.error("documents list:", e);
        return res.status(500).json({ code: 500, msg: "读取文档列表失败", data: {} });
    }
});

// 查询批量上传处理进度（batchId = POST /upload 返回的批次）
documentsRouter.get("/upload-batch/:batchId", async (req, res) => {
    const { batchId } = req.params || {};
    if (!batchId || !UUID_RE.test(String(batchId))) {
        return res.status(400).json({ code: 400, msg: "batchId 必须是 UUID", data: {} });
    }
    const bid = String(batchId);
    try {
        const aggStdout = await runQuery(`
            SELECT CONCAT(
                CAST(COUNT(*) AS VARCHAR(20)), ',',
                CAST(ISNULL(SUM(CASE WHEN status IN (N'success', N'failed', N'cancelled') THEN 1 ELSE 0 END), 0) AS VARCHAR(20)), ',',
                CAST(ISNULL(SUM(CASE WHEN status = N'success' THEN 1 ELSE 0 END), 0) AS VARCHAR(20)), ',',
                CAST(ISNULL(SUM(CASE WHEN status = N'failed' THEN 1 ELSE 0 END), 0) AS VARCHAR(20)), ',',
                CAST(ISNULL(SUM(CASE WHEN status IN (N'queued', N'running') THEN 1 ELSE 0 END), 0) AS VARCHAR(20))
            ) AS agg
            FROM dbo.index_jobs
            WHERE batch_id = CAST('${bid}' AS UNIQUEIDENTIFIER);
        `);
        const agg = parseIndexJobsAggCsv(aggStdout);

        if (!agg || Number(agg.total) === 0) {
            return res.status(404).json({ code: 404, msg: "批次不存在或无关联任务", data: {} });
        }

        const total = Number(agg.total) || 0;
        const finished = Number(agg.finished) || 0;
        const succeeded = Number(agg.succeeded) || 0;
        const failed = Number(agg.failed) || 0;
        const pending = Number(agg.pending) || 0;
        const progressPercent = total > 0 ? Math.min(100, Math.round((finished / total) * 100)) : 0;

        let status = "processing";
        if (finished >= total) {
            if (failed === 0) status = "success";
            else if (succeeded === 0) status = "failed";
            else status = "partial";
        }

        let errors = [];
        try {
            const errStdout = await runQuery(
                `
            SELECT
                CONVERT(VARCHAR(36), j.document_id),
                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(d.title, N''), CHAR(9), N' '), CHAR(13), N' '), CHAR(10), N''), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(j.error_message, N''), CHAR(9), N' '), CHAR(13), N' '), CHAR(10), N''), N'')
            FROM dbo.index_jobs j
            LEFT JOIN dbo.documents d ON d.id = j.document_id
            WHERE j.batch_id = CAST('${bid}' AS UNIQUEIDENTIFIER) AND j.status = N'failed'
            `,
                { columnSeparator: "\t" }
            );
            errors = parseTabSeparatedErrorRows(errStdout);
        } catch (_) {
            errors = [];
        }

        const showIngestDebug =
            process.env.INGEST_DEBUG === "1" || String(req.query?.debug || "") === "1";
        const data = {
            batchId: bid,
            total,
            finished,
            succeeded,
            failed,
            pending,
            progressPercent,
            status,
            errors
        };
        if (showIngestDebug) {
            data.ingestDebug = getIngestDebugSnapshot();
        }

        return res.status(200).json({
            code: 200,
            msg: "ok",
            data
        });
    } catch (e) {
        const msg = (e && e.message) || String(e);
        if (msg.includes("batch_id") || msg.includes("Invalid column name")) {
            return res.status(503).json({
                code: 503,
                msg: "数据库未执行迁移：请运行 backend/sql/004_index_jobs_batch_id.sql 为 index_jobs 增加 batch_id",
                data: {}
            });
        }
        // eslint-disable-next-line no-console
        console.error("upload-batch:", e);
        return res.status(500).json({ code: 500, msg: "查询批次失败", data: {} });
    }
});

// 文件上传：落盘 + 写入 pending_index + 入队 immediate_upload；立即返回 batchId，处理由 ingestJobPoller 异步完成
documentsRouter.post(
    "/upload",
    (req, res, next) => void documentWriteRateLimit(req, res, next).catch(next),
    upload.array("files", 30),
    async (req, res) => {
    const body = req.body || {};
    const files = Array.isArray(req.files) ? req.files : [];
    const visibleDeptIds = parseVisibleDeptIds(body.visibleDeptIds);
    const companyWide =
        String(req.user?.role || "").toLowerCase() === "admin" &&
        (body.deptScopeCompanyWide === true ||
            body.deptScopeCompanyWide === "1" ||
            body.deptScopeCompanyWide === "true");

    if (files.length === 0) {
        return res.status(400).json({ code: 400, msg: "未检测到上传文件(files)", data: {} });
    }
    if (
        !companyWide &&
        (!Array.isArray(visibleDeptIds) || visibleDeptIds.length === 0)
    ) {
        return res.status(400).json({ code: 400, msg: "visibleDeptIds 必填（非空数组）", data: {} });
    }

    const rawKtUpload = body.knowledgeType ?? body.knowledge_type;
    if (
        rawKtUpload != null &&
        String(rawKtUpload).trim() !== "" &&
        !parseKnowledgeType(rawKtUpload)
    ) {
        return res.status(400).json({
            code: 400,
            msg: "knowledgeType 须为 FAQ、制度、方案、文档 之一或留空",
            data: {}
        });
    }

    try {
        const batchId = crypto.randomUUID();
        const uploadsDir = getUploadsDir();
        fs.mkdirSync(uploadsDir, { recursive: true });

        const includeChildren = parseDeptScopeIncludeChildren(body);
        const { deptScopeJson, expandedVisibleDeptIds } = await resolveDeptScopeForUpload(
            body,
            companyWide ? [] : visibleDeptIds,
            includeChildren,
            companyWide
        );

        const knowledgeType = parseKnowledgeType(body.knowledgeType ?? body.knowledge_type);
        const author = parseOptionalString(body.author, 256);
        const docVersion = parseOptionalString(body.docVersion ?? body.version, 64);
        const sourceUri = parseOptionalString(body.sourceUri ?? body.source, 2048);
        const departmentCaption = parseOptionalString(
            body.departmentCaption ?? body.department,
            512
        );
        const ktSql = knowledgeType ? `N'${escapeSql(knowledgeType)}'` : "NULL";
        const authorSql = author ? `N'${escapeSql(author)}'` : "NULL";
        const verSql = docVersion ? `N'${escapeSql(docVersion)}'` : "NULL";
        const srcSql = sourceUri ? `N'${escapeSql(sourceUri)}'` : "NULL";
        const deptCapSql = departmentCaption ? `N'${escapeSql(departmentCaption)}'` : "NULL";

        const docIds = [];
        const enqueueErrors = [];

        // #region agent log
        fetch("http://127.0.0.1:7267/ingest/1ac3dd64-387b-48c9-973e-f2097f200d3a", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "001e91" },
            body: JSON.stringify({
                sessionId: "001e91",
                runId: "upload-debug",
                hypothesisId: "H0",
                location: "documents.js:/upload loop start",
                message: "multipart upload batch",
                data: {
                    filesCount: files.length,
                    bufferLens: files.map((x) => (Buffer.isBuffer(x.buffer) ? x.buffer.length : -1)),
                    companyWide,
                    hasVisibleDeptIds: Array.isArray(visibleDeptIds) && visibleDeptIds.length > 0
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion

        for (const f of files) {
            try {
                const docId = crypto.randomUUID();
                const jobId = crypto.randomUUID();
                const ownerUserId = crypto.randomUUID();

                const originalName = decodeMultipartFilename(
                    f.originalname && typeof f.originalname === "string" ? f.originalname : "upload"
                );

                const safeBase = sanitizeStorageBasename(originalName);
                const dateSeg = formatUploadsDateSegment();
                const docDir = path.join(uploadsDir, dateSeg, docId);
                fs.mkdirSync(docDir, { recursive: true });
                const storageKey = path.posix.join(
                    "storage",
                    "uploads",
                    dateSeg,
                    docId,
                    safeBase
                );
                const filePath = path.join(docDir, safeBase);

                const buf = f.buffer;
                const sizeBytes = buf?.length || 0;
                if (!Buffer.isBuffer(buf) || sizeBytes <= 0) throw new Error("空文件或文件缓冲缺失");

                const mimeType = f.mimetype && typeof f.mimetype === "string" ? f.mimetype : "text/plain";
                fs.writeFileSync(filePath, buf);

                const contentHash = sha256Hex(buf);
                const fileMd5 = md5Hex(buf);

                await runQuery(`
                    INSERT INTO dbo.documents (
                        id, title, storage_key, mime_type, size_bytes,
                        content_hash, indexed_content_hash, content_md5, indexed_content_md5,
                        source_type, mirror_rel_path, status,
                        owner_user_id, dept_scope_json, acl_json,
                        knowledge_type, author, doc_version, source_uri, department_caption
                    )
                    VALUES (
                        '${docId}',
                        '${escapeSql(originalName.slice(0, 255))}',
                        '${escapeSql(storageKey)}',
                        '${escapeSql(mimeType)}',
                        ${sizeBytes},
                        '${contentHash}',
                        NULL,
                        N'${fileMd5}',
                        NULL,
                        N'upload',
                        NULL,
                        N'pending_index',
                        '${ownerUserId}',
                        N'${escapeSql(deptScopeJson)}',
                        NULL,
                        ${ktSql},
                        ${authorSql},
                        ${verSql},
                        ${srcSql},
                        ${deptCapSql}
                    );
                `);

                const payloadObj = {
                    batchId,
                    filePath,
                    filePathInPayload: storageKey,
                    mimeType,
                    visibleDeptIds: expandedVisibleDeptIds,
                    docTitle: originalName.slice(0, 512),
                    embedding_model_version: getEmbeddingModelVersion()
                };
                const payloadJson = JSON.stringify(payloadObj);

                await runQuery(`
                    INSERT INTO dbo.index_jobs (
                        id, document_id, job_type, priority, status,
                        attempt_count, max_attempts, error_code, error_message,
                        payload_json, created_by, worker_id, batch_id
                    )
                    VALUES (
                        '${jobId}',
                        '${docId}',
                        N'immediate_upload',
                        0,
                        N'queued',
                        0,
                        3,
                        NULL,
                        NULL,
                        N'${escapeSql(payloadJson)}',
                        NULL,
                        NULL,
                        '${batchId}'
                    );
                `);

                docIds.push(docId);
            } catch (e) {
                const errMsg = e?.message || String(e);
                enqueueErrors.push({
                    fileName: f.originalname || "",
                    msg: errMsg
                });
                // #region agent log
                const _em = String(errMsg);
                fetch("http://127.0.0.1:7267/ingest/1ac3dd64-387b-48c9-973e-f2097f200d3a", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "001e91" },
                    body: JSON.stringify({
                        sessionId: "001e91",
                        runId: "upload-debug",
                        hypothesisId: "H_enqueue",
                        location: "documents.js:/upload per-file catch",
                        message: "single file enqueue failed",
                        data: {
                            fileName: String(f.originalname || ""),
                            errSlice: _em.slice(0, 900),
                            H1_schema: /Invalid column name|Invalid object name|does not exist|547|foreign key/i.test(
                                _em
                            ),
                            H2_emptyBuffer: /空文件|缓冲缺失|buffer/i.test(_em),
                            H3_indexJobs: /index_jobs|payload_json|batch_id|UQ_|duplicate/i.test(_em),
                            H4_sqlcmd: /sqlcmd|Sqlcmd|Missing env: MSSQL|ECONNREFUSED|ETIMEDOUT/i.test(_em),
                            H5_fs: /ENOENT|EACCES|EPERM|ENOSPC/i.test(_em)
                        },
                        timestamp: Date.now()
                    })
                }).catch(() => {});
                // #endregion
            }
        }

        if (docIds.length === 0) {
            // #region agent log
            fetch("http://127.0.0.1:7267/ingest/1ac3dd64-387b-48c9-973e-f2097f200d3a", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "001e91" },
                body: JSON.stringify({
                    sessionId: "001e91",
                    runId: "upload-debug",
                    hypothesisId: "H_summary",
                    location: "documents.js:/upload all failed",
                    message: "docIds empty",
                    data: {
                        enqueueErrorsCount: enqueueErrors.length,
                        firstMsgs: enqueueErrors.slice(0, 3).map((x) => ({
                            f: String(x.fileName || "").slice(0, 120),
                            m: String(x.msg || "").slice(0, 400)
                        }))
                    },
                    timestamp: Date.now()
                })
            }).catch(() => {});
            // #endregion
            const first = enqueueErrors[0];
            const detail = first ? `${first.fileName || "文件"}: ${first.msg || ""}` : "";
            const looksLike005 =
                enqueueErrors.some((e) =>
                    /Invalid column name|content_md5|indexed_content_md5|source_type|mirror_rel_path/i.test(
                        String(e?.msg || "")
                    )
                );
            const looksLike010 = enqueueErrors.some((e) =>
                /knowledge_type|doc_version|source_uri|department_caption|CK_documents_knowledge_type/i.test(
                    String(e?.msg || "")
                )
            );
            let msg = "全部文件入队失败";
            if (looksLike010) {
                msg += "：请执行 backend/sql/010_kg_schema.sql（知识图谱元数据列）后重试";
            } else if (looksLike005) {
                msg +=
                    "：数据库缺少列，请在 SQL Server 执行 backend/sql/005_documents_md5_and_sources.sql 后重试";
            }
            if (detail) {
                msg += looksLike005 ? `（详情：${detail.slice(0, 400)}）` : `：${detail.slice(0, 500)}`;
            }
            return res.status(400).json({
                code: 400,
                msg,
                data: { batchId, totalJobs: 0, docIds: [], enqueueErrors }
            });
        }

        try {
            await writeAuditLog({
                actorLoginId: req.user?.loginId || null,
                action: "doc.upload.batch",
                targetType: "document",
                targetId: null,
                summary: `批量上传入队：${docIds.length} 个文件`,
                metadata: { batchId, count: docIds.length }
            });
        } catch (_) {
            /* ignore */
        }

        return res.status(200).json({
            code: 200,
            msg: "已接收文件并入队处理",
            data: {
                batchId,
                totalJobs: docIds.length,
                docIds,
                enqueueErrors
            }
        });
    } catch (e) {
        const msg = (e && e.message) || String(e);
        if (msg.includes("batch_id") || msg.includes("Invalid column name")) {
            const hint =
                msg.includes("content_md5") || msg.includes("source_type")
                    ? "backend/sql/005_documents_md5_and_sources.sql"
                    : "backend/sql/004_index_jobs_batch_id.sql";
            return res.status(503).json({
                code: 503,
                msg: `数据库未执行迁移：请运行 ${hint}`,
                data: {}
            });
        }
        // eslint-disable-next-line no-console
        console.error("upload multipart error:", e);
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

// M2：Mock 上传（txt）：让“可检索部门范围”能写入 Qdrant payload，从而让部门过滤端到端可验证。
documentsRouter.post("/", async (req, res) => {
    const body = req.body || {};
    const title = body.title;
    const content = body.content;
    const visibleDeptIds = body.visibleDeptIds;

    if (!title || typeof title !== "string") {
        return res.status(400).json({ code: 400, msg: "title 必填（string）", data: {} });
    }
    if (!content || typeof content !== "string") {
        return res.status(400).json({ code: 400, msg: "content 必填（string）", data: {} });
    }
    const companyWideJson =
        String(req.user?.role || "").toLowerCase() === "admin" &&
        (body.deptScopeCompanyWide === true ||
            body.deptScopeCompanyWide === "1" ||
            body.deptScopeCompanyWide === "true");

    if (
        !companyWideJson &&
        (!Array.isArray(visibleDeptIds) || visibleDeptIds.length === 0)
    ) {
        return res.status(400).json({
            code: 400,
            msg: "visibleDeptIds 必填（非空数组）",
            data: {}
        });
    }

    const rawKtJson = body.knowledgeType ?? body.knowledge_type;
    if (
        rawKtJson != null &&
        String(rawKtJson).trim() !== "" &&
        !parseKnowledgeType(rawKtJson)
    ) {
        return res.status(400).json({
            code: 400,
            msg: "knowledgeType 须为 FAQ、制度、方案、文档 之一或留空",
            data: {}
        });
    }

    try {
        if (!tryBeginIngestSection()) {
            return res.status(503).json({
                code: 503,
                msg: "已有文档正在入库（poller 或其它请求占用），请数秒后重试",
                data: {}
            });
        }
        try {
        const { ingestSingleTextFile } = require("../worker/ingestWorker");

        const docId = crypto.randomUUID();
        const ownerUserId = crypto.randomUUID();

        const fileName = body.fileName && typeof body.fileName === "string"
            ? body.fileName
            : `${title}.txt`;
        const mimeType = body.mimeType && typeof body.mimeType === "string"
            ? body.mimeType
            : "text/plain";

        const uploadsDir = getUploadsDir();
        fs.mkdirSync(uploadsDir, { recursive: true });

        const safeTxtName = sanitizeStorageBasename(fileName.endsWith(".txt") ? fileName : `${title}.txt`);
        const dateSeg = formatUploadsDateSegment();
        const docDir = path.join(uploadsDir, dateSeg, docId);
        fs.mkdirSync(docDir, { recursive: true });
        const storageKey = path.posix.join(
            "storage",
            "uploads",
            dateSeg,
            docId,
            safeTxtName
        );
        const filePath = path.join(docDir, safeTxtName);
        const buf = Buffer.from(content, "utf8");
        fs.writeFileSync(filePath, buf);

        const contentHash = sha256Hex(buf);
        const fileMd5 = md5Hex(buf);

        const includeChildren = parseDeptScopeIncludeChildren(body);
        const { deptScopeJson, expandedVisibleDeptIds } = await resolveDeptScopeForUpload(
            body,
            companyWideJson ? [] : visibleDeptIds,
            includeChildren,
            companyWideJson
        );

        const knowledgeTypeJ = parseKnowledgeType(body.knowledgeType ?? body.knowledge_type);
        const authorJ = parseOptionalString(body.author, 256);
        const docVersionJ = parseOptionalString(body.docVersion ?? body.version, 64);
        const sourceUriJ = parseOptionalString(body.sourceUri ?? body.source, 2048);
        const departmentCaptionJ = parseOptionalString(
            body.departmentCaption ?? body.department,
            512
        );
        const ktJSql = knowledgeTypeJ ? `N'${escapeSql(knowledgeTypeJ)}'` : "NULL";
        const authorJSql = authorJ ? `N'${escapeSql(authorJ)}'` : "NULL";
        const verJSql = docVersionJ ? `N'${escapeSql(docVersionJ)}'` : "NULL";
        const srcJSql = sourceUriJ ? `N'${escapeSql(sourceUriJ)}'` : "NULL";
        const deptCapJSql = departmentCaptionJ ? `N'${escapeSql(departmentCaptionJ)}'` : "NULL";

        await runQuery(`
            INSERT INTO dbo.documents (
                id, title, storage_key, mime_type, size_bytes,
                content_hash, indexed_content_hash, content_md5, indexed_content_md5,
                source_type, mirror_rel_path, status,
                owner_user_id, dept_scope_json, acl_json,
                knowledge_type, author, doc_version, source_uri, department_caption
            )
            VALUES (
                '${docId}',
                '${escapeSql(title)}',
                '${escapeSql(storageKey)}',
                '${escapeSql(mimeType)}',
                ${buf.length},
                '${contentHash}',
                NULL,
                N'${fileMd5}',
                NULL,
                N'upload',
                NULL,
                N'pending_index',
                '${ownerUserId}',
                N'${escapeSql(deptScopeJson)}',
                NULL,
                ${ktJSql},
                ${authorJSql},
                ${verJSql},
                ${srcJSql},
                ${deptCapJSql}
            );
        `);

        const createdIso = new Date().toISOString();
        const graphDocMeta = {
            title: title.slice(0, 255),
            knowledgeType: knowledgeTypeJ,
            author: authorJ,
            docVersion: docVersionJ,
            sourceUri: sourceUriJ,
            departmentCaption: departmentCaptionJ,
            docCreatedAt: createdIso
        };

        const ingestResult = await ingestSingleTextFile({
            filePath,
            docId,
            filePathInPayload: storageKey,
            visibleDeptIds: expandedVisibleDeptIds,
            mimeType,
            docTitle: title.slice(0, 512),
            graphDocMeta
        });
        const md5Out = ingestResult?.contentMd5 || fileMd5;
        const hashOut = ingestResult?.contentHash || contentHash;
        const skipped = ingestResult?.skipped === true;
        const im = ingestResult?.indexMeta;
        const indexCols =
            !skipped && im
                ? `,
                vector_dim = ${sqlIntOrNull(im.vectorDim)},
                chunk_count = ${sqlIntOrNull(im.chunkCount)},
                embedding_batch_size = ${sqlIntOrNull(im.embeddingBatchSize)},
                chunk_size = ${sqlIntOrNull(im.chunkSize)},
                chunk_overlap = ${sqlIntOrNull(im.chunkOverlap)},
                embedding_model = ${sqlNVarCharOrNull(im.embeddingModel)}`
                : "";
        await runQuery(`
            UPDATE dbo.documents
            SET status = N'indexed',
                content_md5 = N'${md5Out.replace(/'/g, "''")}',
                indexed_content_md5 = N'${md5Out.replace(/'/g, "''")}',
                indexed_content_hash = N'${hashOut.replace(/'/g, "''")}',
                updated_at = SYSDATETIMEOFFSET()${indexCols}
            WHERE id = CAST('${docId}' AS UNIQUEIDENTIFIER);
        `);

        try {
            await writeAuditLog({
                actorLoginId: req.user?.loginId || null,
                action: "doc.upload",
                targetType: "document",
                targetId: docId,
                summary: `上传：${title.slice(0, 120)}`,
                metadata: { fileName }
            });
        } catch (_) {
            /* ignore */
        }

        return res.status(200).json({
            code: 200,
            msg: "上传并完成入库（M2 Mock）",
            data: { docId }
        });
        } finally {
            endIngestSection();
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("upload error:", e);
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

/** 手动重新入库：按当前 storage_key 与 dept_scope_json 排队 immediate_upload（与上传同源 worker） */
documentsRouter.post(
    "/:docId/reindex",
    (req, res, next) => void documentWriteRateLimit(req, res, next).catch(next),
    async (req, res) => {
    const { docId } = req.params || {};
    if (!docId) {
        return res.status(400).json({ code: 400, msg: "docId 必填", data: {} });
    }
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(String(docId))) {
        return res.status(400).json({ code: 400, msg: "docId 必须是 UUID 格式", data: {} });
    }

    const actorLoginId = req.user?.loginId || null;
    const safeId = String(docId).replace(/'/g, "''");

    try {
        const rows = await runQueryTsv(
            `
            SELECT
                REPLACE(REPLACE(REPLACE(ISNULL(storage_key, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(mime_type, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(CAST(dept_scope_json AS NVARCHAR(MAX)), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                ISNULL(status, N''),
                REPLACE(REPLACE(REPLACE(ISNULL(title, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
            FROM dbo.documents
            WHERE id = CAST('${safeId}' AS UNIQUEIDENTIFIER);
        `,
            { variableLengthY: 8000 }
        );
        const row = rows && rows[0];
        if (!row || row.length < 5) {
            return res.status(404).json({ code: 404, msg: "文档不存在", data: {} });
        }

        const storageKey = String(row[0] || "").trim();
        const mimeType = String(row[1] || "").trim() || "application/octet-stream";
        const deptJsonRaw = row[2] || "";
        const status = String(row[3] || "").trim();
        const docTitleForPayload = String(row[4] || "").trim().slice(0, 512);

        if (status === "deleted") {
            return res.status(400).json({ code: 400, msg: "已删除的文档无法重新入库", data: {} });
        }
        if (!storageKey) {
            return res.status(400).json({ code: 400, msg: "文档缺少存储路径 storage_key", data: {} });
        }

        const filePath = resolveStorageKeyToAbsolute(storageKey);
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(400).json({ code: 400, msg: "本地文件不存在，无法重新入库", data: {} });
        }

        let visibleDeptIds = [];
        try {
            const parsed = deptJsonRaw ? JSON.parse(deptJsonRaw) : {};
            if (parsed && parsed.is_company_wide === true) {
                visibleDeptIds = ["*"];
            } else {
                const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
                visibleDeptIds = await expandVisibleDeptIdsForIngest(nodes);
                /* 镜像同步等路径把 KB_SYNC_DEFAULT_DEPT_IDS（如 101）写入 nodes，非 departments.id UUID；
                   expand 会得到 []，与 ingestWorker 使用的数字/字符串部门 ID 不一致，需回退为同上传逻辑。 */
                if (!visibleDeptIds.length && nodes.length) {
                    const rawIds = nodes
                        .map((n) => n && n.dept_id)
                        .filter((x) => x != null && String(x).trim() !== "");
                    visibleDeptIds = normalizeVisibleDeptIdsForPayload(rawIds);
                }
            }
        } catch (_) {
            return res.status(400).json({ code: 400, msg: "dept_scope_json 格式无效", data: {} });
        }

        if (!Array.isArray(visibleDeptIds) || visibleDeptIds.length === 0) {
            return res.status(400).json({
                code: 400,
                msg: "文档未配置有效可见部门范围，无法重新入库",
                data: {}
            });
        }

        const batchId = crypto.randomUUID();
        const jobId = crypto.randomUUID();
        const payloadObj = {
            batchId,
            filePath,
            filePathInPayload: storageKey,
            mimeType,
            visibleDeptIds,
            ...(docTitleForPayload ? { docTitle: docTitleForPayload } : {}),
            embedding_model_version: getEmbeddingModelVersion()
        };
        const payloadJson = JSON.stringify(payloadObj);

        await runQuery(`
            UPDATE dbo.documents
            SET status = N'pending_index',
                indexed_content_md5 = NULL,
                indexed_content_hash = NULL,
                updated_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${safeId}' AS UNIQUEIDENTIFIER);
        `);

        const safeJob = jobId.replace(/'/g, "''");
        const safeBatch = batchId.replace(/'/g, "''");

        await cancelQueuedImmediateUploadForDocument(docId);

        await runQuery(`
            INSERT INTO dbo.index_jobs (
                id, document_id, job_type, priority, status,
                attempt_count, max_attempts, error_code, error_message,
                payload_json, created_by, worker_id, batch_id
            )
            VALUES (
                '${safeJob}',
                '${safeId}',
                N'immediate_upload',
                1,
                N'queued',
                0,
                3,
                NULL,
                NULL,
                N'${escapeSql(payloadJson)}',
                NULL,
                NULL,
                '${safeBatch}'
            );
        `);

        try {
            await writeAuditLog({
                actorLoginId,
                action: "doc.reindex",
                targetType: "document",
                targetId: docId,
                summary: "手动触发重新入库",
                metadata: { batchId, jobId }
            });
        } catch (_) {
            /* ignore */
        }

        return res.status(200).json({
            code: 200,
            msg: "已排队重新入库",
            data: { docId, batchId, jobId }
        });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("reindex:", e);
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

documentsRouter.delete("/:docId", async (req, res) => {
    const { docId } = req.params || {};
    if (!docId) {
        return res.status(400).json({ code: 400, msg: "docId 必填", data: {} });
    }

    // M1：先做 Web->Qdrant 清理闭环（SQL status/join 为最小实现）
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(String(docId))) {
        return res.status(400).json({ code: 400, msg: "docId 必须是 UUID 格式", data: {} });
    }

    try {
        const { deleteVectorsByDocId } = require("../worker/deleteWorker");
        const actorLoginId = req.user?.loginId || null;
        const actorUserId = null;
               const jobId = crypto.randomUUID();
        const safeJob = jobId.replace(/'/g, "''");

        await cancelQueuedImmediateUploadForDocument(docId);

        // 1) 标记 documents.deleted（等待/对账清理向量仍由 Qdrant deleteWorker 完成）
        await runQuery(`
            UPDATE dbo.documents
            SET status = N'deleted',
                deleted_at = SYSDATETIMEOFFSET(),
                updated_at = SYSDATETIMEOFFSET()
            WHERE id = '${docId}';
        `);

        // 2) 入队删除任务（与即时清理同一 jobId，便于对账 success/failed）
        await runQuery(`
            INSERT INTO dbo.index_jobs (id, document_id, job_type, priority, status, attempt_count, max_attempts, error_code, error_message, payload_json, created_by, worker_id)
            VALUES ('${safeJob}', '${docId}', N'delete_vectors', 10, N'queued', 0, 3, NULL, NULL, NULL, ${actorUserId ? `CAST('${actorUserId}' AS UNIQUEIDENTIFIER)` : 'NULL'}, NULL);
        `);

        // 3) 即时清理 Qdrant；失败则任务保持 queued 由 deleteJobPoller / 夜间对账重试
        let vectorCleanupOk = true;
        try {
            await deleteVectorsByDocId({ docId });
            await runQuery(`
                UPDATE dbo.index_jobs
                SET status = N'success',
                    finished_at = SYSDATETIMEOFFSET(),
                    error_message = NULL
                WHERE id = CAST('${safeJob}' AS UNIQUEIDENTIFIER);
            `);
        } catch (delErr) {
            vectorCleanupOk = false;
            const em = String((delErr && delErr.message) || delErr).replace(/'/g, "''").slice(0, 1900);
            await runQuery(`
                UPDATE dbo.index_jobs
                SET status = N'queued',
                    error_message = N'${em}',
                    started_at = NULL,
                    finished_at = NULL
                WHERE id = CAST('${safeJob}' AS UNIQUEIDENTIFIER);
            `);
        }

        try {
            await writeAuditLog({
                actorUserId: actorUserId || undefined,
                actorLoginId,
                action: "doc.delete",
                targetType: "document",
                targetId: docId,
                summary: vectorCleanupOk
                    ? "删除文档并完成向量清理"
                    : "删除文档；向量清理待重试（已入队）"
            });
        } catch (_) {
            /* ignore */
        }

        return res.status(200).json({
            code: 200,
            msg: vectorCleanupOk
                ? "删除已完成"
                : "文档已标记删除；向量清理将自动重试（请稍后核对检索结果）",
            data: { docId, vectorCleanupPending: !vectorCleanupOk }
        });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("delete error:", e);
        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
});

module.exports = { documentsRouter };

