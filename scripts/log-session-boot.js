/**
 * npm lifecycle：backend/frontend 的 predev。任何 `npm run dev --prefix *` 都会先写一行 NDJSON，
 * 避免只靠根目录 dev.js 时漏日志。
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const label = process.argv[2] || "predev";
const line = `${JSON.stringify({
    sessionId: "840c9e",
    timestamp: Date.now(),
    runId: "npm-predev",
    hypothesisId: "SYS",
    location: "scripts/log-session-boot.js",
    message: label,
    data: { root, cwd: process.cwd(), argv: process.argv.slice(2) }
})}\n`;

for (const p of [path.join(root, "debug-840c9e.log"), path.join(root, ".cursor", "debug-840c9e.log")]) {
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, line);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[log-session-boot] write failed", p, e && e.message);
    }
}

// eslint-disable-next-line no-console
console.error("[log-session-boot] predev executed", label, { root, cwd: process.cwd() });
