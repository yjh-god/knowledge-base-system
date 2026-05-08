require("dotenv").config();
const crypto = require("crypto");
const { hashPassword } = require("../src/lib/passwordHash");
const { runQuery, runQueryTsv } = require("../src/lib/sqlcmd");

const esc = (s) => String(s).replace(/'/g, "''");

(async () => {
    const batch = await runQueryTsv(
        "SELECT CONVERT(VARCHAR(36), id) FROM dbo.departments WHERE is_deleted = 0"
    );
    const ids = (batch || []).map((r) => r && r[0]).filter(Boolean);
    const deptIdsJson = JSON.stringify(ids);
    const pwd = process.env.DEV_PASSWORD;
    if (!pwd || !String(pwd).trim()) {
        console.error("请设置环境变量 DEV_PASSWORD（开源版不再内置默认口令）");
        process.exit(1);
    }
    const hash = await hashPassword(pwd);
    const id = crypto.randomUUID();

    await runQuery(`
    IF EXISTS (SELECT 1 FROM dbo.users WHERE login_id = N'admin')
    BEGIN
      UPDATE dbo.users SET
        display_name = N'admin',
        ehr_deptname = N'示例单位',
        ehr_synced_at = SYSDATETIMEOFFSET()
      WHERE login_id = N'admin';
    END
    ELSE
    BEGIN
      INSERT INTO dbo.users (
        id, login_id, ehr_user_id, password_hash, password_changed_at, must_change_password,
        primary_dept_id, dept_ids_json,
        display_name, dept_name_1, dept_name_2, dept_name_3, dept_name_4, dept_name_5,
        ehr_emp_id, ehr_emp_type, ehr_deptname, ehr_staname, ehr_jobname, ehr_mobile,
        ehr_synced_at
      ) VALUES (
        '${id}',
        N'admin',
        N'admin-local',
        N'${esc(hash)}',
        SYSDATETIMEOFFSET(),
        0,
        NULL,
        N'${esc(deptIdsJson)}',
        N'admin',
        NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, N'示例单位', NULL, NULL, NULL,
        SYSDATETIMEOFFSET()
      );
    END
    `);

    const check = await runQueryTsv(
        "SELECT login_id, display_name, ehr_deptname FROM dbo.users WHERE login_id = N'admin'"
    );
    // eslint-disable-next-line no-console
    console.log("OK", check && check[0] ? check[0] : check);
})().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
});
