/* 每次「立即同步 /定时同步」结束一条历史（镜像扫描统计 + 企微汇总） */

IF OBJECT_ID(N'dbo.kb_folder_sync_runs', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.kb_folder_sync_runs (
        id UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_kb_folder_sync_runs PRIMARY KEY,
        started_at DATETIMEOFFSET NOT NULL,
        finished_at DATETIMEOFFSET NOT NULL,
        trigger_type NVARCHAR(32) NOT NULL,
        status NVARCHAR(32) NOT NULL,
        duration_ms INT NULL,
        files_on_share INT NULL,
        copied INT NULL,
        skipped_md5 INT NULL,
        removed_staging INT NULL,
        docs_purged INT NULL,
        file_errors INT NULL,
        summary NVARCHAR(2000) NULL
    );
    CREATE INDEX IX_kb_folder_sync_runs_finished ON dbo.kb_folder_sync_runs (finished_at DESC);
END
GO
