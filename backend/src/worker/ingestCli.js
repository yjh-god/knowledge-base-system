const path = require("path");

const { ingestSingleTextFile } = require("./ingestWorker");

const getArg = (name, fallback) => {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx === -1) return fallback;
    return process.argv[idx + 1];
};

const main = async () => {
    const filePath = getArg("file");
    const docId = getArg("docId") || `doc_${Date.now()}`;
    const filePathInPayload = getArg("filePathInPayload");
    const deptIdsRaw = getArg("deptIds");

    if (!filePath) {
        // eslint-disable-next-line no-console
        console.error("Usage: node ingestCli.js --file <path> [--docId <id>] [--deptIds <1,2,3>]");
        process.exit(1);
    }

    const visibleDeptIds = deptIdsRaw
        ? deptIdsRaw.split(",").map((x) => x.trim()).filter(Boolean)
        : [];

    // eslint-disable-next-line no-console
    console.log("Start ingest:", { filePath, docId, visibleDeptIds });

    await ingestSingleTextFile({
        filePath,
        docId,
        filePathInPayload: filePathInPayload || path.dirname(filePath),
        visibleDeptIds
    });

    // eslint-disable-next-line no-console
    console.log("Ingest completed:", docId);
};

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Ingest failed:", err);
    process.exit(1);
});

