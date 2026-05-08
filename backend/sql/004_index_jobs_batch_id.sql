/* 为批量异步入库：index_jobs 增加 batch_id，便于按批次聚合进度 */
IF COL_LENGTH('dbo.index_jobs', 'batch_id') IS NULL
BEGIN
    ALTER TABLE dbo.index_jobs ADD batch_id UNIQUEIDENTIFIER NULL;
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'IX_index_jobs_batch_id' AND object_id = OBJECT_ID(N'dbo.index_jobs')
)
BEGIN
    CREATE INDEX IX_index_jobs_batch_id ON dbo.index_jobs(batch_id);
END;
