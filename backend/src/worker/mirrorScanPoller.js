const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { runQuery, runQueryTsv } = require("../lib/sqlcmd");
const { escapeSql } = require("../lib/auditLog");
const { getMirrorDir } = require("../lib/storagePaths");
const { md5Hex, sha256Hex } = require("../lib/contentFingerprints");
const { deleteVectorsByDocId } = require("./deleteWorker");
const { debugNdjson } = require("../lib/debugSessionNdjson");
const { cancelQueuedImmediateUploadForDocument } = require("../lib/cancelQueuedIngestJobs");
const { loadKbSyncSettings } = require("../lib/kbSyncSettings");
const { deleteKgDataForDocId } = require("../lib/kgExtractPersist");

/** 与 parser/loadChunks 支持范围对齐 */
const ALLOWED_EXT = new Set([
    ".md",
    ".txt",
    ".doc",
    ".docx",
    ".ppt",
    ".pptx",
    ".xls",
    ".xlsx",
    ".xlsm",
    ".pdf",
    ".png"
]);

const isSqlcmdRowCountLine = (t) =>
    /^\(\d+/.test(t) &&
    (/(rows?\s+affected|row\s+affected)/i.test(t) || t.includes("\u884c\u53d7\u5f71\u54cd"));

/** 解析 mirror 行：id|content_md5|status|indexed_content_md5 */
const parseExistingMirrorRow = (stdout) => {
    for (const raw of String(stdout || "").split(/\r?\n/)) {
        const t = raw.trim();
        if (!t || isSqlcmdRowCountLine(t)) continue;
        const parts = t.split("|");
        if (parts.length < 4) continue;
        const id = parts[0].trim();
        if (!/^[0-9a-fA-F-]{36}$/.test(id)) continue;
        return {
            id,
            contentMd5: parts[1].trim() || null,
            status: parts[2].trim() || "",
            indexedContentMd5: parts[3].trim() || null
        };
    }
    return null;
};

/** 当前镜像根下「仍存在」的相对路径集合（与 mirror_rel_path 一致，正斜杠） */
const presentRelPathSetFromAbsList = (rootResolved, absPaths) => {
    const s = new Set();
    const root = path.resolve(rootResolved);
    for (const absPath of absPaths) {
        const rel = path.relative(root, absPath).split(path.sep).join("/");
        if (rel && !rel.startsWith("..")) s.add(rel);
    }
    return s;
};

/**
 * 云端/本地镜像删除文件后，库中 source_type=mirror 仍保留的行 → 软删并清向量（与手动删文档语义接近）。
 */
const purgeMirrorOrphansNotInSet = async (presentRelPaths) => {
    let rows;
    try {
        rows = await runQueryTsv(
            `
            SELECT
                CONVERT(VARCHAR(36), id),
                REPLACE(REPLACE(REPLACE(ISNULL(mirror_rel_path, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
            FROM dbo.documents
            WHERE deleted_at IS NULL
              AND status <> N'deleted'
              AND source_type = N'mirror'
              AND mirror_rel_path IS NOT NULL
              AND LTRIM(RTRIM(mirror_rel_path)) <> N'';
            `,
            { variableLengthY: 4000 }
        );
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (/source_type|mirror_rel_path|Invalid column name|列名.*无效/i.test(msg)) {
            return 0;
        }
        throw e;
    }

    let purged = 0;
    for (const c of rows) {
        const id = (c[0] || "").trim();
        const rel = String(c[1] || "")
            .trim()
            .replace(/\\/g, "/");
        if (!id || !rel) continue;
        if (presentRelPaths.has(rel)) continue;

        try {
            await cancelQueuedImmediateUploadForDocument(id);
        } catch (_) {
            /* ignore */
        }
        try {
            await deleteVectorsByDocId({ docId: id });
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[mirror-scan] purge orphan qdrant", id, (e && e.message) || e);
        }
        try {
            await deleteKgDataForDocId(id);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[mirror-scan] purge orphan kg", id, (e && e.message) || e);
        }
        try {
            await runQuery(`
                UPDATE dbo.documents
                SET status = N'deleted',
                    deleted_at = SYSDATETIMEOFFSET(),
                    updated_at = SYSDATETIMEOFFSET()
                WHERE id = CAST('${id.replace(/'/g, "''")}' AS UNIQUEIDENTIFIER)
                  AND deleted_at IS NULL;
            `);
            purged += 1;
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[mirror-scan] purge orphan sql", id, (e && e.message) || e);
        }
    }
    if (purged > 0) {
        // eslint-disable-next-line no-console
        console.log("[mirror-scan] 已清理镜像孤儿文档", purged, "条（源文件已从同步目录消失）");
    }
    return purged;
};

const walkFiles = (dir, acc) => {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        return;
    }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walkFiles(p, acc);
        else if (ALLOWED_EXT.has(path.extname(ent.name).toLowerCase())) acc.push(p);
    }
};

/**
 * 镜像入库写入 dept_scope / 索引任务的 visibleDeptIds。
 * 支持：逗号分隔的部门 id（UUID 字符串或纯数字 legacy）、或 JSON 数组。
 * 未配置时默认 [101] 仅为历史占位；真实环境请改为 departments 表中的 id（与文档库上传一致）。
 */
const parseDefaultDeptIds = () => {
    const raw = process.env.KB_SYNC_DEFAULT_DEPT_IDS;
    if (raw == null || String(raw).trim() === "") return [101];
    const s = String(raw).trim();
    try {
        const j = JSON.parse(s);
        if (Array.isArray(j)) {
            const out = [];
            for (const x of j) {
                if (x == null) continue;
                if (typeof x === "number" && Number.isFinite(x)) {
                    out.push(x);
                    continue;
                }
                const t = String(x).trim();
                if (t) out.push(t);
            }
            return out;
        }
    } catch (_) {
        /* 非 JSON，按逗号分隔解析 */
    }
    return s
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
};

const mirrorRootNorm = (mirrorRoot) => path.resolve(mirrorRoot) + path.sep;

const isUnderMirror = (mirrorRoot, filePath) => {
    const root = mirrorRootNorm(mirrorRoot);
    const fp = path.resolve(filePath);
    return fp === path.resolve(mirrorRoot) || fp.startsWith(root);
};

const processOneFile = async (mirrorRoot, absPath, visibleDeptIds) => {
    const rootResolved = path.resolve(mirrorRoot);
    if (!isUnderMirror(rootResolved, absPath)) return;

    const rel = path.relative(rootResolved, absPath).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) return;

    const raw = fs.readFileSync(absPath);
    const fileMd5 = md5Hex(raw);
    const contentHash = sha256Hex(raw);
    const sizeBytes = raw.length;
    const relEsc = escapeSql(rel);

    let stdout;
    try {
        stdout = await runQuery(`
            SELECT TOP (1)
                CONVERT(VARCHAR(36), id) + N'|' + ISNULL(content_md5, N'') + N'|' + ISNULL(status, N'') + N'|' + ISNULL(indexed_content_md5, N'')
            FROM dbo.documents
            WHERE deleted_at IS NULL
              AND source_type = N'mirror'
              AND mirror_rel_path = N'${relEsc}';
        `);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[mirror-scan] lookup failed", rel, (e && e.message) || e);
        return;
    }

    const existing = parseExistingMirrorRow(stdout);
    const storageKey = path.posix.join("storage", "mirror", rel.split(path.sep).join("/"));
    const scopeNodes = visibleDeptIds.map((id) => ({
        dept_id: String(id),
        include_children: false
    }));
    const deptScopeJson = JSON.stringify({
        nodes: scopeNodes,
        is_company_wide: false,
        category_nodes: scopeNodes,
        category_is_company_wide: false
    });
    const mimeByExt = {
        ".md": "text/markdown",
        ".txt": "text/plain",
        ".doc": "application/msword",
        ".docx":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".ppt": "application/vnd.ms-powerpoint",
        ".pptx":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".xls": "application/vnd.ms-excel",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
        ".pdf": "application/pdf",
        ".png": "image/png"
    };
    const ext = path.extname(absPath).toLowerCase();
    const mimeType = mimeByExt[ext] || "text/plain";
    const title = path.basename(absPath);
    const payloadBase = {
        filePath: absPath,
        filePathInPayload: storageKey,
        mimeType,
        visibleDeptIds,
        docTitle: title.slice(0, 512)
    };

    if (!existing) {
        const docId = crypto.randomUUID();
        const jobId = crypto.randomUUID();
        const ownerUserId = crypto.randomUUID();

        await runQuery(`
            INSERT INTO dbo.documents (
                id, title, storage_key, mime_type, size_bytes,
                content_hash, indexed_content_hash, content_md5, indexed_content_md5,
                source_type, mirror_rel_path, status,
                owner_user_id, dept_scope_json, acl_json
            )
            VALUES (
                '${docId}',
                N'${escapeSql(title.slice(0, 255))}',
                N'${escapeSql(storageKey)}',
                N'${escapeSql(mimeType)}',
                ${sizeBytes},
                N'${contentHash}',
                NULL,
                N'${fileMd5}',
                NULL,
                N'mirror',
                N'${relEsc}',
                N'pending_index',
                '${ownerUserId}',
                N'${escapeSql(deptScopeJson)}',
                NULL
            );
        `);

        const payloadJson = JSON.stringify({ ...payloadBase, batchId: null });
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
                NULL
            );
        `);
        return "new";
    }

    const diskMatchesStoredMd5 = existing.contentMd5 && existing.contentMd5 === fileMd5;
    const fullyIndexed =
        String(existing.status || "").toLowerCase() === "indexed" &&
        existing.indexedContentMd5 &&
        existing.indexedContentMd5 === fileMd5;

    if (diskMatchesStoredMd5 && fullyIndexed) {
        /* 列表「大小」来自 size_bytes；占位0 字节入库后再落地时 MD5 未变，需用当前文件长度刷新 */
        await runQuery(`
            UPDATE dbo.documents
            SET size_bytes = ${sizeBytes},
                updated_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${existing.id}' AS UNIQUEIDENTIFIER)
              AND ISNULL(size_bytes, -1) <> ${sizeBytes};
        `);
        return "unchanged";
    }

    await deleteVectorsByDocId({ docId: existing.id });

    if (diskMatchesStoredMd5) {
        /* 文件未改，但尚未成功索引（pending / 失败 / 缺 indexed_content_md5）：只清索引态并入队 */
        await runQuery(`
            UPDATE dbo.documents
            SET size_bytes = ${sizeBytes},
                indexed_content_md5 = NULL,
                indexed_content_hash = NULL,
                status = N'pending_index',
                updated_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${existing.id}' AS UNIQUEIDENTIFIER);
        `);
    } else {
        await runQuery(`
            UPDATE dbo.documents
            SET size_bytes = ${sizeBytes},
                content_hash = N'${contentHash}',
                content_md5 = N'${fileMd5.replace(/'/g, "''")}',
                indexed_content_md5 = NULL,
                indexed_content_hash = NULL,
                status = N'pending_index',
                updated_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${existing.id}' AS UNIQUEIDENTIFIER);
        `);
    }

    await cancelQueuedImmediateUploadForDocument(existing.id);

    const jobId = crypto.randomUUID();
    const payloadJson = JSON.stringify({ ...payloadBase, batchId: null });
    await runQuery(`
        INSERT INTO dbo.index_jobs (
            id, document_id, job_type, priority, status,
            attempt_count, max_attempts, error_code, error_message,
            payload_json, created_by, worker_id, batch_id
        )
        VALUES (
            '${jobId}',
            '${existing.id}',
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
            NULL
        );
    `);
    return "updated";
};

/**
 * 整目录扫描一轮（用于「立即同步」）；后台轮询仍用 mirrorScanTick 限量切片。
 * @returns {Promise<{ filesTotal: number, newDocs: number, updatedDocs: number, unchanged: number, fileErrors: number, docsPurged: number }>}
 */
const mirrorScanFullPass = async (mirrorRoot) => {
    const rootResolved = path.resolve(mirrorRoot);
    if (!fs.existsSync(rootResolved)) {
        throw new Error(`镜像目录不存在: ${rootResolved}`);
    }
    const visibleDeptIds = parseDefaultDeptIds();
    if (visibleDeptIds.length === 0) {
        throw new Error("KB_SYNC_DEFAULT_DEPT_IDS 未配置有效部门");
    }
    const all = [];
    walkFiles(rootResolved, all);
    // #region agent log
    {
        const sample = all.slice(0, 5).map((p) => {
            try {
                const st = fs.statSync(p);
                const buf = fs.readFileSync(p);
                return {
                    base: path.basename(p),
                    statSize: st.size,
                    readLen: buf.length
                };
            } catch (err) {
                return { base: path.basename(p), err: (err && err.message) || String(err) };
            }
        });
        debugNdjson({
            hypothesisId: "H1",
            location: "mirrorScanPoller.js:mirrorScanFullPass",
            message: "mirror fullpass file sample stat vs readFile length",
            data: { root: rootResolved, filesTotal: all.length, sample }
        });
    }
    // #endregion
    let newDocs = 0;
    let updatedDocs = 0;
    let unchanged = 0;
    let fileErrors = 0;
    let skippedNoResult = 0;
    for (const absPath of all) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const r = await processOneFile(rootResolved, absPath, visibleDeptIds);
            if (r === "new") newDocs += 1;
            else if (r === "updated") updatedDocs += 1;
            else if (r === "unchanged") unchanged += 1;
            else if (r == null) {
                skippedNoResult += 1;
                // eslint-disable-next-line no-console
                console.warn(
                    "[mirror-scan] 未入库（无结果，多为库查询失败或路径异常）:",
                    absPath
                );
            }
        } catch (e) {
            fileErrors += 1;
            // eslint-disable-next-line no-console
            console.warn("[mirror-scan] file error", absPath, (e && e.message) || e);
        }
    }

    const presentRelPaths = presentRelPathSetFromAbsList(rootResolved, all);
    let docsPurged = 0;
    try {
        docsPurged = await purgeMirrorOrphansNotInSet(presentRelPaths);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[mirror-scan] purge orphans failed:", (e && e.message) || e);
    }

    const out = {
        filesTotal: all.length,
        newDocs,
        updatedDocs,
        unchanged,
        fileErrors,
        skippedNoResult,
        docsPurged
    };
    // #region agent log
    debugNdjson({
        hypothesisId: "H5",
        location: "mirrorScanPoller.js:mirrorScanFullPass:end",
        message: "mirror fullpass counts",
        data: out
    });
    // #endregion
    return out;
};

const tick = async (opts = {}) => {
    const mirrorRoot =
        opts.mirrorRoot != null && String(opts.mirrorRoot).trim() !== ""
            ? path.resolve(String(opts.mirrorRoot).trim())
            : getMirrorDir();
    if (!mirrorRoot || !fs.existsSync(mirrorRoot)) return;

    const visibleDeptIds = parseDefaultDeptIds();
    if (visibleDeptIds.length === 0) return;

    let maxFiles = Number(opts.maxFilesPerTick);
    if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
        const cap = process.env.MIRROR_SCAN_MAX_FILES_PER_TICK
            ? Number(process.env.MIRROR_SCAN_MAX_FILES_PER_TICK)
            : 80;
        maxFiles = Number.isFinite(cap) && cap > 0 ? Math.min(cap, 500) : 80;
    }
    maxFiles = Math.max(1, Math.min(500, Math.floor(maxFiles)));

    const rootResolved = path.resolve(mirrorRoot);
    const all = [];
    walkFiles(mirrorRoot, all);
    const slice = all.slice(0, maxFiles);

    for (const absPath of slice) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await processOneFile(rootResolved, absPath, visibleDeptIds);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[mirror-scan] file error", absPath, (e && e.message) || e);
        }
    }

    const presentRelPaths = presentRelPathSetFromAbsList(rootResolved, all);
    try {
        await purgeMirrorOrphansNotInSet(presentRelPaths);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[mirror-scan] tick purge orphans failed:", (e && e.message) || e);
    }
};

let intervalId = null;
/** @type {{ intervalMs: number, maxFilesPerTick: number } | null} */
let pollOpts = null;

const stopMirrorScanPoller = () => {
    if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
    }
    pollOpts = null;
};

/**
 * 按同步配置启动/停止镜像目录轮询（保存配置或启动时调用）。
 * 环境变量 DISABLE_MIRROR_SCAN=1 时始终不启动。
 */
const reloadMirrorScanPollerFromSettings = async () => {
    stopMirrorScanPoller();
    if (String(process.env.DISABLE_MIRROR_SCAN || "") === "1") {
        // eslint-disable-next-line no-console
        console.log("[mirror-scan] 已禁用（DISABLE_MIRROR_SCAN=1）");
        return;
    }
    let s;
    try {
        s = await loadKbSyncSettings();
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[mirror-scan] 读取同步配置失败，跳过轮询:", (e && e.message) || e);
        return;
    }
    if (!s.mirrorPollEnabled) {
        // eslint-disable-next-line no-console
        console.log("[mirror-scan] 后台轮询已关闭（同步配置）");
        return;
    }
    const mirrorRoot = getMirrorDir();
    if (!mirrorRoot || !fs.existsSync(mirrorRoot)) {
        // eslint-disable-next-line no-console
        console.log("[mirror-scan] 未配置有效镜像目录，跳过轮询");
        return;
    }
    const intervalMs = Math.max(
        10_000,
        Math.min(3_600_000, Math.floor(Number(s.mirrorPollIntervalMs) || 60_000))
    );
    const maxFilesPerTick = Math.max(
        1,
        Math.min(500, Math.floor(Number(s.mirrorPollMaxFiles) || 80))
    );
    pollOpts = { intervalMs, maxFilesPerTick };
    intervalId = setInterval(() => {
        void tick({ maxFilesPerTick: pollOpts?.maxFilesPerTick ?? 80 }).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[mirror-scan] tick error", err && err.message ? err.message : err);
        });
    }, intervalMs);
    // eslint-disable-next-line no-console
    console.log(
        "[mirror-scan] 轮询已启动：每",
        intervalMs,
        "ms 最多处理",
        maxFilesPerTick,
        "个文件"
    );
};

/** @deprecated 请使用 reloadMirrorScanPollerFromSettings */
const startMirrorScanPoller = (intervalMs = 60000) => {
    stopMirrorScanPoller();
    pollOpts = { intervalMs, maxFilesPerTick: 80 };
    intervalId = setInterval(() => {
        void tick({ maxFilesPerTick: pollOpts?.maxFilesPerTick ?? 80 }).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[mirror-scan] tick error", err && err.message ? err.message : err);
        });
    }, intervalMs);
};

module.exports = {
    startMirrorScanPoller,
    stopMirrorScanPoller,
    reloadMirrorScanPollerFromSettings,
    mirrorScanTick: tick,
    mirrorScanFullPass
};
