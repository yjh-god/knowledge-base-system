/**
 * 将用户提供的文件名规范为可安全写入 uploads 临时目录的单层 basename（无路径穿越、无非法字符）。
 */

const path = require("path");

const WIN_RESERVED = new Set(
    [
        "CON",
        "PRN",
        "AUX",
        "NUL",
        "COM1",
        "COM2",
        "COM3",
        "COM4",
        "COM5",
        "COM6",
        "COM7",
        "COM8",
        "COM9",
        "LPT1",
        "LPT2",
        "LPT3",
        "LPT4",
        "LPT5",
        "LPT6",
        "LPT7",
        "LPT8",
        "LPT9"
    ]
);

const MAX_BYTES = 220;

/**
 * @param {unknown} raw
 * @returns {string}
 */
const sanitizeStorageBasename = (raw) => {
    if (raw == null) return "file";
    let s = String(raw).trim();
    if (!s) return "file";

    let b = path.basename(s.replace(/\\/g, "/"));
    if (b === "." || b === "..") return "file";

    b = b.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").trim();
    if (!b) return "file";

    if (b.length > MAX_BYTES) {
        const ext = path.extname(b);
        const safeExt = ext && ext.length <= 32 ? ext.replace(/[^\w.-]/g, "") : "";
        const base = path.basename(b, ext);
        const cap = Math.max(1, MAX_BYTES - safeExt.length);
        b = (base.slice(0, cap) || "file") + safeExt;
    }

    const ext = path.extname(b);
    const stem = path.basename(b, ext);
    const stemUp = stem.toUpperCase();
    if (stem && WIN_RESERVED.has(stemUp)) {
        b = `_${b}`;
    }

    return b || "file";
};

module.exports = { sanitizeStorageBasename };
