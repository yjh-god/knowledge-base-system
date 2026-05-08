/** MIME → 简短类型名（表格展示） */
export const formatMimeShort = (mime) => {
    if (mime == null || mime === "") return "—";
    const m = String(mime).toLowerCase().trim();
    const map = {
        "text/plain": "TXT",
        "text/markdown": "MD",
        "text/html": "HTML",
        "application/pdf": "PDF",
        "application/json": "JSON",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
        "application/vnd.ms-excel": "XLS",
        "application/vnd.ms-excel.sheet.macroenabled.12": "XLSM",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
        "application/msword": "DOC",
        "application/vnd.ms-powerpoint": "PPT",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
        "image/png": "PNG",
        "application/octet-stream": "二进制"
    };
    if (map[m]) return map[m];
    const slash = m.indexOf("/");
    if (slash > 0) {
        const sub = m.slice(slash + 1);
        if (sub.includes("json")) return "JSON";
        if (sub.includes("xml")) return "XML";
        if (sub.includes("zip")) return "ZIP";
        return sub.length > 14 ? `${sub.slice(0, 12)}…` : sub;
    }
    return m.length > 16 ? `${m.slice(0, 14)}…` : m;
};

/** 字节 → 带单位 */
export const formatFileSize = (bytes) => {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n === 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) {
        const kb = n / 1024;
        return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    }
    if (n < 1024 * 1024 * 1024) {
        const mb = n / (1024 * 1024);
        return `${mb < 10 ? mb.toFixed(2) : mb.toFixed(1)} MB`;
    }
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/** 文档状态 */
export const formatDocStatus = (s) => {
    const map = {
        draft: "草稿",
        pending_index: "待索引",
        indexed: "已索引",
        failed: "失败",
        disabled: "已停用",
        deleted: "已删除"
    };
    return map[s] || s || "—";
};

/** 索引任务类型 */
export const formatJobType = (t) => {
    const map = {
        immediate_upload: "即时上传",
        manual_reindex: "手动重建",
        scheduled_batch: "定时批次",
        delete_vectors: "删除向量",
        nightly_reconcile_delete: "夜间对账删除"
    };
    return map[t] || t || "—";
};

/** 任务状态 */
export const formatJobStatus = (s) => {
    const map = {
        queued: "排队中",
        running: "执行中",
        success: "成功",
        failed: "失败",
        cancelled: "已取消"
    };
    return map[s] || s || "—";
};

/** 审计日志 action → 简短中文（未知则原样返回） */
export const formatAuditAction = (a) => {
    const map = {
        "auth.login": "登录",
        "auth.password_change": "修改密码",
        "search.query": "检索",
        "search.audit_query": "审计检索",
        "search.rag_synthesize": "RAG 生成",
        "doc.upload": "文档上传",
        "doc.delete": "文档删除",
        "doc.reindex": "文档重新入库",
        "admin.user_password_reset": "管理员重置密码",
        "admin.ehr_sync_trigger": "EHR 同步触发"
    };
    const k = String(a || "").trim();
    return map[k] || k || "—";
};

/**
 * 入库耗时（毫秒）：来自最近一次成功的 immediate_upload 任务 finished−started。
 */
export const formatIngestDuration = (ms) => {
    if (ms == null || ms === "") return "—";
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 1000) return `${Math.round(n)} ms`;
    if (n < 60_000) {
        const s = n / 1000;
        return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
    }
    const m = Math.floor(n / 60_000);
    const sec = Math.round((n % 60_000) / 1000);
    return sec > 0 ? `${m} 分 ${sec} 秒` : `${m} 分`;
};

/** UUID 缩略显示（完整值放 tooltip） */
export const shortUuid = (id) => {
    if (id == null || id === "") return "—";
    const s = String(id).trim();
    if (s.length <= 12) return s;
    return `${s.slice(0, 8)}…`;
};
