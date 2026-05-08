/* M3: EHR mirror tables (PRD §7.2.2 / §7.3)
   Creates:
   - dbo.departments
   - dbo.users
   Notes: no FK constraints in initial development environment.
*/

IF OBJECT_ID('dbo.departments', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.departments (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        ehr_dept_id VARCHAR(128) NOT NULL UNIQUE,
        parent_ehr_dept_id VARCHAR(128) NULL,
        depth TINYINT NOT NULL,
        name NVARCHAR(255) NOT NULL,
        path_display NVARCHAR(512) NULL,
        sort_order INT NULL,
        synced_at DATETIMEOFFSET NULL,
        is_deleted BIT NOT NULL CONSTRAINT DF_departments_is_deleted DEFAULT (0),
        CONSTRAINT CK_departments_depth CHECK (depth BETWEEN 1 AND 5)
    );

    CREATE INDEX IX_departments_parent_ehr_dept_id ON dbo.departments(parent_ehr_dept_id);
    CREATE INDEX IX_departments_depth ON dbo.departments(depth);
END

IF OBJECT_ID('dbo.users', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.users (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        login_id NVARCHAR(128) NOT NULL UNIQUE,
        ehr_user_id NVARCHAR(128) NOT NULL UNIQUE,
        password_hash NVARCHAR(512) NOT NULL,
        password_changed_at DATETIMEOFFSET NULL,
        must_change_password BIT NOT NULL CONSTRAINT DF_users_must_change_password DEFAULT (0),
        primary_dept_id UNIQUEIDENTIFIER NULL,
        dept_ids_json NVARCHAR(MAX) NULL
    );

    CREATE INDEX IX_users_primary_dept_id ON dbo.users(primary_dept_id);
END

