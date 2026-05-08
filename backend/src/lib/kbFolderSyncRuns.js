const crypto = require("crypto");
const { runQuery, runQueryTsv } = require("./sqlcmd");
const { escapeSql } = require("./auditLog");

const toSqlDtOffset = (d) => {
    const iso = (d instanceof Date ? d : new Date(d || Date.now())).toISOString();
    return `CONVERT(DATETIMEOFFSET, N'${escapeSql(iso)}', 127)`;
};

const insertFolderSyncRun = async (row) => {
    const id = crypto.randomUUID();
    const triggerType = escapeSql(String(row.triggerType || "manual").slice(0, 32));
    const status = escapeSql(String(row.status || "unknown").slice(0, 32));
    const summary = escapeSql(String(row.summary ?? "").slice(0, 2000));
    const startedSql = row.startedAt ? toSqlDtOffset(row.startedAt) : "SYSDATETIMEOFFSET()";
    const finishedSql = row.finishedAt ? toSqlDtOffset(row.finishedAt) : "SYSDATETIMEOFFSET()";
    const dur = row.durationMs != null && Number.isFinite(Number(row.durationMs)) ? Number(row.durationMs) : "NULL";
    const fos = row.filesOnShare != null ? Number(row.filesOnShare) : "NULL";
    const copied = row.copied != null ? Number(row.copied) : "NULL";
    const skipped = row.skippedMd5 != null ? Number(row.skippedMd5) : "NULL";
    const removed = row.removedStaging != null ? Number(row.removedStaging) : "NULL";
    const purged = row.docsPurged != null ? Number(row.docsPurged) : "NULL";
    const ferr = row.fileErrors != null ? Number(row.fileErrors) : "NULL";

    await runQuery(`
        INSERT INTO dbo.kb_folder_sync_runs (
            id, started_at, finished_at, trigger_type, status, duration_ms,
            files_on_share, copied, skipped_md5, removed_staging, docs_purged, file_errors, summary
        )
        VALUES (
            '${id}',
            ${startedSql},
            ${finishedSql},
            N'${triggerType}',
            N'${status}',
            ${dur},
            ${fos},
            ${copied},
            ${skipped},
            ${removed},
            ${purged},
            ${ferr},
            N'${summary}'
        );
    `);
};

const listFolderSyncRuns = async (page = 1, pageSize = 20) => {
    const p = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const offset = (p - 1) * ps;

    const totalRow = await runQueryTsv(`SELECT CAST(COUNT(*) AS VARCHAR(20)) FROM dbo.kb_folder_sync_runs;`, {});
    const total = totalRow.length ? Number(totalRow[0][0]) || 0 : 0;

    const rows = await runQueryTsv(
        `
        SELECT
            CONVERT(VARCHAR(36), id),
            CONVERT(VARCHAR(33), started_at, 127),
            CONVERT(VARCHAR(33), finished_at, 127),
            ISNULL(trigger_type, N''),
            ISNULL(status, N''),
            CAST(ISNULL(duration_ms, -1) AS VARCHAR(20)),
            CAST(ISNULL(files_on_share, -1) AS VARCHAR(20)),
            CAST(ISNULL(copied, -1) AS VARCHAR(20)),
            CAST(ISNULL(skipped_md5, -1) AS VARCHAR(20)),
            CAST(ISNULL(removed_staging, -1) AS VARCHAR(20)),
            CAST(ISNULL(docs_purged, -1) AS VARCHAR(20)),
            CAST(ISNULL(file_errors, -1) AS VARCHAR(20)),
            ISNULL(summary, N'')
        FROM dbo.kb_folder_sync_runs
        ORDER BY finished_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${ps} ROWS ONLY;
        `,
        { variableLengthY: 8000 }
    );

    const items = rows.map((r) => ({
        id: r[0],
        startedAt: r[1],
        finishedAt: r[2],
        triggerType: r[3],
        status: r[4],
        durationMs: Number(r[5]) >= 0 ? Number(r[5]) : null,
        filesOnShare: Number(r[6]) >= 0 ? Number(r[6]) : null,
        copied: Number(r[7]) >= 0 ? Number(r[7]) : null,
        skippedMd5: Number(r[8]) >= 0 ? Number(r[8]) : null,
        removedStaging: Number(r[9]) >= 0 ? Number(r[9]) : null,
        docsPurged: Number(r[10]) >= 0 ? Number(r[10]) : null,
        fileErrors: Number(r[11]) >= 0 ? Number(r[11]) : null,
        summary: r[12] || ""
    }));

    return { page: p, pageSize: ps, total, items };
};

module.exports = { insertFolderSyncRun, listFolderSyncRuns };
