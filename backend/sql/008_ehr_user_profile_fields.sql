/* EHR 人员档案扩展：empid / emptype / deptname(所属部门) / staname / jobname / mobilephone */

IF COL_LENGTH('dbo.users', 'ehr_emp_id') IS NULL
    ALTER TABLE dbo.users ADD ehr_emp_id NVARCHAR(128) NULL;

IF COL_LENGTH('dbo.users', 'ehr_emp_type') IS NULL
    ALTER TABLE dbo.users ADD ehr_emp_type NVARCHAR(128) NULL;

IF COL_LENGTH('dbo.users', 'ehr_deptname') IS NULL
    ALTER TABLE dbo.users ADD ehr_deptname NVARCHAR(512) NULL;

IF COL_LENGTH('dbo.users', 'ehr_staname') IS NULL
    ALTER TABLE dbo.users ADD ehr_staname NVARCHAR(256) NULL;

IF COL_LENGTH('dbo.users', 'ehr_jobname') IS NULL
    ALTER TABLE dbo.users ADD ehr_jobname NVARCHAR(256) NULL;

IF COL_LENGTH('dbo.users', 'ehr_mobile') IS NULL
    ALTER TABLE dbo.users ADD ehr_mobile NVARCHAR(64) NULL;
