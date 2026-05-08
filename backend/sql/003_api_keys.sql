/* G9: API Key 持久化（PRD §7.5），供系统管理与 OpenClaw 集成 */

IF OBJECT_ID('dbo.api_keys', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.api_keys (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        key_prefix NVARCHAR(32) NOT NULL,
        key_hash CHAR(64) NOT NULL,
        bound_user_id UNIQUEIDENTIFIER NOT NULL,
        name NVARCHAR(255) NOT NULL,
        created_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_api_keys_created_at DEFAULT SYSDATETIMEOFFSET(),
        revoked_at DATETIMEOFFSET NULL,
        last_used_at DATETIMEOFFSET NULL
    );

    CREATE INDEX IX_api_keys_bound_user_id ON dbo.api_keys(bound_user_id);
    CREATE INDEX IX_api_keys_key_hash ON dbo.api_keys(key_hash);
END
