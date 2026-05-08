/** 全进程仅一条 ingest（poller / HTTP Mock 等）并行会共踩 ingestDebugState 与 sqlcmd，需互斥 */
let ingestLocked = false;

const tryBeginIngestSection = () => {
    if (ingestLocked) return false;
    ingestLocked = true;
    return true;
};

const endIngestSection = () => {
    ingestLocked = false;
};

module.exports = { tryBeginIngestSection, endIngestSection };
