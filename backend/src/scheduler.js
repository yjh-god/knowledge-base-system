const cron = require("node-cron");
const { runNightReconcileOnce } = require("./worker/nightBatch");
const { syncEhrToSql } = require("./services/ehrSync");

/**
 * PRD §5.5 / §6：夜间向量对账 + 默认可选 EHR 定时同步（与手动 /admin/ehr-sync 并存）。
 * Cron 表达式为 node-cron 格式；时区可通过 KB_CRON_TZ（如 Asia/Shanghai）指定。
 */
const startKbSchedulers = () => {
    if (String(process.env.KB_DISABLE_SCHEDULER || "") === "1") {
        // eslint-disable-next-line no-console
        console.log("[scheduler] 已禁用（KB_DISABLE_SCHEDULER=1）");
        return;
    }

    const tz = (process.env.KB_CRON_TZ || "").trim() || undefined;
    const opts = tz ? { timezone: tz } : {};

    if (String(process.env.KB_DISABLE_NIGHT_BATCH || "") !== "1") {
        const expr = (process.env.KB_NIGHT_BATCH_CRON || "0 1 * * *").trim();
        if (cron.validate(expr)) {
            cron.schedule(
                expr,
                () => {
                    void runNightReconcileOnce().catch((e) => {
                        // eslint-disable-next-line no-console
                        console.error("[night-batch]", e && e.message ? e.message : e);
                    });
                },
                opts
            );
            // eslint-disable-next-line no-console
            console.log("[scheduler] 夜间向量对账", expr, tz || "本机时区");
        } else {
            // eslint-disable-next-line no-console
            console.warn("[scheduler] KB_NIGHT_BATCH_CRON 非法，已跳过夜间任务:", expr);
        }
    }

    if (String(process.env.KB_DISABLE_EHR_CRON || "") !== "1") {
        const expr = (process.env.KB_EHR_CRON || "0 2 * * *").trim();
        if (cron.validate(expr)) {
            cron.schedule(
                expr,
                () => {
                    const src = process.env.EHR_SYNC_SOURCE || "mock";
                    void syncEhrToSql({ source: src }).then(
                        () => {
                            // eslint-disable-next-line no-console
                            console.log(`[ehr-cron] 同步完成 source=${src}`);
                        },
                        (e) => {
                            // eslint-disable-next-line no-console
                            console.error("[ehr-cron]", e && e.message ? e.message : e);
                        }
                    );
                },
                opts
            );
            // eslint-disable-next-line no-console
            console.log("[scheduler] EHR 同步", expr, tz || "本机时区");
        } else {
            // eslint-disable-next-line no-console
            console.warn("[scheduler] KB_EHR_CRON 非法，已跳过 EHR 定时任务:", expr);
        }
    }
};

module.exports = { startKbSchedulers };
