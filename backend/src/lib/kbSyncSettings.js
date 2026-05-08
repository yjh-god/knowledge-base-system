const path = require("path");
const { runQuery, runQueryTsv } = require("./sqlcmd");
const { escapeSql } = require("./auditLog");

const DEFAULT_CRON_1 = "0 1 * * *";
const DEFAULT_CRON_2 = "0 13 * * *";

const defaultSettings = () => ({
    sharePath: "",
    stagingPath: "",
    autoSyncEnabled: false,
    processNames: "AnyShare.exe",
    wecomWebhookUrl: "",
    cronExpr1: DEFAULT_CRON_1,
    cronExpr2: DEFAULT_CRON_2,
    skipIfSyncedToday: true,
    /** 镜像目录后台轮询（与定时全量同步不同：小步、高频） */
    mirrorPollEnabled: true,
    mirrorPollIntervalMs: 60_000,
    mirrorPollMaxFiles: 80,
    lastSuccessDate: "",
    lastSuccessAt: "",
    lastRunAt: "",
    lastRunStatus: "",
    lastRunMessage: ""
});

const parseRow = (cols) => {
    if (!cols || cols.length < 13) return null;
    const [
        sharePath,
        stagingPath,
        autoSyncEnabled,
        processNames,
        wecomWebhookUrl,
        cronExpr1,
        cronExpr2,
        skipIfSyncedToday,
        lastSuccessDate,
        lastSuccessAt,
        lastRunAt,
        lastRunStatus,
        lastRunMessage,
        mirrorPollEnabledRaw,
        mirrorPollIntervalRaw,
        mirrorPollMaxFilesRaw
    ] = cols;
    const d = defaultSettings();
    const intervalMs = Number(mirrorPollIntervalRaw);
    const maxFiles = Number(mirrorPollMaxFilesRaw);
    return {
        sharePath: sharePath || "",
        stagingPath: stagingPath || "",
        autoSyncEnabled: String(autoSyncEnabled) === "1",
        processNames: processNames || "",
        wecomWebhookUrl: wecomWebhookUrl || "",
        cronExpr1: cronExpr1 != null ? String(cronExpr1).trim() : "",
        cronExpr2: cronExpr2 != null ? String(cronExpr2).trim() : "",
        skipIfSyncedToday: String(skipIfSyncedToday) !== "0",
        mirrorPollEnabled:
            cols.length > 13 ? String(mirrorPollEnabledRaw) === "1" : d.mirrorPollEnabled,
        mirrorPollIntervalMs:
            cols.length > 14 && Number.isFinite(intervalMs) && intervalMs > 0
                ? intervalMs
                : d.mirrorPollIntervalMs,
        mirrorPollMaxFiles:
            cols.length > 15 && Number.isFinite(maxFiles) && maxFiles > 0
                ? maxFiles
                : d.mirrorPollMaxFiles,
        lastSuccessDate: lastSuccessDate || "",
        lastSuccessAt: lastSuccessAt || "",
        lastRunAt: lastRunAt || "",
        lastRunStatus: lastRunStatus || "",
        lastRunMessage: lastRunMessage || ""
    };
};

let cache = { at: 0, settings: null };
const CACHE_MS = 5000;

/** 未执行 sql/014_kb_sync_mirror_poll.sql 时 SELECT/UPDATE 会报列不存在 */
const isMirrorPollColumnMissingError = (e) =>
    /mirror_poll_|Invalid column name|列名.*无效|\b207\b.*列名/i.test(String((e && e.message) || e));

const SQL_LOAD_KB_SYNC_LEGACY = `
        SELECT TOP (1)
            ISNULL(share_path, N''),
            ISNULL(staging_path, N''),
            CASE WHEN auto_sync_enabled = 1 THEN N'1' ELSE N'0' END,
            ISNULL(process_names, N''),
            ISNULL(wecom_webhook_url, N''),
            ISNULL(cron_expr_1, N''),
            ISNULL(cron_expr_2, N''),
            CASE WHEN skip_if_synced_today = 1 THEN N'1' ELSE N'0' END,
            ISNULL(CONVERT(VARCHAR(10), last_success_date, 23), N''),
            ISNULL(CONVERT(VARCHAR(33), last_success_at, 127), N''),
            ISNULL(CONVERT(VARCHAR(33), last_run_at, 127), N''),
            ISNULL(last_run_status, N''),
            ISNULL(last_run_message, N'')
        FROM dbo.kb_sync_settings
        WHERE id = 1;
        `;

const SQL_LOAD_KB_SYNC_FULL = `
        SELECT TOP (1)
            ISNULL(share_path, N''),
            ISNULL(staging_path, N''),
            CASE WHEN auto_sync_enabled = 1 THEN N'1' ELSE N'0' END,
            ISNULL(process_names, N''),
            ISNULL(wecom_webhook_url, N''),
            ISNULL(cron_expr_1, N''),
            ISNULL(cron_expr_2, N''),
            CASE WHEN skip_if_synced_today = 1 THEN N'1' ELSE N'0' END,
            ISNULL(CONVERT(VARCHAR(10), last_success_date, 23), N''),
            ISNULL(CONVERT(VARCHAR(33), last_success_at, 127), N''),
            ISNULL(CONVERT(VARCHAR(33), last_run_at, 127), N''),
            ISNULL(last_run_status, N''),
            ISNULL(last_run_message, N''),
            CASE WHEN mirror_poll_enabled = 1 THEN N'1' ELSE N'0' END,
            ISNULL(CAST(mirror_poll_interval_ms AS VARCHAR(20)), N'60000'),
            ISNULL(CAST(mirror_poll_max_files AS VARCHAR(20)), N'80')
        FROM dbo.kb_sync_settings
        WHERE id = 1;
        `;

const loadKbSyncSettings = async () => {
    const now = Date.now();
    if (cache.settings && now - cache.at < CACHE_MS) return cache.settings;

    let rows;
    try {
        rows = await runQueryTsv(SQL_LOAD_KB_SYNC_FULL, { variableLengthY: 8000 });
    } catch (e) {
        if (!isMirrorPollColumnMissingError(e)) throw e;
        rows = await runQueryTsv(SQL_LOAD_KB_SYNC_LEGACY, { variableLengthY: 8000 });
    }

    const parsed = rows.length ? parseRow(rows[0]) : defaultSettings();
    cache = { at: now, settings: parsed };
    return parsed;
};

const invalidateKbSyncSettingsCache = () => {
    cache = { at: 0, settings: null };
};

const saveKbSyncSettings = async (body) => {
    const sharePath = String(body?.sharePath ?? "").trim();
    const stagingPath = String(body?.stagingPath ?? "").trim();
    const autoSyncEnabled = Boolean(body?.autoSyncEnabled);
    const processNames = String(body?.processNames ?? "").trim();
    const wecomWebhookUrl = String(body?.wecomWebhookUrl ?? "").trim();
    const cronExpr1 = String(body?.cronExpr1 ?? "").trim();
    const cronExpr2 = String(body?.cronExpr2 ?? "").trim();
    const skipIfSyncedToday = body?.skipIfSyncedToday !== false;
    const mirrorPollEnabled = body?.mirrorPollEnabled !== false;
    const mirrorPollIntervalMs = Math.max(
        10_000,
        Math.min(3_600_000, Math.floor(Number(body?.mirrorPollIntervalMs) || 60_000))
    );
    const mirrorPollMaxFiles = Math.max(
        1,
        Math.min(500, Math.floor(Number(body?.mirrorPollMaxFiles) || 80))
    );

    const sqlLegacy = `
        UPDATE dbo.kb_sync_settings
        SET
            share_path = N'${escapeSql(sharePath)}',
            staging_path = N'${escapeSql(stagingPath)}',
            auto_sync_enabled = ${autoSyncEnabled ? 1 : 0},
            process_names = N'${escapeSql(processNames)}',
            wecom_webhook_url = N'${escapeSql(wecomWebhookUrl)}',
            cron_expr_1 = N'${escapeSql(cronExpr1)}',
            cron_expr_2 = N'${escapeSql(cronExpr2)}',
            skip_if_synced_today = ${skipIfSyncedToday ? 1 : 0},
            updated_at = SYSDATETIMEOFFSET()
        WHERE id = 1;
    `;
    const sqlFull = `
        UPDATE dbo.kb_sync_settings
        SET
            share_path = N'${escapeSql(sharePath)}',
            staging_path = N'${escapeSql(stagingPath)}',
            auto_sync_enabled = ${autoSyncEnabled ? 1 : 0},
            process_names = N'${escapeSql(processNames)}',
            wecom_webhook_url = N'${escapeSql(wecomWebhookUrl)}',
            cron_expr_1 = N'${escapeSql(cronExpr1)}',
            cron_expr_2 = N'${escapeSql(cronExpr2)}',
            skip_if_synced_today = ${skipIfSyncedToday ? 1 : 0},
            mirror_poll_enabled = ${mirrorPollEnabled ? 1 : 0},
            mirror_poll_interval_ms = ${mirrorPollIntervalMs},
            mirror_poll_max_files = ${mirrorPollMaxFiles},
            updated_at = SYSDATETIMEOFFSET()
        WHERE id = 1;
    `;
    try {
        await runQuery(sqlFull);
    } catch (e) {
        if (!isMirrorPollColumnMissingError(e)) throw e;
        // eslint-disable-next-line no-console
        console.warn(
            "[kb-sync-settings] 未检测到 mirror_poll_* 列，已按旧库结构保存（请执行 backend/sql/014_kb_sync_mirror_poll.sql）"
        );
        await runQuery(sqlLegacy);
    }
    invalidateKbSyncSettingsCache();
};

const recordFolderSyncRun = async (status, message) => {
    const msg = String(message ?? "").slice(0, 2000);
    await runQuery(`
        UPDATE dbo.kb_sync_settings
        SET
            last_run_at = SYSDATETIMEOFFSET(),
            last_run_status = N'${escapeSql(String(status))}',
            last_run_message = N'${escapeSql(msg)}',
            updated_at = SYSDATETIMEOFFSET()
        WHERE id = 1;
    `);
    invalidateKbSyncSettingsCache();
};

const recordFolderSyncSuccess = async (message) => {
    const msg = String(message ?? "").slice(0, 2000);
    await runQuery(`
        UPDATE dbo.kb_sync_settings
        SET
            last_run_at = SYSDATETIMEOFFSET(),
            last_success_at = SYSDATETIMEOFFSET(),
            last_success_date = CONVERT(DATE, SYSDATETIMEOFFSET()),
            last_run_status = N'success',
            last_run_message = N'${escapeSql(msg)}',
            updated_at = SYSDATETIMEOFFSET()
        WHERE id = 1;
    `);
    invalidateKbSyncSettingsCache();
};

/** 镜像扫描根：库中 staging_path（界面「目标目录」）优先，否则环境变量 KB_SYNC_MIRROR_DIR */
const getEffectiveMirrorRootSync = (settings) => {
    const fromDb = settings?.stagingPath && String(settings.stagingPath).trim();
    if (fromDb) return path.resolve(fromDb);
    const raw = process.env.KB_SYNC_MIRROR_DIR;
    if (raw != null && String(raw).trim() !== "") return path.resolve(String(raw).trim());
    return null;
};

const getEffectiveMirrorRoot = async () => {
    const s = await loadKbSyncSettings();
    return getEffectiveMirrorRootSync(s);
};

module.exports = {
    loadKbSyncSettings,
    saveKbSyncSettings,
    recordFolderSyncRun,
    recordFolderSyncSuccess,
    invalidateKbSyncSettingsCache,
    getEffectiveMirrorRoot,
    getEffectiveMirrorRootSync,
    defaultSettings,
    DEFAULT_CRON_1,
    DEFAULT_CRON_2
};
