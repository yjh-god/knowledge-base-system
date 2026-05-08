const { deleteByFilter } = require("../lib/qdrantRestClient");

const deleteVectorsByDocId = async ({ docId }) => {
    const qdrantUrl = process.env.QDRANT_URL || "http://127.0.0.1:6333";
    const collection = process.env.QDRANT_COLLECTION || "kb_chunks";

    // PRD payload keeps `doc_id` and we delete all points matching it.
    const filter = {
        must: [
            {
                key: "doc_id",
                match: {
                    value: docId
                }
            }
        ]
    };

    await deleteByFilter({ qdrantUrl, collection, filter });
};

module.exports = { deleteVectorsByDocId };

