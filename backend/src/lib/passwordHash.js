const crypto = require("crypto");

// Simple dev-grade password hashing (PRD requires "hashed", algorithm is not strictly specified).
// We avoid extra dependencies like bcrypt to keep the project lightweight.
const hashPassword = async (password, { iterations = 100000, saltBytes = 16 } = {}) => {
    const salt = crypto.randomBytes(saltBytes).toString("hex");
    const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
    return `pbkdf2-sha256$${iterations}$${salt}$${hash}`;
};

const verifyPassword = (password, stored) => {
    if (!stored || typeof stored !== "string") return false;
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const [, iterStr, salt, expectedHash] = parts;
    const iterations = Number(iterStr);
    if (!Number.isFinite(iterations)) return false;
    const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
    return hash === expectedHash;
};

module.exports = { hashPassword, verifyPassword };

