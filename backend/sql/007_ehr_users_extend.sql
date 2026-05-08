/* EHR 同步扩展：users 表增加展示名与 1～5 级部门名称镜像列 */

IF COL_LENGTH('dbo.users', 'display_name') IS NULL
    ALTER TABLE dbo.users ADD display_name NVARCHAR(255) NULL;

IF COL_LENGTH('dbo.users', 'dept_name_1') IS NULL
    ALTER TABLE dbo.users ADD dept_name_1 NVARCHAR(255) NULL;

IF COL_LENGTH('dbo.users', 'dept_name_2') IS NULL
    ALTER TABLE dbo.users ADD dept_name_2 NVARCHAR(255) NULL;

IF COL_LENGTH('dbo.users', 'dept_name_3') IS NULL
    ALTER TABLE dbo.users ADD dept_name_3 NVARCHAR(255) NULL;

IF COL_LENGTH('dbo.users', 'dept_name_4') IS NULL
    ALTER TABLE dbo.users ADD dept_name_4 NVARCHAR(255) NULL;

IF COL_LENGTH('dbo.users', 'dept_name_5') IS NULL
    ALTER TABLE dbo.users ADD dept_name_5 NVARCHAR(255) NULL;

IF COL_LENGTH('dbo.users', 'ehr_synced_at') IS NULL
    ALTER TABLE dbo.users ADD ehr_synced_at DATETIMEOFFSET NULL;
