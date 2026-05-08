const fs = require("fs");
const path = require("path");

/** 与 Cursor debug 会话约定一致，写入仓库根目录（Knowledge_base/debug-840c9e.log） */
const LOG_PATH = path.join(__dirname, "..", "..", "..", "debug-840c9e.log");
const SESSION_ID = "840c9e";

/**
 * @param {Record<string, unknown>} entry
 */
function appendDebug(entry) {
    const line = `${JSON.stringify({
        sessionId: SESSION_ID,
        timestamp: Date.now(),
        ...entry
    })}\n`;
    const repoRoot = path.dirname(LOG_PATH);
    const cursorLog = path.join(repoRoot, ".cursor", "debug-840c9e.log");
    const targets = [
        cursorLog,
        LOG_PATH,
        path.join(process.cwd(), "debug-840c9e.log"),
        path.join(process.cwd(), ".cursor", "debug-840c9e.log"),
        path.join(__dirname, "..", "..", "debug-840c9e.log"),
        path.join(__dirname, "..", "..", ".cursor", "debug-840c9e.log")
    ];
    let ok = false;
    let lastErr = null;
    for (const p of targets) {
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.appendFileSync(p, line);
            ok = true;
        } catch (e) {
            lastErr = e;
        }
    }
    if (!ok) {
        // eslint-disable-next-line no-console
        console.error("[debugSessionLog] failed to append log", {
            sessionId: SESSION_ID,
            targets,
            errorCode: lastErr && lastErr.code,
            message: lastErr && lastErr.message
        });
    }
}

// #region agent log
appendDebug({
    runId: "startup",
    hypothesisId: "SYS",
    location: "backend/src/lib/debugSessionLog.js",
    message: "debugSessionLog loaded",
    data: { LOG_PATH }
});
// #endregion

module.exports = { appendDebug, LOG_PATH, SESSION_ID };
