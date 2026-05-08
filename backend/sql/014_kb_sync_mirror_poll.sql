/* 同步配置：镜像目录「后台轮询」开关与间隔（与定时「自动同步」互补，可在界面关闭轮询仅保留定时/手动） */

IF COL_LENGTH('dbo.kb_sync_settings', 'mirror_poll_enabled') IS NULL
BEGIN
    ALTER TABLE dbo.kb_sync_settings
    ADD mirror_poll_enabled BIT NOT NULL CONSTRAINT DF_kb_mirror_poll_en DEFAULT 1;
END
GO

IF COL_LENGTH('dbo.kb_sync_settings', 'mirror_poll_interval_ms') IS NULL
BEGIN
    ALTER TABLE dbo.kb_sync_settings
    ADD mirror_poll_interval_ms INT NOT NULL CONSTRAINT DF_kb_mirror_poll_ms DEFAULT 60000;
END
GO

IF COL_LENGTH('dbo.kb_sync_settings', 'mirror_poll_max_files') IS NULL
BEGIN
    ALTER TABLE dbo.kb_sync_settings
    ADD mirror_poll_max_files INT NOT NULL CONSTRAINT DF_kb_mirror_poll_cap DEFAULT 80;
END
GO
