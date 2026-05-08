/**
 * PRD §5.1.1：命中片段定位摘要（路径列仍单独展示完整 file_path）。
 */
export function formatHitLocation(row) {
    if (!row || typeof row !== "object") return "—";
    const parts = [];

    if (row.section_heading) {
        parts.push(String(row.section_heading));
    }

    if (row.sheet_name) {
        parts.push(`Sheet「${row.sheet_name}」`);
        if (row.row_start != null && row.row_end != null) {
            parts.push(`行 ${row.row_start}–${row.row_end}`);
        }
    } else if (row.row_start != null && row.row_end != null) {
        parts.push(`行 ${row.row_start}–${row.row_end}`);
    }

    if (row.slide_index != null && row.slide_index !== "") {
        parts.push(`幻灯片 ${row.slide_index}`);
    }

    if (row.page_start != null || row.page_end != null) {
        const ps = row.page_start ?? row.page_end;
        const pe = row.page_end ?? row.page_start;
        parts.push(ps === pe ? `第 ${ps} 页` : `第 ${ps}–${pe} 页`);
    }

    if (row.char_start != null && row.char_end != null && parts.length === 0) {
        parts.push(`字符 ${row.char_start}–${row.char_end}`);
    }

    if (parts.length === 0 && row.chunk_index != null && row.chunk_index !== "") {
        parts.push(`块 #${row.chunk_index}`);
    }

    return parts.length ? parts.join(" · ") : "—";
}

/** 复制用：优先逻辑/存储路径 */
export function hitCopyPath(row) {
    if (!row || typeof row !== "object") return "";
    const p = row.file_path != null ? String(row.file_path).trim() : "";
    if (p) return p;
    const n = row.file_name != null ? String(row.file_name).trim() : "";
    return n;
}
