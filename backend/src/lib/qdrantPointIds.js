const crypto = require("crypto");

/**
 * Qdrant 点 id 仅支持 uint 或标准 UUID，不能使用 "uuid:chunkIndex"。
 * 由 docId + chunkIndex 确定性生成 UUID，便于同一块重复 upsert 覆盖。
 */
const chunkPointUuid = (docId, chunkIndex) => {
    const h = crypto.createHash("sha256").update(`${docId}\0${chunkIndex}`, "utf8").digest();
    const b = Buffer.allocUnsafe(16);
    h.copy(b, 0, 0, 16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = b.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

module.exports = { chunkPointUuid };
