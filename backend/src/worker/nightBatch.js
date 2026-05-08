const { runQuery } = require("../lib/sqlcmd");
const { deleteVectorsByDocId } = require("./deleteWorker");
const { scrollPoints, deleteByFilter } = require("../lib/qdrantRestClient");

const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/i;

const isSqlcmdRowCountLine = (t) =>
    /^\(\d+/.test(t) &&
    (/(rows?\s+affected|row\s+affected)/i.test(t) || t.includes("\u884c\u53d7\u5f71\u54cd"));

const parseUuidColumn = (stdout) => {
    const out = [];
    for (const raw of String(stdout || "").split(/\r?\n/)) {
        const t = raw.trim();
        if (!t || isSqlcmdRowCountLine(t)) continue;
        if (UUID_RE.test(t)) out.push(t.trim());
    }
    return out;
};

/**
 * PRD §5.5：对已标记删除的文档再次执行向量删除（幂等）。
 */
const reconcileDeletedDocumentVectors = async ({ maxDocs = 80 } = {}) => {
    const cap = Math.max(1, Math.min(500, Number(maxDocs) || 80));
    let stdout;
    try {
        stdout = await runQuery(`
            SELECT TOP (${cap}) CONVERT(VARCHAR(36), id)
            FROM dbo.documents
            WHERE status = N'deleted'
            ORDER BY deleted_at ASC, updated_at ASC;
        `);
    } catch (_) {
        return { deletedDocsAttempted: 0, errors: ["sql"] };
    }
    const ids = parseUuidColumn(stdout);
    let ok = 0;
    const errors = [];
    for (const docId of ids) {
        try {
            await deleteVectorsByDocId({ docId });
            ok += 1;
        } catch (e) {
            errors.push(`${docId}:${String((e && e.message) || e).slice(0, 80)}`);
        }
    }
    return { deletedDocsAttempted: ids.length, deletedVectorsOk: ok, errors };
};

const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
};

/**
 * 抽样 scroll Qdrant，删除 documents 表中已不存在的 doc_id 对应点（上限防拖垮）。
 */
const reconcileOrphanQdrantPoints = async ({
    maxPointsToScan = 8000,
    scrollLimit = 256
} = {}) => {
    const qdrantUrl = process.env.QDRANT_URL || "http://127.0.0.1:6333";
    const collection = process.env.QDRANT_COLLECTION || "kb_chunks";
    const cap = Math.max(100, Math.min(200000, Number(maxPointsToScan) || 8000));
    const lim = Math.max(32, Math.min(512, Number(scrollLimit) || 256));

    let offset = null;
    let scanned = 0;
    const seenDocIds = new Set();
    while (scanned < cap) {
        let res;
        try {
            res = await scrollPoints({
                qdrantUrl,
                collection,
                limit: lim,
                offset: offset || undefined,
                withPayload: true
            });
        } catch (e) {
            return { scanned, orphanDeletes: 0, error: String((e && e.message) || e).slice(0, 200) };
        }
        const result = res?.result || res;
        const points = result?.points || [];
        if (!points.length) break;
        for (const p of points) {
            const d = p?.payload?.doc_id;
            if (d && UUID_RE.test(String(d))) seenDocIds.add(String(d).trim());
        }
        scanned += points.length;
        offset = result?.next_page_offset;
        if (offset == null) break;
    }

    const docList = [...seenDocIds];
    const existing = new Set();
    const batchSize = 40;
    for (const part of chunk(docList, batchSize)) {
        const inList = part
            .map((id) => `CAST(N'${id.replace(/'/g, "''")}' AS UNIQUEIDENTIFIER)`)
            .join(", ");
        if (!inList) continue;
        let stdout;
        try {
            stdout = await runQuery(`
                SELECT CONVERT(VARCHAR(36), id)
                FROM dbo.documents
                WHERE id IN (${inList});
            `);
        } catch (_) {
            continue;
        }
        for (const id of parseUuidColumn(stdout)) existing.add(id.toLowerCase());
    }

    let orphanDeletes = 0;
    for (const did of docList) {
        if (existing.has(did.toLowerCase())) continue;
        try {
            await deleteByFilter({
                qdrantUrl,
                collection,
                filter: {
                    must: [{ key: "doc_id", match: { value: did } }]
                }
            });
            orphanDeletes += 1;
        } catch (_) {
            /* ignore */
        }
    }

    return { scanned, distinctDocIds: docList.length, orphanDeletes };
};

/**
 * 单次夜间批处理入口（由 Cron 调用）。
 */
const runNightReconcileOnce = async () => {
    const maxDocs = process.env.KB_NIGHT_RECONCILE_DELETED_MAX
        ? Number(process.env.KB_NIGHT_RECONCILE_DELETED_MAX)
        : 80;
    const maxScan = process.env.KB_ORPHAN_SCROLL_MAX_POINTS
        ? Number(process.env.KB_ORPHAN_SCROLL_MAX_POINTS)
        : 8000;
    const skipOrphan = String(process.env.KB_NIGHT_SKIP_ORPHAN || "") === "1";

    const a = await reconcileDeletedDocumentVectors({ maxDocs });
    const b = skipOrphan
        ? { skipped: true }
        : await reconcileOrphanQdrantPoints({ maxPointsToScan: maxScan });
    // eslint-disable-next-line no-console
    console.log("[night-batch] done", JSON.stringify({ reconcileDeleted: a, orphan: b }));
    return { reconcileDeleted: a, orphan: b };
};

module.exports = {
    runNightReconcileOnce,
    reconcileDeletedDocumentVectors,
    reconcileOrphanQdrantPoints
};
