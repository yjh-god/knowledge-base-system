const crypto = require("crypto");
const { runQuery, runEhrQueryTsv } = require("../lib/sqlcmd");
const { hashPassword } = require("../lib/passwordHash");
const { ehrMockSnapshot } = require("./ehrMock");

const escapeSqlString = (v) => String(v).replace(/'/g, "''");

const uuidFromString = (input) => {
    const hash = crypto.createHash("sha256").update(String(input)).digest();
    const bytes = Array.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map((b) => b.toString(16).padStart(2, "0"));
    return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
};

const trim = (v) => (v == null ? "" : String(v).trim());

const pathDisplayForParts = (parts) => parts.filter(Boolean).join(" / ");

const stableEhrDeptId = (pathDisplay) =>
    `ehrpath:${crypto.createHash("sha256").update(pathDisplay).digest("hex").slice(0, 40)}`;

/** 仅允许类似 dbo.Table / dbo.[Name] / schema.view，防注入 */
/** 仅允许单段标识符作列名（可带 []) */
const assertSafeSqlIdentifier = (name, label) => {
    const s = String(name || "").trim();
    if (!s || s.length > 128 || !/^[\w\[\]\u4e00-\u9fff]+$/.test(s)) {
        throw new Error(`${label} 非法：${name}`);
    }
    return s;
};

const assertSafeEhrFrom = (from) => {
    const s = String(from || "").trim();
    if (!s) {
        throw new Error("缺少环境变量 EHR_SYNC_FROM（例：dbo.vw_Employee）");
    }
    if (s.length > 256 || /[\r\n;]/.test(s) || /--/.test(s)) {
        throw new Error("EHR_SYNC_FROM 格式非法");
    }
    if (!/^[\w\.\[\]\u4e00-\u9fff]+$/.test(s)) {
        throw new Error("EHR_SYNC_FROM 仅允许字母数字下划线点方括号及中文");
    }
    return s;
};

/**
 * 从 EHR 行（empcode, empname, deptname1..5）推导部门树节点
 * @returns {Map<string, { ehr_dept_id, parent_ehr_dept_id, depth, name, path_display }>}
 */
const collectDepartmentNodesFromRows = (rows) => {
    const byPath = new Map();

    for (const row of rows) {
        const parts = [row.d1, row.d2, row.d3, row.d4, row.d5].map(trim).filter(Boolean);
        for (let i = 0; i < parts.length; i += 1) {
            const sub = parts.slice(0, i + 1);
            const pathDisplay = pathDisplayForParts(sub);
            if (byPath.has(pathDisplay)) continue;
            const name = sub[sub.length - 1];
            const parentPath = i === 0 ? null : pathDisplayForParts(sub.slice(0, i));
            const ehrDeptId = stableEhrDeptId(pathDisplay);
            const parentEhrDeptId = parentPath ? stableEhrDeptId(parentPath) : null;
            byPath.set(pathDisplay, {
                ehr_dept_id: ehrDeptId,
                parent_ehr_dept_id: parentEhrDeptId,
                depth: i + 1,
                name,
                path_display: pathDisplay
            });
        }
    }

    return byPath;
};

const fetchEmployeesFromEhrSql = async () => {
    const from = assertSafeEhrFrom(process.env.EHR_SYNC_FROM);
    const c0 = assertSafeSqlIdentifier(process.env.EHR_COL_EMPCODE || "empcode", "EHR_COL_EMPCODE");
    const c1 = assertSafeSqlIdentifier(process.env.EHR_COL_EMPNAME || "empname", "EHR_COL_EMPNAME");
    const c2 = assertSafeSqlIdentifier(process.env.EHR_COL_DEPT1 || "deptname1", "EHR_COL_DEPT1");
    const c3 = assertSafeSqlIdentifier(process.env.EHR_COL_DEPT2 || "deptname2", "EHR_COL_DEPT2");
    const c4 = assertSafeSqlIdentifier(process.env.EHR_COL_DEPT3 || "deptname3", "EHR_COL_DEPT3");
    const c5 = assertSafeSqlIdentifier(process.env.EHR_COL_DEPT4 || "deptname4", "EHR_COL_DEPT4");
    const c6 = assertSafeSqlIdentifier(process.env.EHR_COL_DEPT5 || "deptname5", "EHR_COL_DEPT5");
    const c7 = assertSafeSqlIdentifier(process.env.EHR_COL_EMPID || "empid", "EHR_COL_EMPID");
    const c8 = assertSafeSqlIdentifier(process.env.EHR_COL_EMPTYPE || "emptype", "EHR_COL_EMPTYPE");
    const c9 = assertSafeSqlIdentifier(process.env.EHR_COL_ORG_DEPTNAME || "deptname", "EHR_COL_ORG_DEPTNAME");
    const c10 = assertSafeSqlIdentifier(process.env.EHR_COL_STANAME || "staname", "EHR_COL_STANAME");
    const c11 = assertSafeSqlIdentifier(process.env.EHR_COL_JOBNAME || "jobname", "EHR_COL_JOBNAME");
    const c12 = assertSafeSqlIdentifier(process.env.EHR_COL_MOBILE || "mobilephone", "EHR_COL_MOBILE");

    const q = `
SELECT
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c0} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c1} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c2} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c3} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c4} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c5} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c6} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c7} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c8} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c9} AS NVARCHAR(512)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c10} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c11} AS NVARCHAR(256)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
    REPLACE(REPLACE(REPLACE(ISNULL(LTRIM(RTRIM(CAST(${c12} AS NVARCHAR(128)))), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
FROM ${from}
WHERE NULLIF(LTRIM(RTRIM(CAST(${c0} AS NVARCHAR(256)))), N'') IS NOT NULL;
`;

    const matrix = await runEhrQueryTsv(q);
    const out = [];
    const cell = (cells, i) => (cells && cells.length > i ? trim(cells[i]) : "");
    for (const cells of matrix) {
        if (!cells || cells.length < 7) continue;
        const empcode = trim(cells[0]);
        if (!empcode) continue;
        out.push({
            empcode,
            empname: trim(cells[1]),
            d1: trim(cells[2]),
            d2: trim(cells[3]),
            d3: trim(cells[4]),
            d4: trim(cells[5]),
            d5: trim(cells[6]),
            empid: cell(cells, 7),
            emptype: cell(cells, 8),
            orgDeptname: cell(cells, 9),
            staname: cell(cells, 10),
            jobname: cell(cells, 11),
            mobilephone: cell(cells, 12)
        });
    }
    return out;
};

const insertDepartmentsFromMap = async (byPath, nowIso) => {
    const list = [...byPath.values()].sort((a, b) => a.depth - b.depth);
    for (const d of list) {
        const id = uuidFromString(`dept:${d.path_display}`);
        const parentSql = d.parent_ehr_dept_id ? `N'${escapeSqlString(d.parent_ehr_dept_id)}'` : "NULL";
        await runQuery(`
            INSERT INTO dbo.departments (
                id, ehr_dept_id, parent_ehr_dept_id, depth, name,
                path_display, synced_at, is_deleted
            )
            VALUES (
                '${id}',
                N'${escapeSqlString(d.ehr_dept_id)}',
                ${parentSql},
                ${Number(d.depth)},
                N'${escapeSqlString(d.name)}',
                N'${escapeSqlString(d.path_display)}',
                '${nowIso}',
                0
            );
        `);
    }
};

const syncFromMock = async () => {
    const snapshot = ehrMockSnapshot();
    const now = new Date().toISOString();

    await runQuery("DELETE FROM dbo.users;");
    await runQuery("DELETE FROM dbo.departments;");

    for (const d of snapshot.departments) {
        const id = uuidFromString(d.ehr_dept_id);
        const ehrDeptId = d.ehr_dept_id;
        const parentEhrDeptId = d.parent_ehr_dept_id || null;
        const depth = d.depth || 1;
        const name = d.name || "";
        const pathDisplay = d.path_display || null;

        await runQuery(`
            INSERT INTO dbo.departments (
                id, ehr_dept_id, parent_ehr_dept_id, depth, name,
                path_display, synced_at, is_deleted
            )
            VALUES (
                '${id}',
                '${escapeSqlString(ehrDeptId)}',
                ${parentEhrDeptId ? `'${escapeSqlString(parentEhrDeptId)}'` : "NULL"},
                ${Number(depth)},
                N'${escapeSqlString(name)}',
                ${pathDisplay ? `N'${escapeSqlString(pathDisplay)}'` : "NULL"},
                '${now}',
                0
            );
        `);
    }

    const defaultPassword = process.env.DEV_DEFAULT_USER_PASSWORD;
    if (!defaultPassword || !String(defaultPassword).trim()) {
        throw new Error(
            "未配置 DEV_DEFAULT_USER_PASSWORD，无法进行 EHR 用户入库（开源版已移除内置默认口令；请在 backend/.env 中设置）"
        );
    }
    const passwordHash = await hashPassword(defaultPassword);

    for (const u of snapshot.users) {
        const id = uuidFromString(u.ehr_user_id);
        const loginId = u.login_id;
        const ehrUserId = u.ehr_user_id;
        const primaryDeptId = u.primary_ehr_dept_id ? uuidFromString(u.primary_ehr_dept_id) : null;
        const deptIds = Array.isArray(u.dept_ehr_ids)
            ? u.dept_ehr_ids.map((eid) => uuidFromString(eid))
            : [];

        const col = (s) => (trim(s) ? `N'${escapeSqlString(trim(s))}'` : "NULL");
        await runQuery(`
            INSERT INTO dbo.users (
                id, login_id, ehr_user_id, password_hash,
                password_changed_at, must_change_password,
                primary_dept_id, dept_ids_json,
                display_name, dept_name_1, dept_name_2, dept_name_3, dept_name_4, dept_name_5,
                ehr_emp_id, ehr_emp_type, ehr_deptname, ehr_staname, ehr_jobname, ehr_mobile,
                ehr_synced_at
            )
            VALUES (
                '${id}',
                N'${escapeSqlString(loginId)}',
                N'${escapeSqlString(ehrUserId)}',
                '${escapeSqlString(passwordHash)}',
                '${now}',
                1,
                ${primaryDeptId ? `'${primaryDeptId}'` : "NULL"},
                ${deptIds.length > 0 ? `N'${escapeSqlString(JSON.stringify(deptIds))}'` : "NULL"},
                ${col(u.display_name)},
                NULL, NULL, NULL, NULL, NULL,
                ${col(u.ehr_emp_id)},
                ${col(u.ehr_emp_type)},
                ${col(u.ehr_deptname)},
                ${col(u.ehr_staname)},
                ${col(u.ehr_jobname)},
                ${col(u.ehr_mobile)},
                '${now}'
            );
        `);
    }
};

const syncFromRemoteSql = async () => {
    const rows = await fetchEmployeesFromEhrSql();
    const now = new Date().toISOString();
    const byPath = collectDepartmentNodesFromRows(rows);

    await runQuery("DELETE FROM dbo.users;");
    await runQuery("DELETE FROM dbo.departments;");

    await insertDepartmentsFromMap(byPath, now);

    const defaultPassword = process.env.DEV_DEFAULT_USER_PASSWORD;
    if (!defaultPassword || !String(defaultPassword).trim()) {
        throw new Error(
            "未配置 DEV_DEFAULT_USER_PASSWORD，无法进行 EHR 用户入库（开源版已移除内置默认口令；请在 backend/.env 中设置）"
        );
    }
    const passwordHash = await hashPassword(defaultPassword);

    for (const r of rows) {
        const parts = [r.d1, r.d2, r.d3, r.d4, r.d5].map(trim).filter(Boolean);
        const leafPath = parts.length ? pathDisplayForParts(parts) : null;
        const primaryDeptId = leafPath ? uuidFromString(`dept:${leafPath}`) : null;
        const deptUuidList = parts.map((_, i) => uuidFromString(`dept:${pathDisplayForParts(parts.slice(0, i + 1))}`));
        const deptIdsJson = JSON.stringify(deptUuidList);

        const loginId = r.empcode;
        const ehrUserId = r.empcode;
        const id = uuidFromString(`ehruser:${ehrUserId}`);

        const col = (s) => (trim(s) ? `N'${escapeSqlString(trim(s))}'` : "NULL");

        await runQuery(`
            INSERT INTO dbo.users (
                id, login_id, ehr_user_id, password_hash,
                password_changed_at, must_change_password,
                primary_dept_id, dept_ids_json,
                display_name, dept_name_1, dept_name_2, dept_name_3, dept_name_4, dept_name_5,
                ehr_emp_id, ehr_emp_type, ehr_deptname, ehr_staname, ehr_jobname, ehr_mobile,
                ehr_synced_at
            )
            VALUES (
                '${id}',
                N'${escapeSqlString(loginId)}',
                N'${escapeSqlString(ehrUserId)}',
                '${escapeSqlString(passwordHash)}',
                '${now}',
                1,
                ${primaryDeptId ? `'${primaryDeptId}'` : "NULL"},
                N'${escapeSqlString(deptIdsJson)}',
                ${col(r.empname)},
                ${col(r.d1)}, ${col(r.d2)}, ${col(r.d3)}, ${col(r.d4)}, ${col(r.d5)},
                ${col(r.empid)},
                ${col(r.emptype)},
                ${col(r.orgDeptname)},
                ${col(r.staname)},
                ${col(r.jobname)},
                ${col(r.mobilephone)},
                '${now}'
            );
        `);
    }
};

/**
 * @param {{ source?: string }} opts
 *   source: mock | sql（读 EHR_MSSQL_* + EHR_SYNC_FROM）
 */
const syncEhrToSql = async ({ source = "mock" } = {}) => {
    const src = String(source || "mock").toLowerCase().trim();
    if (src === "sql") {
        await syncFromRemoteSql();
        return;
    }
    await syncFromMock();
};

module.exports = { syncEhrToSql };
