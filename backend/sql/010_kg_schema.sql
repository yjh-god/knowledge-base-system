/*
 * 知识图谱（MVP）：
 * - documents 增加业务元数据（类型、作者、版本、来源、部门展示文案）
 * - kg_entity_types / kg_relation_types：由管理员维护的领域实体类型与关系类型
 * 执行后重启 API；Qdrant 需在 boot 时 ensure payload index（knowledge_type 等）或手动建索引。
 */

IF COL_LENGTH('dbo.documents', 'knowledge_type') IS NULL
BEGIN
    ALTER TABLE dbo.documents ADD knowledge_type NVARCHAR(32) NULL;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE name = N'CK_documents_knowledge_type' AND parent_object_id = OBJECT_ID(N'dbo.documents')
)
BEGIN
    ALTER TABLE dbo.documents ADD CONSTRAINT CK_documents_knowledge_type CHECK (
        knowledge_type IS NULL
        OR knowledge_type IN (N'FAQ', N'制度', N'方案', N'文档')
    );
END
GO

IF COL_LENGTH('dbo.documents', 'author') IS NULL
    ALTER TABLE dbo.documents ADD author NVARCHAR(256) NULL;
IF COL_LENGTH('dbo.documents', 'doc_version') IS NULL
    ALTER TABLE dbo.documents ADD doc_version NVARCHAR(64) NULL;
IF COL_LENGTH('dbo.documents', 'source_uri') IS NULL
    ALTER TABLE dbo.documents ADD source_uri NVARCHAR(2048) NULL;
IF COL_LENGTH('dbo.documents', 'department_caption') IS NULL
    ALTER TABLE dbo.documents ADD department_caption NVARCHAR(512) NULL;
GO

IF OBJECT_ID('dbo.kg_entity_types', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.kg_entity_types (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        code NVARCHAR(64) NOT NULL,
        display_name NVARCHAR(128) NOT NULL,
        description NVARCHAR(500) NULL,
        sort_order INT NOT NULL CONSTRAINT DF_kg_entity_types_sort DEFAULT (0),
        is_active BIT NOT NULL CONSTRAINT DF_kg_entity_types_active DEFAULT (1),
        created_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_kg_entity_types_created DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT UQ_kg_entity_types_code UNIQUE (code)
    );
END
GO

IF OBJECT_ID('dbo.kg_relation_types', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.kg_relation_types (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        code NVARCHAR(64) NOT NULL,
        display_name NVARCHAR(128) NOT NULL,
        description NVARCHAR(500) NULL,
        domain_type_code NVARCHAR(64) NULL,
        range_type_code NVARCHAR(64) NULL,
        sort_order INT NOT NULL CONSTRAINT DF_kg_relation_types_sort DEFAULT (0),
        is_active BIT NOT NULL CONSTRAINT DF_kg_relation_types_active DEFAULT (1),
        created_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_kg_relation_types_created DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT UQ_kg_relation_types_code UNIQUE (code)
    );
END
GO

/* 预置类型（可删改；code 供边/实体抽取与 API 引用） */
IF NOT EXISTS (SELECT 1 FROM dbo.kg_entity_types WHERE code = N'DocumentChunk')
    INSERT INTO dbo.kg_entity_types (code, display_name, description, sort_order)
    VALUES (N'DocumentChunk', N'文档块', N'与向量分块一一对应，payload 含 content/doc_id/chunk_index 等', 0);

IF NOT EXISTS (SELECT 1 FROM dbo.kg_entity_types WHERE code = N'FAQ')
    INSERT INTO dbo.kg_entity_types (code, display_name, description, sort_order)
    VALUES (N'FAQ', N'问答条目', N'FAQ 类知识', 10);

IF NOT EXISTS (SELECT 1 FROM dbo.kg_entity_types WHERE code = N'Policy')
    INSERT INTO dbo.kg_entity_types (code, display_name, description, sort_order)
    VALUES (N'Policy', N'制度条款', N'制度/规章中的逻辑实体', 20);

IF NOT EXISTS (SELECT 1 FROM dbo.kg_entity_types WHERE code = N'Department')
    INSERT INTO dbo.kg_entity_types (code, display_name, description, sort_order)
    VALUES (N'Department', N'部门', N'组织维度', 30);

IF NOT EXISTS (SELECT 1 FROM dbo.kg_relation_types WHERE code = N'references')
    INSERT INTO dbo.kg_relation_types (code, display_name, description, domain_type_code, range_type_code, sort_order)
    VALUES (N'references', N'引用', N'文档块引用另一文档块或实体', N'DocumentChunk', NULL, 0);

IF NOT EXISTS (SELECT 1 FROM dbo.kg_relation_types WHERE code = N'belongs_to')
    INSERT INTO dbo.kg_relation_types (code, display_name, description, domain_type_code, range_type_code, sort_order)
    VALUES (N'belongs_to', N'属于', N'从属于文档或章节', NULL, NULL, 10);

IF NOT EXISTS (SELECT 1 FROM dbo.kg_relation_types WHERE code = N'applies_to')
    INSERT INTO dbo.kg_relation_types (code, display_name, description, domain_type_code, range_type_code, sort_order)
    VALUES (N'applies_to', N'适用于', N'制度适用于部门/场景', NULL, N'Department', 20);

IF NOT EXISTS (SELECT 1 FROM dbo.kg_relation_types WHERE code = N'supersedes')
    INSERT INTO dbo.kg_relation_types (code, display_name, description, domain_type_code, range_type_code, sort_order)
    VALUES (N'supersedes', N'替代', N'新版本替代旧版本', N'Policy', N'Policy', 30);

GO
