const { createServer } = require("./server");
const { appendDebug } = require("./lib/debugSessionLog");
const { setPhase } = require("./lib/ingestDebugState");
const { startIngestJobPoller, resetStaleIngestDebugByAge } = require("./worker/ingestJobPoller");
const { startDeleteJobPoller } = require("./worker/deleteJobPoller");
const { startKbSchedulers } = require("./scheduler");
const { syncEhrToSql } = require("./services/ehrSync");

const main = async () => {
    const port = process.env.PORT ? Number(process.env.PORT) : 3001;
    const server = await createServer();
    server.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.error("[backend] listen error", {
            port,
            code: err && err.code,
            errno: err && err.errno
        });
        // #region agent log
        appendDebug({
            runId: "listen-error",
            hypothesisId: "SYS",
            location: "backend/src/index.js:server-error",
            message: "API server listen error",
            data: { port, code: err && err.code, errno: err && err.errno, cwd: process.cwd() }
        });
        // #endregion
    });
    server.listen(port, () => {
        setPhase("idle", { lastError: null });
        // #region agent log
        appendDebug({
            runId: "listen",
            hypothesisId: "SYS",
            location: "backend/src/index.js:listen",
            message: "API server listening",
            data: { port, cwd: process.cwd(), pid: process.pid }
        });
        appendDebug({
            runId: "boot-ingest-reset",
            hypothesisId: "H_BOOT",
            location: "backend/src/index.js:listen",
            message: "ingestDebug cleared on listen (stale H_TICK / 旧进程残留)",
            data: { pid: process.pid, port }
        });
        // #endregion
        // eslint-disable-next-line no-console
        console.log(`Knowledge Base API listening on http://localhost:${port}`);
        // #region agent log
        void (async () => {
            const raw = process.env.QDRANT_URL || "http://127.0.0.1:6333";
            const base = String(raw).replace(/\/+$/, "");
            let dashStatus = null;
            let apiStatus = null;
            let dashErr = null;
            let apiErr = null;
            try {
                const r1 = await fetch(`${base}/dashboard`, { method: "GET" });
                dashStatus = r1.status;
            } catch (e) {
                dashErr = String((e && e.message) || e).slice(0, 200);
            }
            try {
                const r2 = await fetch(`${base}/collections`);
                apiStatus = r2.status;
            } catch (e) {
                apiErr = String((e && e.message) || e).slice(0, 200);
            }
            const data = {
                base,
                dashStatus,
                apiStatus,
                dashErr,
                apiErr,
                builtinUiLikely:
                    typeof dashStatus === "number" && dashStatus >= 200 && dashStatus < 400
            };
            appendDebug({
                runId: "qdrant-ui-probe",
                hypothesisId: "H_UI_STATIC",
                location: "backend/src/index.js:qdrantProbe",
                message: "Qdrant /dashboard and /collections probe after listen",
                data
            });
            if (dashStatus === 404 && apiStatus === 200) {
                // eslint-disable-next-line no-console
                console.log(
                    `[qdrant] 内置 Web UI 不可用（GET /dashboard → 404），API 正常。请在仓库根目录执行 npm run qdrant-ui，浏览器打开提示地址并填写 Qdrant：${base}`
                );
            }
        })();
        // #endregion
        if (process.env.DISABLE_INGEST_POLLER !== "1") {
            const ms = process.env.INGEST_POLLER_MS ? Number(process.env.INGEST_POLLER_MS) : 2000;
            startIngestJobPoller(Number.isFinite(ms) && ms >= 500 ? ms : 2000);
        }
        if (process.env.DISABLE_DELETE_POLLER !== "1") {
            const dms = process.env.DELETE_POLLER_MS ? Number(process.env.DELETE_POLLER_MS) : 3000;
            startDeleteJobPoller(Number.isFinite(dms) && dms >= 1000 ? dms : 3000);
        }
        startKbSchedulers();
        if (String(process.env.KB_ENSURE_PAYLOAD_INDEX_ON_BOOT || "1") === "1") {
            void (async () => {
                try {
                    const { ensureKbPayloadIndexes } = require("./lib/qdrantPayloadIndexes");
                    const r = await ensureKbPayloadIndexes();
                    // eslint-disable-next-line no-console
                    console.log("[qdrant] payload indexes:", JSON.stringify(r));
                } catch (e) {
                    // eslint-disable-next-line no-console
                    console.warn("[qdrant] payload index ensure skipped:", (e && e.message) || e);
                }
            })();
        }
        const sweepMs = process.env.INGEST_DEBUG_IDLE_SWEEP_MS
            ? Number(process.env.INGEST_DEBUG_IDLE_SWEEP_MS)
            : 60_000;
        if (Number.isFinite(sweepMs) && sweepMs >= 5000) {
            setInterval(() => {
                try {
                    resetStaleIngestDebugByAge();
                } catch (_) {
                    /* ignore */
                }
            }, sweepMs);
        }
        if (process.env.KB_ENABLE_RECONCILE === "1") {
            const { startReconcileMissingFilesPoller } = require("./worker/reconcileMissingFilesPoller");
            const rms = process.env.RECONCILE_POLLER_MS ? Number(process.env.RECONCILE_POLLER_MS) : 120000;
            startReconcileMissingFilesPoller(Number.isFinite(rms) && rms >= 10000 ? rms : 120000);
        }
        void (async () => {
            const { reloadFolderSyncScheduler } = require("./scheduler/folderSyncScheduler");
            try {
                await reloadFolderSyncScheduler();
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error("[folder-sync-scheduler] 初始化失败", e);
            }
            try {
                const { reloadMirrorScanPollerFromSettings } = require("./worker/mirrorScanPoller");
                await reloadMirrorScanPollerFromSettings();
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error("[mirror-scan] 初始化失败", e);
            }
        })();
        if (process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.log("[dev] CORS：非生产环境下对所有浏览器 Origin 回显允许（credentials）。生产环境请设置 NODE_ENV=production 并配置 CORS_ORIGIN。");
        }

        if (process.env.EHR_AUTO_SYNC_ON_START === "1") {
            const src = process.env.EHR_SYNC_SOURCE || "mock";
            void syncEhrToSql({ source: src }).then(
                () => {
                    // eslint-disable-next-line no-console
                    console.log(`[ehr] 启动时同步完成 source=${src}`);
                },
                (err) => {
                    // eslint-disable-next-line no-console
                    console.error("[ehr] 启动时同步失败:", err && err.message ? err.message : err);
                }
            );
        }
    });
};

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Fatal startup error:", err);
    process.exit(1);
});
