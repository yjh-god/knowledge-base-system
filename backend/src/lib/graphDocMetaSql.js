/**
 * 入库时从 documents 行读取知识图谱相关元数据（需已执行 sql/010_kg_schema.sql）。
 */

const { runQueryTsv } = require("./sqlcmd");

const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

/**
 * @param {string} documentId
 * @returns {Promise<object>}
 */
const fetchGraphDocMetaForIngest = async (documentId) => {
    if (!UUID_RE.test(String(documentId || ""))) {
        return {};
    }
    const safe = String(documentId).replace(/'/g, "''");
    let rows;
    try {
        rows = await runQueryTsv(
            `
            SELECT
                REPLACE(REPLACE(REPLACE(ISNULL(title, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(knowledge_type, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(author, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(doc_version, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(source_uri, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(department_caption, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                CONVERT(NVARCHAR(40), created_at, 127)
            FROM dbo.documents
            WHERE id = CAST('${safe}' AS UNIQUEIDENTIFIER);
            `,
            { variableLengthY: 8000 }
        );
    } catch {
        return {};
    }
    const row = rows && rows[0];
    if (!row || row.length < 7) return {};

    const nz = (v) => {
        const s = String(v ?? "").trim();
        return s || null;
    };

    return {
        title: nz(row[0]) || "",
        knowledgeType: nz(row[1]),
        author: nz(row[2]),
        docVersion: nz(row[3]),
        sourceUri: nz(row[4]),
        departmentCaption: nz(row[5]),
        docCreatedAt: nz(row[6])
    };
};

module.exports = { fetchGraphDocMetaForIngest };
