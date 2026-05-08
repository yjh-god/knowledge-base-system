const { runQuery, runQueryScalarInt } = require("../lib/sqlcmd");
const { deleteVectorsByDocId } = require("./deleteWorker");

const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const PAIR_RE =
    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\|([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\s*$/;

const isSqlcmdRowCountLine = (t) =>
    /^\(\d+/.test(t) &&
    (/(rows?\s+affected|row\s+affected)/i.test(t) || t.includes("\u884c\u53d7\u5f71\u54cd"));

const parseJobHead = (stdout) => {
    for (const raw of String(stdout || "").split(/\r?\n/)) {
        const t = raw.trim();
        if (!t || isSqlcmdRowCountLine(t)) continue;
        const m = t.match(PAIR_RE);
        if (m) return { jobId: m[1], documentId: m[2] };
    }
    return null;
};

/**
 * 处理一条 queued 的 delete_vectors（补偿：同步删除失败或历史遗留）。
 */
const processOneDeleteJob = async () => {
    let headOut;
    try {
        headOut = await runQuery(`
            SELECT TOP (1) CONVERT(VARCHAR(36), j.id) + N'|' + CONVERT(VARCHAR(36), j.document_id)
            FROM dbo.index_jobs j
            WHERE j.job_type = N'delete_vectors' AND j.status = N'queued'
            ORDER BY j.priority DESC, j.created_at ASC;
        `);
    } catch (_) {
        return false;
    }

    const head = parseJobHead(headOut);
    if (!head) return false;

    const { jobId, documentId } = head;
    const safeJob = jobId.replace(/'/g, "''");
    const safeDoc = documentId.replace(/'/g, "''");

    try {
        await runQuery(`
            UPDATE dbo.index_jobs
            SET status = N'running',
                started_at = SYSDATETIMEOFFSET()
            WHERE id = CAST('${safeJob}' AS UNIQUEIDENTIFIER) AND status = N'queued';
        `);
    } catch (_) {
        return false;
    }

    const isMine = await runQueryScalarInt(`
        SELECT COUNT(*) FROM dbo.index_jobs
        WHERE id = CAST('${safeJob}' AS UNIQUEIDENTIFIER) AND status = N'running';
    `).catch(() => 0);
    if (isMine !== 1) return false;

    try {
        await deleteVectorsByDocId({ docId: documentId });
        await runQuery(`
            UPDATE dbo.index_jobs
            SET status = N'success',
                finished_at = SYSDATETIMEOFFSET(),
                error_message = NULL
            WHERE id = CAST('${safeJob}' AS UNIQUEIDENTIFIER);
        `);
        return true;
    } catch (e) {
        const msg = String((e && e.message) || e).replace(/'/g, "''").slice(0, 1900);
        await runQuery(`
            UPDATE dbo.index_jobs
            SET
                attempt_count = attempt_count + 1,
                error_message = N'${msg}',
                started_at = NULL,
                status = CASE
                    WHEN attempt_count + 1 >= max_attempts THEN N'failed'
                    ELSE N'queued'
                END,
                finished_at = CASE
                    WHEN attempt_count + 1 >= max_attempts THEN SYSDATETIMEOFFSET()
                    ELSE NULL
                END
            WHERE id = CAST('${safeJob}' AS UNIQUEIDENTIFIER);
        `);
        return true;
    }
};

let deleteIntervalId = null;

const startDeleteJobPoller = (intervalMs = 3000) => {
    if (deleteIntervalId != null) return;
    deleteIntervalId = setInterval(() => {
        void processOneDeleteJob().catch(() => {});
    }, intervalMs);
};

module.exports = { startDeleteJobPoller, processOneDeleteJob };
