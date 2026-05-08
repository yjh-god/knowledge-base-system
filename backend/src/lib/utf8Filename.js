/**
 * multipart 里中文文件名常被 Multer 按单字节误读；若整串落在 Latin-1 范围内，可按 UTF-8 还原。
 */
const decodeMultipartFilename = (name) => {
    if (name == null || typeof name !== "string") return "upload";
    const s = name.trim();
    if (!s) return "upload";
    if (!/^[\x00-\xff]+$/.test(s)) return s.slice(0, 255);
    try {
        const decoded = Buffer.from(s, "latin1").toString("utf8").trim();
        if (!decoded || /\ufffd/.test(decoded)) return s.slice(0, 255);
        return decoded.slice(0, 255);
    } catch (_) {
        return s.slice(0, 255);
    }
};

module.exports = { decodeMultipartFilename };
