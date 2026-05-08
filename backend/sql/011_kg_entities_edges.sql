/*
 * 知识图谱实例：实体节点与关系边（保留 references / belongs_to / applies_to / supersedes 四类关系类型定义在 010 中）。
 * 需在 010_kg_schema.sql 之后执行。
 */

IF OBJECT_ID('dbo.kg_entities', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.kg_entities (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        entity_type_code NVARCHAR(64) NOT NULL,
        name NVARCHAR(512) NOT NULL,
        properties_json NVARCHAR(MAX) NULL,
        source_doc_id UNIQUEIDENTIFIER NULL,
        source_chunk_index INT NULL,
        created_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_kg_entities_created DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT FK_kg_entities_entity_type FOREIGN KEY (entity_type_code) REFERENCES dbo.kg_entity_types (code)
    );
    CREATE INDEX IX_kg_entities_type ON dbo.kg_entities (entity_type_code);
    CREATE INDEX IX_kg_entities_doc ON dbo.kg_entities (source_doc_id);
    CREATE INDEX IX_kg_entities_created ON dbo.kg_entities (created_at DESC);
END
GO

IF OBJECT_ID('dbo.kg_edges', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.kg_edges (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        relation_type_code NVARCHAR(64) NOT NULL,
        from_entity_id UNIQUEIDENTIFIER NOT NULL,
        to_entity_id UNIQUEIDENTIFIER NOT NULL,
        properties_json NVARCHAR(MAX) NULL,
        source_doc_id UNIQUEIDENTIFIER NULL,
        confidence REAL NULL,
        created_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_kg_edges_created DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT FK_kg_edges_relation_type FOREIGN KEY (relation_type_code) REFERENCES dbo.kg_relation_types (code),
        CONSTRAINT FK_kg_edges_from_entity FOREIGN KEY (from_entity_id) REFERENCES dbo.kg_entities (id),
        CONSTRAINT FK_kg_edges_to_entity FOREIGN KEY (to_entity_id) REFERENCES dbo.kg_entities (id),
        CONSTRAINT CK_kg_edges_no_self_loop CHECK (from_entity_id <> to_entity_id)
    );
    CREATE INDEX IX_kg_edges_from ON dbo.kg_edges (from_entity_id);
    CREATE INDEX IX_kg_edges_to ON dbo.kg_edges (to_entity_id);
    CREATE INDEX IX_kg_edges_relation ON dbo.kg_edges (relation_type_code);
    CREATE INDEX IX_kg_edges_created ON dbo.kg_edges (created_at DESC);
END
GO
