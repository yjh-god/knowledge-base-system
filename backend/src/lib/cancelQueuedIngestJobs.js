const { runQuery } = require("./sqlcmd");

const sqlSafeUuid = (id) => String(id || "").replace(/'/g, "''");

const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

/**
 * 同一文档在排队中只保留一条 immediate_upload：新任务入队前取消旧 queued，避免任务数远大于文档数。
 */
const cancelQueuedImmediateUploadForDocument = async (docId) => {
    const id = String(docId || "").trim();
    if (!UUID_RE.test(id)) return;
    await runQuery(`
        UPDATE dbo.index_jobs
        SET status = N'cancelled',
            error_message = N'superseded by newer ingest job',
            finished_at = SYSDATETIMEOFFSET()
        WHERE document_id = CAST('${sqlSafeUuid(id)}' AS UNIQUEIDENTIFIER)
          AND job_type = N'immediate_upload'
          AND status = N'queued';
    `);
};

module.exports = { cancelQueuedImmediateUploadForDocument };
