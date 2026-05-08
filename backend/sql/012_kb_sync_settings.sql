/* 镜像同步配置（单表单行 id=1）：目标目录、进程检测、企微、定时等；不再使用「共享路径→中转」复制，仅配置本地镜像根目录（如 AnyShare 自动下载目录）。 */

IF OBJECT_ID(N'dbo.kb_sync_settings', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.kb_sync_settings (
        id INT NOT NULL CONSTRAINT PK_kb_sync_settings PRIMARY KEY,
        share_path NVARCHAR(1024) NULL,
        staging_path NVARCHAR(1024) NULL,
        auto_sync_enabled BIT NOT NULL CONSTRAINT DF_kb_sync_auto DEFAULT 0,
        process_names NVARCHAR(512) NULL,
        wecom_webhook_url NVARCHAR(2048) NULL,
        cron_expr_1 NVARCHAR(128) NULL,
        cron_expr_2 NVARCHAR(128) NULL,
        skip_if_synced_today BIT NOT NULL CONSTRAINT DF_kb_sync_skip_day DEFAULT 1,
        last_success_date DATE NULL,
        last_success_at DATETIMEOFFSET NULL,
        last_run_at DATETIMEOFFSET NULL,
        last_run_status NVARCHAR(64) NULL,
        last_run_message NVARCHAR(2000) NULL,
        updated_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_kb_sync_updated DEFAULT SYSDATETIMEOFFSET()
    );
    INSERT INTO dbo.kb_sync_settings (id, cron_expr_1, cron_expr_2)
    VALUES (1, N'0 1 * * *', N'0 13 * * *');
END
GO
