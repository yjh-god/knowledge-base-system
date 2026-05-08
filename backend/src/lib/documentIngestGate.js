const { runQuery } = require("./sqlcmd");

const isSqlcmdRowCountLine = (t) =>
    /^\(\d+/.test(t) &&
    (/(rows?\s+affected|row\s+affected)/i.test(t) || t.includes("\u884c\u53d7\u5f71\u54cd"));

/**
 * 读取文档入库门闸状态（避免 FOR JSON，兼容 SQL Server 2014）。
 * 返回 null 表示列不存在或查询失败，调用方应走完整入库。
 */
const getDocumentIngestState = async (docId) => {
    try {
        const stdout = await runQuery(`
            SELECT CONCAT(
                REPLACE(REPLACE(ISNULL(status, N''), N'|', N''), NCHAR(10), N''),
                N'|',
                REPLACE(REPLACE(ISNULL(indexed_content_md5, N''), N'|', N''), NCHAR(10), N''),
                N'|',
                REPLACE(REPLACE(ISNULL(content_md5, N''), N'|', N''), NCHAR(10), N'')
            )
            FROM dbo.documents
            WHERE id = CAST('${docId}' AS UNIQUEIDENTIFIER);
        `);
        for (const raw of String(stdout || "").split(/\r?\n/)) {
            const t = raw.trim();
            if (!t || isSqlcmdRowCountLine(t)) continue;
            const parts = t.split("|");
            if (parts.length >= 3) {
                const status = parts[0] || "";
                const indexedMd5 = parts[1] || null;
                const contentMd5 = parts[2] || null;
                return {
                    status: status || null,
                    indexed_content_md5: indexedMd5 || null,
                    content_md5: contentMd5 || null
                };
            }
        }
        return null;
    } catch (_) {
        return null;
    }
};

module.exports = { getDocumentIngestState };
