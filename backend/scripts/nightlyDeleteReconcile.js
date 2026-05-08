/* M3: Nightly delete reconciliation at 01:00 (PRD §5.5 / G3)
   - Delete vectors for SQL documents.status='deleted'
   - Reconcile orphan doc_id from Qdrant vs SQL documents table
*/

const { runQuery } = require("../src/lib/sqlcmd");
const { scrollPoints } = require("../src/lib/qdrantRestClient");
const { deleteVectorsByDocId } = require("../src/worker/deleteWorker");

const qdrantUrl = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const collection = process.env.QDRANT_COLLECTION || "kb_chunks";

const getDocIdsBySql = async (whereClause = "") => {
    const where = whereClause ? `WHERE ${whereClause}` : "";
    const rows = await runQuery(
        `SELECT CAST(id AS NVARCHAR(36)) AS doc_id FROM dbo.documents ${where};`
    );
    // sqlcmd -h -1 gives headerless output; each row per line.
    return rows
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
};

const loadAllDocIdsFromQdrant = async () => {
    const set = new Set();
    const pageLimit = 300;
    let offset = undefined;

    for (let page = 0; page < 60; page += 1) {
        const res = await scrollPoints({
            qdrantUrl,
            collection,
            limit: pageLimit,
            withPayload: true,
            offset
        });

        const points = res?.result || [];
        for (const p of points) {
            const payload = p?.payload || {};
            if (payload.doc_id != null) set.add(String(payload.doc_id));
        }

        offset = res?.next_page_offset;
        if (!offset) break;
    }

    return set;
};

const main = async () => {
    // 1) SQL-side deleted docs
    // eslint-disable-next-line no-console
    console.log("Nightly reconcile: deleting vectors for SQL deleted docs...");
    const deletedDocIds = await getDocIdsBySql("status = N'deleted'");
    // eslint-disable-next-line no-console
    console.log("deletedDocIds:", deletedDocIds.length);
    for (const docId of deletedDocIds) {
        // eslint-disable-next-line no-await-in-loop
        await deleteVectorsByDocId({ docId });
    }

    // 2) Orphan doc_id from Qdrant
    // eslint-disable-next-line no-console
    console.log("Nightly reconcile: scanning orphan doc_id from Qdrant...");
    const qdrantDocIds = await loadAllDocIdsFromQdrant();
    // eslint-disable-next-line no-console
    console.log("qdrantDocIds:", qdrantDocIds.size);

    const sqlDocIds = new Set(await getDocIdsBySql(""));
    // eslint-disable-next-line no-console
    console.log("sqlDocIds:", sqlDocIds.size);

    const orphanDocIds = [];
    for (const docId of qdrantDocIds) {
        if (!sqlDocIds.has(docId)) orphanDocIds.push(docId);
    }

    // eslint-disable-next-line no-console
    console.log("orphanDocIds:", orphanDocIds.length);
    for (const docId of orphanDocIds) {
        // eslint-disable-next-line no-await-in-loop
        await deleteVectorsByDocId({ docId });
    }

    // eslint-disable-next-line no-console
    console.log("Nightly reconcile completed.");
};

main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error("Nightly reconcile failed:", e);
    process.exit(1);
});

