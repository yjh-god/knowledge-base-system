const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "..", "..", "..", "debug-4d99a4.log");
const ENDPOINT = "http://127.0.0.1:7267/ingest/1ac3dd64-387b-48c9-973e-f2097f200d3a";

/**
 * Debug session 4d99a4：写 NDJSON 到仓库根 debug-4d99a4.log，并尽力 POST 到 ingest（失败忽略）。
 */
const debugNdjson = (payload) => {
    const lineObj = { sessionId: "4d99a4", timestamp: Date.now(), ...payload };
    try {
        fs.appendFileSync(LOG_FILE, `${JSON.stringify(lineObj)}\n`);
    } catch {
        /* ignore */
    }
    fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "4d99a4" },
        body: JSON.stringify(lineObj)
    }).catch(() => {});
};

module.exports = { debugNdjson, LOG_FILE };
