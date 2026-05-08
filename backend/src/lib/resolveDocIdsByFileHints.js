const { runQueryTsv } = require("./sqlcmd");
const { escapeSql } = require("./auditLog");

const UUID_LINE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/i;

/**
 * 用问句中的文件名/编号在 documents 表反查 doc_id，供 Qdrant scroll 加 doc_id 过滤，
 * 避免大库无过滤 scroll 在点数上限内永远采不到目标文档块。
 *
 * @param {string[]} hints
 * @returns {Promise<string[]>} 小写 UUID，最多 24 条
 */
const resolveDocIdsByFileHints = async (hints) => {
    const list = Array.isArray(hints)
        ? hints.map((h) => String(h || "").trim()).filter((h) => h.length >= 4)
        : [];
    if (!list.length) return [];

    const uniq = [...new Set(list)].sort((a, b) => b.length - a.length).slice(0, 5);
    const parts = uniq.map(
        (h) =>
            `(title LIKE N'%${escapeSql(h)}%' OR storage_key LIKE N'%${escapeSql(h)}%')`
    );
    const whereOr = parts.join(" OR ");

    let rows;
    try {
        rows = await runQueryTsv(
            `
            SELECT TOP (24) CAST(id AS NVARCHAR(36))
            FROM dbo.documents
            WHERE ISNULL(status, N'') <> N'deleted'
              AND (${whereOr});
        `.trim(),
            { variableLengthY: 4000 }
        );
    } catch {
        return [];
    }

    const out = [];
    const seen = new Set();
    for (const row of rows || []) {
        const id = String(row && row[0] ? row[0] : "")
            .trim()
            .toLowerCase();
        if (!UUID_LINE.test(id) || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
};

module.exports = { resolveDocIdsByFileHints };
