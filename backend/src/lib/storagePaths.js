const path = require("path");

/**
 * 物理文件根目录（其下应有 uploads/，可选 mirror/）。
 * 设置 KB_STORAGE_ROOT=D:\kb_data 避免占用 C 盘；未设置时默认项目下 storage/。
 */
const getKbStorageRoot = () => {
    const raw = process.env.KB_STORAGE_ROOT;
    if (raw != null && String(raw).trim() !== "") {
        return path.resolve(String(raw).trim());
    }
    return path.resolve(__dirname, "..", "..", "..", "storage");
};

const getUploadsDir = () => path.join(getKbStorageRoot(), "uploads");

/** 上传子目录分段：本地日期 YYYY-MM-DD，与 storage_key 中 uploads 路径一致 */
const formatUploadsDateSegment = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
};

/** 由 folderSyncScheduler 在启动/保存配置时写入（库表 staging_path），优先于环境变量 */
let mirrorDirOverride = null;

const setMirrorDirOverride = (absPath) => {
    mirrorDirOverride =
        absPath != null && String(absPath).trim() !== "" ? path.resolve(String(absPath).trim()) : null;
};

const getMirrorDir = () => {
    if (mirrorDirOverride) return mirrorDirOverride;
    const raw = process.env.KB_SYNC_MIRROR_DIR;
    if (raw == null || String(raw).trim() === "") return null;
    return path.resolve(String(raw).trim());
};

/**
 * 将库中 storage_key（如 storage/uploads/uuid.md）解析为绝对路径。
 */
const resolveStorageKeyToAbsolute = (storageKey) => {
    if (!storageKey || typeof storageKey !== "string") return null;
    const parts = String(storageKey)
        .replace(/^[/\\]+/, "")
        .split(/[/\\]+/)
        .filter(Boolean);
    if (parts.length < 2 || parts[0].toLowerCase() !== "storage") return null;
    const rest = parts.slice(1);
    if (rest[0] && rest[0].toLowerCase() === "mirror") {
        const mirror = getMirrorDir();
        if (!mirror) return null;
        return path.join(mirror, ...rest.slice(1));
    }
    return path.join(getKbStorageRoot(), ...rest);
};

module.exports = {
    getKbStorageRoot,
    getUploadsDir,
    getMirrorDir,
    setMirrorDirOverride,
    resolveStorageKeyToAbsolute,
    formatUploadsDateSegment
};
