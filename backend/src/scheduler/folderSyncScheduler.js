const cron = require("node-cron");
const { runFolderSyncPipeline } = require("../services/folderSyncService");
const { loadKbSyncSettings } = require("../lib/kbSyncSettings");

let tasks = [];

const stopAll = () => {
    for (const t of tasks) {
        try {
            t.stop();
        } catch {
            /* ignore */
        }
    }
    tasks = [];
};

const reloadFolderSyncScheduler = async () => {
    stopAll();
    let s;
    try {
        s = await loadKbSyncSettings();
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
            "[folder-sync-scheduler] 读取配置失败（若未执行 sql/012_kb_sync_settings.sql 请先迁移）:",
            (e && e.message) || e
        );
        const { setMirrorDirOverride } = require("../lib/storagePaths");
        setMirrorDirOverride(null);
        return;
    }

    const { setMirrorDirOverride } = require("../lib/storagePaths");
    setMirrorDirOverride((s.stagingPath || "").trim() || null);

    if (String(process.env.KB_DISABLE_FOLDER_SYNC_CRON || "") === "1") {
        // eslint-disable-next-line no-console
        console.log("[folder-sync-scheduler] 已禁用（KB_DISABLE_FOLDER_SYNC_CRON=1）");
        return;
    }

    if (!s.autoSyncEnabled) {
        // eslint-disable-next-line no-console
        console.log("[folder-sync-scheduler] 自动同步未开启");
        return;
    }

    const tz = (process.env.KB_CRON_TZ || "").trim() || undefined;
    const opts = tz ? { timezone: tz } : {};
    const exprs = [s.cronExpr1, s.cronExpr2].filter((x) => x && String(x).trim());

    for (const expr of exprs) {
        if (!cron.validate(expr)) {
            // eslint-disable-next-line no-console
            console.warn("[folder-sync-scheduler] 非法 cron，已跳过:", expr);
            continue;
        }
        const task = cron.schedule(
            expr,
            () => {
                void runFolderSyncPipeline({ trigger: "cron", force: false }).then(
                    (r) => {
                        // eslint-disable-next-line no-console
                        console.log("[folder-sync-cron]", expr, r && r.ok, r && r.skipped, r && r.msg);
                    },
                    (e) => {
                        // eslint-disable-next-line no-console
                        console.error("[folder-sync-cron]", expr, e);
                    }
                );
            },
            opts
        );
        tasks.push(task);
    }
    // eslint-disable-next-line no-console
    console.log("[folder-sync-scheduler] 已注册", exprs.length, "条定时任务", tz || "本机时区");
};

module.exports = { reloadFolderSyncScheduler };
