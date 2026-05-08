/** node-cron 每日一次：将 "HH:mm" 转为 "m h * * *" */
export const hhmmToCronDaily = (hhmm) => {
    if (!hhmm || typeof hhmm !== "string") return "";
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return "";
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return "";
    return `${min} ${h} * * *`;
};

/** 将 "m h * * *" 转为 "HH:mm"；无法解析则返回 "" */
export const cronDailyToHHmm = (cronExpr) => {
    if (!cronExpr || typeof cronExpr !== "string") return "";
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) return "";
    const min = parts[0];
    const h = parts[1];
    if (parts[2] !== "*" || parts[3] !== "*" || parts[4] !== "*") return "";
    const mi = Number(min);
    const hi = Number(h);
    if (!Number.isFinite(mi) || !Number.isFinite(hi)) return "";
    return `${String(hi).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
};
