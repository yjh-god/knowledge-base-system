/* 文档列表展示：入库时向量与分块参数快照（处理完成时由 worker 写入） */

IF COL_LENGTH('dbo.documents', 'vector_dim') IS NULL
    ALTER TABLE dbo.documents ADD vector_dim INT NULL;

IF COL_LENGTH('dbo.documents', 'chunk_count') IS NULL
    ALTER TABLE dbo.documents ADD chunk_count INT NULL;

IF COL_LENGTH('dbo.documents', 'embedding_batch_size') IS NULL
    ALTER TABLE dbo.documents ADD embedding_batch_size INT NULL;

IF COL_LENGTH('dbo.documents', 'chunk_size') IS NULL
    ALTER TABLE dbo.documents ADD chunk_size INT NULL;

IF COL_LENGTH('dbo.documents', 'chunk_overlap') IS NULL
    ALTER TABLE dbo.documents ADD chunk_overlap INT NULL;

IF COL_LENGTH('dbo.documents', 'embedding_model') IS NULL
    ALTER TABLE dbo.documents ADD embedding_model NVARCHAR(256) NULL;
