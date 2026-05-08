const fs = require("fs");
const { execFileSync } = require("child_process");

const {
    loadKbSyncSettings,
    recordFolderSyncRun,
    recordFolderSyncSuccess,
    getEffectiveMirrorRootSync
} = require("../lib/kbSyncSettings");
const { insertFolderSyncRun } = require("../lib/kbFolderSyncRuns");
const { mirrorScanFullPass } = require("../worker/mirrorScanPoller");

const parseProcessNames = (raw) => {
    if (raw == null || String(raw).trim() === "") return [];
    return String(raw)
        .split(/[,;|\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
};

const checkProcessTokensDetail = async (tokens) => {
    if (!tokens.length) return { anyRunning: true, lines: [] };
    if (process.platform !== "win32") {
        return { anyRunning: true, lines: [{ token: tokens.join(","), note: "非 Windows 跳过进程检测" }] };
    }
    let out = "";
    try {
        out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    } catch {
        return { anyRunning: false, lines: [{ error: "tasklist 失败" }] };
    }
    const lower = out.toLowerCase();
    const lines = tokens.map((t) => ({ token: t, running: lower.includes(t) }));
    const anyRunning = lines.some((l) => l.running);
    return { anyRunning, lines };
};

const isLikelyWecomWebhookUrl = (u) => {
    const s = String(u || "").trim();
    if (!/^https:\/\//i.test(s)) return false;
    return s.includes("weixin.qq.com");
};

const resolveWecomUrl = (s) => {
    const a = String(s?.wecomWebhookUrl ?? "").trim();
    if (a) return a;
    return String(process.env.KB_FOLDER_SYNC_WECOM_WEBHOOK || process.env.WECOM_WEBHOOK_URL || "").trim();
};

const postWecomTextWithResult = async (url, text) => {
    try {
        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msgtype: "text", text: { content: String(text || "").slice(0, 4000) } })
        });
        const textBody = await r.text();
        let j = null;
        try {
            j = JSON.parse(textBody);
        } catch {
            /* ignore */
        }
        const ok = r.ok && j && Number(j.errcode) === 0;
        return { ok, httpStatus: r.status, errcode: j?.errcode, errmsg: j?.errmsg, raw: textBody.slice(0, 300) };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
};

const todayStr = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
};

/**
 * 镜像同步：直接扫描配置的本地目录入库，不经过中转复制。
 * @param {{ trigger?: string, force?: boolean }} opts
 */
const runFolderSyncPipeline = async ({ trigger = "manual", force = false } = {}) => {
    const startedAt = new Date();
    const settings = await loadKbSyncSettings();
    const mirrorRoot = getEffectiveMirrorRootSync(settings);

    const finishFail = async (msg) => {
        await recordFolderSyncRun("error", msg);
        await insertFolderSyncRun({
            triggerType: trigger,
            status: "error",
            startedAt,
            finishedAt: new Date(),
            durationMs: Date.now() - startedAt.getTime(),
            summary: msg,
            fileErrors: 1
        });
        return { ok: false, msg };
    };

    if (!mirrorRoot) {
        return finishFail("未配置镜像目录（同步配置「目标目录」或环境变量 KB_SYNC_MIRROR_DIR）");
    }
    if (!fs.existsSync(mirrorRoot)) {
        return finishFail(`镜像目录不存在: ${mirrorRoot}`);
    }

    const tokens = parseProcessNames(settings.processNames);
    const proc = await checkProcessTokensDetail(tokens);
    if (tokens.length && !proc.anyRunning) {
        const msg = "配置要求检测的进程均未运行，已跳过本次同步";
        if (trigger === "cron" && !force) {
            await recordFolderSyncRun("skipped", msg);
            return { ok: true, skipped: true, offline: true, msg };
        }
    }

    if (trigger === "cron" && settings.skipIfSyncedToday && !force) {
        const ld = String(settings.lastSuccessDate || "").slice(0, 10);
        if (ld && ld === todayStr()) {
            const msg = "当天已成功同步，按配置跳过";
            await recordFolderSyncRun("skipped", msg);
            return { ok: true, skipped: true, msg };
        }
    }

    let stats;
    try {
        stats = await mirrorScanFullPass(mirrorRoot);
    } catch (e) {
        return finishFail((e && e.message) || String(e));
    }

    const durationMs = Date.now() - startedAt.getTime();
    const copied = stats.newDocs + stats.updatedDocs;
    const docsPurged = Number(stats.docsPurged) || 0;
    const skippedNoResult = Number(stats.skippedNoResult) || 0;
    const summary = `files=${stats.filesTotal}, copied=${copied}, skipped_md5=${stats.unchanged}, new=${stats.newDocs}, updated=${stats.updatedDocs}, purged=${docsPurged}, skipped_no_result=${skippedNoResult}, file_errors=${stats.fileErrors}`;
    await recordFolderSyncSuccess(summary);
    await insertFolderSyncRun({
        triggerType: trigger,
        status: stats.fileErrors > 0 ? "success_with_errors" : "success",
        startedAt,
        finishedAt: new Date(),
        durationMs,
        filesOnShare: stats.filesTotal,
        copied: stats.newDocs + stats.updatedDocs,
        skippedMd5: stats.unchanged,
        removedStaging: 0,
        docsPurged,
        fileErrors: stats.fileErrors,
        summary
    });

    const wecomUrl = resolveWecomUrl(settings);
    if (wecomUrl && isLikelyWecomWebhookUrl(wecomUrl)) {
        const title = trigger === "cron" ? "定时" : "手动";
        const lines = [
            `[知识库-镜像同步] ${title}完成`,
            `目录: ${mirrorRoot}`,
            summary,
            `耗时: ${durationMs}ms`
        ];
        void postWecomTextWithResult(wecomUrl, lines.join("\n"));
    }

    return { ok: true, stats, summary };
};

module.exports = {
    runFolderSyncPipeline,
    parseProcessNames,
    checkProcessTokensDetail,
    resolveWecomUrl,
    postWecomTextWithResult,
    isLikelyWecomWebhookUrl
};
