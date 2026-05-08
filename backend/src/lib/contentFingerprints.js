const crypto = require("crypto");

const md5Hex = (buf) => crypto.createHash("md5").update(buf).digest("hex");

const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

module.exports = { md5Hex, sha256Hex };
