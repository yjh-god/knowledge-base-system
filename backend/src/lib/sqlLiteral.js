const sqlIntOrNull = (n) => (Number.isFinite(n) ? String(Math.trunc(n)) : "NULL");

const sqlNVarCharOrNull = (s) => {
    if (s == null || String(s).trim() === "") return "NULL";
    return `N'${String(s).replace(/'/g, "''")}'`;
};

module.exports = { sqlIntOrNull, sqlNVarCharOrNull };
