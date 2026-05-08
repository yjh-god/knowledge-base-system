const fs = require("fs");
const { runQuery, runQueryScalarInt } = require("../lib/sqlcmd");
const { formatFetchError } = require("../lib/fetchErrorDetail");
const { ingestSingleTextFile } = require("./ingestWorker");
const { resetForJob, setPhase, getIngestDebugSnapshot } = require("../lib/ingestDebugState");
const { tryBeginIngestSection, endIngestSection } = require("../lib/ingestConcurrency");
const { appendDebug } = require("../lib/debugSessionLog");

const { sqlIntOrNull, sqlNVarCharOrNull } = require("../lib/sqlLiteral");
const { fetchGraphDocMetaForIngest } = require("../lib/graphDocMetaSql");
const { debugNdjson } = require("../lib/debugSessionNdjson");

const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const PAIR_RE =
    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\|([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\s*$/;

const isSqlcmdRowCountLine = (t) =>
    /^\(\d+/.test(t) &&
    (/(rows?\s+affected|row\s+affected)/i.test(t) || t.includes("\u884c\u53d7\u5f71\u54cd"));

const parseQueuedJobHead = (stdout) => {
    for (const raw of String(stdout || "").split(/\r?\n/)) {
        const t = raw.trim();
        if (!t || isSqlcmdRowCountLine(t)) continue;
        const m = t.match(PAIR_RE);
        if (m) return { jobId: m[1], documentId: m[2] };
    }
    return null;
};

const stripSqlcmdRowcountFooter = (stdout) => {
    const lines = String(stdout || "").split(/\r?\n/);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    while (lines.length) {
        const t = lines[lines.length - 1].trim();
        if (isSqlcmdRowCountLine(t)) lines.pop();
        else break;
    }
    return lines.join("\n").trim();
};

/** sqlcmd 未使用 -h-1 时可能输出列名头行，跳过直至遇到 JSON 对象首行 */
const extractPayloadJsonLine = (stdout) => {
    const body = stripSqlcmdRowcountFooter(stdout);
    for (const raw of body.split(/\r?\n/)) {
        const s = raw.trim();
        if (s.startsWith("{")) return s;
    }
    return body.trim();
};

/** 进程内 ingestDebug 在任务已结束（库中无 queued/running）时仍可能残留 4 月旧 lastError；按库状态清掉，避免 H_TICK 无限刷历史 */
const TERMINAL_INGEST_DEBUG_PHASES = new Set([
    "poller_sql_error",
    "payload_sql_error",
    "payload_parse_error",
    "file_missing",
    "ingest_failed",
    "success",
    "skipped_unchanged_md5"
]);

const staleRunningMinutes = () => {
    const n = Number(process.env.INGEST_STALE_RUNNING_MINUTES);
    if (Number.isFinite(n) && n >= 5) return Math.min(24 * 60, Math.floor(n));
    return 45;
};

/** 终端态 + updatedAt 过久或明显「未来」（时钟偏差）→ 不依赖 SQL 先清进程内快照，打破 H_TICK 死循环 */
const maxIngestDebugAgeMs = () => {
    const n = Number(process.env.INGEST_DEBUG_MAX_AGE_MS);
    if (Number.isFinite(n) && n >= 60_000) return Math.min(7 * 24 * 60 * 60 * 1000, n);
    return 3 * 60 * 1000;
};

const resetStaleIngestDebugByAge = () => {
    const snap = getIngestDebugSnapshot();
    if (!TERMINAL_INGEST_DEBUG_PHASES.has(snap.phase)) return false;
    const u = snap.updatedAt;
    if (!u || typeof u !== "string") return false;
    const ts = Date.parse(u);
    if (!Number.isFinite(ts)) return false;
    const now = Date.now();
    const staleMs = maxIngestDebugAgeMs();
    const skewFutureMs = 2 * 60 * 1000;
    const tooOld = now - ts > staleMs;
    const tooFuture = ts - now > skewFutureMs;
    if (!tooOld && !tooFuture) return false;
    const prevPhase = snap.phase;
    const prevUpdatedAt = snap.updatedAt;
    setPhase("idle", { lastError: null });
    appendDebug({
        runId: "ingest-debug-age-reset",
        hypothesisId: "H_AGE",
        location: "ingestJobPoller.js:resetStaleIngestDebugByAge",
        message: "cleared terminal ingestDebug by snapshot age or clock skew",
        data: { prevPhase, prevUpdatedAt, tooOld, tooFuture, staleMs }
    });
    return true;
};

/** 崩溃/重启后 index_jobs 可能永久卡在 running，导致 maybeClear 永远不执行 */
const reclaimStaleRunningIngestJobs = async () => {
    const mins = staleRunningMinutes();
    const staleRunClause = `
        (
            (started_at IS NOT NULL AND started_at < DATEADD(minute, -${mins}, SYSDATETIMEOFFSET()))
            OR (started_at IS NULL AND created_at < DATEADD(minute, -${mins}, SYSDATETIMEOFFSET()))
        )`;
    const nStale = await runQueryScalarInt(`
        SELECT COUNT(*) FROM dbo.index_jobs
        WHERE job_type = N'immediate_upload' AND status = N'running'
        AND ${staleRunClause};
    `);
    if (nStale === 0) return 0;
    await runQuery(`
        UPDATE d
        SET d.status = N'failed', d.updated_at = SYSDATETIMEOFFSET()
        FROM dbo.documents d
        INNER JOIN dbo.index_jobs j ON j.document_id = d.id
        WHERE j.job_type = N'immediate_upload' AND j.status = N'running'
        AND (
            (j.started_at IS NOT NULL AND j.started_at < DATEADD(minute, -${mins}, SYSDATETIMEOFFSET()))
            OR (j.started_at IS NULL AND j.created_at < DATEADD(minute, -${mins}, SYSDATETIMEOFFSET()))
        );

        UPDATE dbo.index_jobs
        SET status = N'failed',
            error_message = N'running 状态超时（进程中断或崩溃），已由 poller 回收；请重新入队',
            finished_at = SYSDATETIMEOFFSET()
        WHERE job_type = N'immediate_upload' AND status = N'running'
        AND ${staleRunClause};
    `);
    appendDebug({
        runId: "poller-reclaim-running",
        hypothesisId: "H_STALE_RUN",
        location: "ingestJobPoller.js:reclaimStaleRunningIngestJobs",
        message: "reclaimed stale running immediate_upload jobs",
        data: { count: nStale, staleMinutes: mins }
    });
    return nStale;
};

let lastMaybeClearSqlErrLogAt = 0;

const maybeClearStaleIngestDebug = async () => {
    resetStaleIngestDebugByAge();
    try {
        await reclaimStaleRunningIngestJobs();
        const nQueued = await runQueryScalarInt(`
            SELECT COUNT(*) FROM dbo.index_jobs
            WHERE job_type = N'immediate_upload' AND status = N'queued';
        `);
        const nRunning = await runQueryScalarInt(`
            SELECT COUNT(*) FROM dbo.index_jobs
            WHERE job_type = N'immediate_upload' AND status = N'running';
        `);
        if (nQueued !== 0 || nRunning !== 0) return;
        const snap = getIngestDebugSnapshot();
        if (TERMINAL_INGEST_DEBUG_PHASES.has(snap.phase)) {
            setPhase("idle", { lastError: null });
            appendDebug({
                runId: "poller-debug-cleared",
                hypothesisId: "H_CLEAR",
                location: "ingestJobPoller.js:maybeClearStaleIngestDebug",
                message: "cleared terminal ingestDebug (no queued/running jobs)",
                data: { prevPhase: snap.phase }
            });
        }
    } catch (e) {
        const t = Date.now();
        if (t - lastMaybeClearSqlErrLogAt > 60_000) {
            lastMaybeClearSqlErrLogAt = t;
            try {
                appendDebug({
                    runId: "poller-maybe-clear-sql-err",
                    hypothesisId: "H_SQL",
                    location: "ingestJobPoller.js:maybeClearStaleIngestDebug",
                    message: "maybeClearStaleIngestDebug sql path failed",
                    data: { err: String((e && e.message) || e).slice(0, 500) }
                });
            } catch (_) {
                /* ignore */
            }
        }
    }
};

/**
 * 领取并处理一条 queued 的 immediate_upload 任务（单实例串行，避免并发打爆 embedding）
 * 注意：SQL Server 2014 无 FOR JSON，故不用 runQueryJson 拉队首任务。
 */
const processOneQueuedIngestJob = async () => {
    resetStaleIngestDebugByAge();
    await maybeClearStaleIngestDebug();
    if (!tryBeginIngestSection()) return;
    try {
        let head;
        try {
            const headOut = await runQuery(`
            SELECT TOP (1) CONVERT(VARCHAR(36), id) + N'|' + CONVERT(VARCHAR(36), document_id)
            FROM dbo.index_jobs
            WHERE job_type = N'immediate_upload' AND status = N'queued'
            ORDER BY created_at ASC;
        `);
            head = parseQueuedJobHead(headOut);
        } catch (e) {
            setPhase("poller_sql_error", { lastError: (e && e.message) || String(e) });
            return;
        }

        if (!head) return;

        const { jobId, documentId } = head;
        if (!UUID_RE.test(String(jobId)) || !UUID_RE.test(String(documentId))) return;

        let payloadJsonText;
        try {
            const plOut = await runQuery(
                `
            SELECT payload_json
            FROM dbo.index_jobs
            WHERE id = CAST('${jobId}' AS UNIQUEIDENTIFIER);
        `,
                { variableLengthY: 8000 }
            );
            payloadJsonText = extractPayloadJsonLine(plOut);
        } catch (e) {
            setPhase("payload_sql_error", { lastError: (e && e.message) || String(e) });
            return;
        }

        let payload;
        try {
            payload = JSON.parse(payloadJsonText || "{}");
        } catch (_) {
            setPhase("payload_parse_error", { lastError: "payload_json 无法解析" });
            await runQuery(`
            UPDATE dbo.index_jobs
            SET status = N'failed',
                error_message = N'payload_json 无法解析',
                finished_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${jobId}' AS UNIQUEIDENTIFIER);
        `);
            await runQuery(`
            UPDATE dbo.documents
            SET status = N'failed', updated_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${documentId}' AS UNIQUEIDENTIFIER);
        `);
            return;
        }

        resetForJob(jobId, documentId, payload.batchId || null);

        const { filePath, filePathInPayload, mimeType, visibleDeptIds, docTitle } = payload;
        if (!filePath || typeof filePath !== "string" || !fs.existsSync(filePath)) {
            // #region agent log
            debugNdjson({
                hypothesisId: "H3",
                location: "ingestJobPoller.js:fileMissing",
                message: "ingest job file path missing",
                data: {
                    jobId,
                    documentId,
                    pathTail: String(filePath || "").slice(-120)
                }
            });
            // #endregion
            setPhase("file_missing", { lastError: "本地文件不存在或路径无效" });
            await runQuery(`
            UPDATE dbo.index_jobs
            SET status = N'failed',
                error_message = N'本地文件不存在或路径无效',
                finished_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${jobId}' AS UNIQUEIDENTIFIER);
        `);
            await runQuery(`
            UPDATE dbo.documents
            SET status = N'failed', updated_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${documentId}' AS UNIQUEIDENTIFIER);
        `);
            return;
        }

        try {
            await runQuery(`
            UPDATE dbo.index_jobs
            SET status = N'running',
                started_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${jobId}' AS UNIQUEIDENTIFIER) AND status = N'queued';
        `);
        } catch (_) {
            return;
        }
        const isMine = await runQueryScalarInt(`
        SELECT COUNT(*) FROM dbo.index_jobs
        WHERE id = CAST('${jobId}' AS UNIQUEIDENTIFIER) AND status = N'running';
    `).catch(() => 0);
        if (isMine !== 1) return;

        // #region agent log
        {
            let st0 = -1;
            try {
                st0 = fs.statSync(filePath).size;
            } catch {
                st0 = -2;
            }
            debugNdjson({
                hypothesisId: "H3",
                location: "ingestJobPoller.js:beforeIngest",
                message: "file exists stat size before ingestSingleTextFile",
                data: {
                    jobId,
                    documentId,
                    stSize: st0,
                    pathTail: String(filePath).slice(-100)
                }
            });
        }
        // #endregion

        setPhase("running_ingest");
        try {
            let graphDocMeta = {};
            try {
                graphDocMeta = await fetchGraphDocMetaForIngest(documentId);
            } catch {
                graphDocMeta = {};
            }
            const ingestResult = await ingestSingleTextFile({
                filePath,
                docId: documentId,
                filePathInPayload: filePathInPayload || filePath,
                visibleDeptIds: Array.isArray(visibleDeptIds) ? visibleDeptIds : [],
                mimeType: mimeType || "text/plain",
                docTitle: docTitle != null && String(docTitle).trim() ? String(docTitle).trim() : null,
                graphDocMeta
            });
            const md5 = ingestResult?.contentMd5 || "";
            const ihash = ingestResult?.contentHash || "";
            const md5Sql = md5.replace(/'/g, "''");
            const hashSql = ihash.replace(/'/g, "''");
            const skipped = ingestResult?.skipped === true;
            const im = ingestResult?.indexMeta;
            let sizeBytesOnDisk = 0;
            try {
                sizeBytesOnDisk = fs.statSync(filePath).size;
            } catch (_) {
                /* ignore */
            }
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
                size_bytes = ${sizeBytesOnDisk},
                content_md5 = N'${md5Sql}',
                indexed_content_md5 = N'${md5Sql}',
                indexed_content_hash = N'${hashSql}',
                updated_at = SYSDATETIMEOFFSET()${indexCols}
            WHERE id = CAST('${documentId}' AS UNIQUEIDENTIFIER);
        `);
            await runQuery(`
            UPDATE dbo.index_jobs
            SET status = N'success',
                finished_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${jobId}' AS UNIQUEIDENTIFIER);
        `);
            setPhase("success");
            // #region agent log
            debugNdjson({
                hypothesisId: "H4",
                location: "ingestJobPoller.js:ingestSuccess",
                message: "indexed document size_bytes update",
                data: {
                    jobId,
                    documentId,
                    sizeBytesOnDisk,
                    skipped
                }
            });
            // #endregion
        } catch (e) {
            const brief = (e && e.message) || String(e);
            const extra = formatFetchError("ingest", e);
            const msg =
                brief.length < 80 || /^fetch failed$/i.test(String(brief).trim())
                    ? `${brief} | ${extra}`.slice(0, 2000)
                    : brief.slice(0, 2000);
            const safe = msg.replace(/'/g, "''");
            setPhase("ingest_failed", { lastError: msg });
            // #region agent log
            debugNdjson({
                hypothesisId: "H2",
                location: "ingestJobPoller.js:ingestFailed",
                message: String(brief).slice(0, 200),
                data: { jobId, documentId, pathTail: String(payload.filePath || "").slice(-120) }
            });
            // #endregion
            const bucket = /Qdrant/i.test(msg)
                ? "qdrant"
                : /sqlcmd|Sqlcmd/i.test(msg)
                  ? "sqlcmd"
                  : /embed|embedding|EMBEDDING/i.test(msg)
                    ? "embedding"
                    : /Empty document|file/i.test(msg)
                      ? "file_or_parse"
                      : "other";
            appendDebug({
                runId: "ingest-job-failed",
                hypothesisId: "H_ING_FAIL",
                location: "ingestJobPoller.js:ingest.catch",
                message: "ingestSingleTextFile threw",
                data: { bucket, jobId, documentId, msgSlice: msg.slice(0, 500) }
            });
            fetch("http://127.0.0.1:7267/ingest/1ac3dd64-387b-48c9-973e-f2097f200d3a", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "840c9e" },
                body: JSON.stringify({
                    sessionId: "840c9e",
                    runId: "ingest-job-failed",
                    hypothesisId: "H_ING_FAIL",
                    location: "ingestJobPoller.js:ingest.catch",
                    message: "ingest failed",
                    data: { bucket, jobId, documentId, msgSlice: msg.slice(0, 400) },
                    timestamp: Date.now()
                })
            }).catch(() => {});
            // #endregion
            // eslint-disable-next-line no-console
            console.error("[ingest] job failed", { jobId, documentId, message: msg });
            await runQuery(`
            UPDATE dbo.documents
            SET status = N'failed', updated_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${documentId}' AS UNIQUEIDENTIFIER);
        `);
            await runQuery(`
            UPDATE dbo.index_jobs
            SET status = N'failed',
                error_message = N'${safe}',
                finished_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${jobId}' AS UNIQUEIDENTIFIER);
        `);
        }
    } finally {
        endIngestSection();
    }
};

let intervalId = null;

const startIngestJobPoller = (intervalMs = 2000) => {
    if (intervalId != null) return;
    intervalId = setInterval(() => {
        void processOneQueuedIngestJob().catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[ingest] poller tick error", err && err.message ? err.message : err);
        });
    }, intervalMs);
};

module.exports = { startIngestJobPoller, processOneQueuedIngestJob, resetStaleIngestDebugByAge };
