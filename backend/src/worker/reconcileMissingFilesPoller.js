const fs = require("fs");

const { runQuery } = require("../lib/sqlcmd");
const { resolveStorageKeyToAbsolute } = require("../lib/storagePaths");
const { deleteVectorsByDocId } = require("./deleteWorker");

const isSqlcmdRowCountLine = (t) =>
    /^\(\d+/.test(t) &&
    (/(rows?\s+affected|row\s+affected)/i.test(t) || t.includes("\u884c\u53d7\u5f71\u54cd"));

const parseIdKeyRows = (stdout) => {
    const out = [];
    for (const raw of String(stdout || "").split(/\r?\n/)) {
        const line = raw.trimEnd();
        const t = line.trim();
        if (!t || isSqlcmdRowCountLine(t)) continue;
        const parts = line.split("\t");
        if (parts.length >= 2) {
            const id = parts[0].trim();
            const key = parts.slice(1).join("\t").trim();
            if (id && key) out.push({ id, storageKey: key });
        }
    }
    return out;
};

const tick = async () => {
    let stdout;
    try {
        stdout = await runQuery(
            `
            SELECT TOP (40)
                CONVERT(VARCHAR(36), id) + CHAR(9) + REPLACE(REPLACE(ISNULL(storage_key, N''), CHAR(9), N' '), CHAR(10), N' ')
            FROM dbo.documents
            WHERE deleted_at IS NULL
              AND status NOT IN (N'deleted')
              AND storage_key IS NOT NULL
              AND LTRIM(RTRIM(storage_key)) <> N''
            ORDER BY updated_at ASC;
        `,
            { columnSeparator: "\t" }
        );
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[reconcile-missing-files] sql error:", (e && e.message) || e);
        return;
    }

    const rows = parseIdKeyRows(stdout);
    for (const { id, storageKey } of rows) {
        const abs = resolveStorageKeyToAbsolute(storageKey);
        if (abs == null) continue;
        if (fs.existsSync(abs)) continue;

        try {
            // eslint-disable-next-line no-await-in-loop
            await deleteVectorsByDocId({ docId: id });
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[reconcile-missing-files] qdrant delete failed", id, (e && e.message) || e);
        }

        try {
            // eslint-disable-next-line no-await-in-loop
            await runQuery(`
                UPDATE dbo.documents
                SET status = N'deleted',
                    deleted_at = SYSDATETIMEOFFSET(),
                    updated_at = SYSDATETIMEOFFSET()
                WHERE id = CAST('${id.replace(/'/g, "''")}' AS UNIQUEIDENTIFIER)
                  AND deleted_at IS NULL;
            `);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[reconcile-missing-files] sql update failed", id, (e && e.message) || e);
        }
    }
};

let intervalId = null;

const startReconcileMissingFilesPoller = (intervalMs = 120000) => {
    if (intervalId != null) return;
    intervalId = setInterval(() => {
        void tick().catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[reconcile-missing-files] tick error", err && err.message ? err.message : err);
        });
    }, intervalMs);
};

module.exports = { startReconcileMissingFilesPoller, reconcileMissingFilesTick: tick };
