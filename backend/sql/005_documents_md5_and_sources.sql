/* SQL Server 2014: 内容 MD5 指纹、来源、镜像路径；用于向量增量与对账 */

IF COL_LENGTH('dbo.documents', 'content_md5') IS NULL
    ALTER TABLE dbo.documents ADD content_md5 VARCHAR(32) NULL;

IF COL_LENGTH('dbo.documents', 'indexed_content_md5') IS NULL
    ALTER TABLE dbo.documents ADD indexed_content_md5 VARCHAR(32) NULL;

IF COL_LENGTH('dbo.documents', 'source_type') IS NULL
    ALTER TABLE dbo.documents ADD source_type NVARCHAR(32) NULL;

IF COL_LENGTH('dbo.documents', 'mirror_rel_path') IS NULL
    ALTER TABLE dbo.documents ADD mirror_rel_path NVARCHAR(1024) NULL;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = N'IX_documents_content_md5' AND object_id = OBJECT_ID(N'dbo.documents')
)
    CREATE INDEX IX_documents_content_md5 ON dbo.documents(content_md5);

/* 不在 mirror_rel_path 上建索引：NVARCHAR(1024) 索引键可超过 900 字节上限（Msg 1945），长路径插入会失败。
   若曾执行过旧版 005 并已建 IX_documents_mirror_rel_path，请手动：
   DROP INDEX IX_documents_mirror_rel_path ON dbo.documents; */
