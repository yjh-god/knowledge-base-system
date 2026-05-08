/*
 清空「知识库内容」便于测试后统一重入库（保留用户/部门/API Key/图谱类型字典/同步配置行本身）。

  会删：documents、index_jobs、知识图谱实例（kg_edges/kg_entities）、镜像同步运行历史、
       与文档/检索/图谱/同步相关的审计片段。
  不删：users、departments、api_keys、kg_entity_types、kg_relation_types、kb_sync_settings 主配置行（仅清空最近运行状态）。
*/

BEGIN TRANSACTION;

DELETE FROM dbo.index_jobs;

DELETE FROM dbo.documents;

/* 知识图谱：实例节点与边（类型字典 kg_entity_types / kg_relation_types 保留） */
IF OBJECT_ID('dbo.kg_edges', 'U') IS NOT NULL
    DELETE FROM dbo.kg_edges;
IF OBJECT_ID('dbo.kg_entities', 'U') IS NOT NULL
    DELETE FROM dbo.kg_entities;

/* 文件夹同步：历史记录清空；配置 id=1 保留，仅去掉上次运行痕迹避免管理页误导 */
IF OBJECT_ID(N'dbo.kb_folder_sync_runs', N'U') IS NOT NULL
    DELETE FROM dbo.kb_folder_sync_runs;
IF OBJECT_ID(N'dbo.kb_sync_settings', N'U') IS NOT NULL
    UPDATE dbo.kb_sync_settings
    SET last_success_date = NULL,
        last_success_at = NULL,
        last_run_at = NULL,
        last_run_status = NULL,
        last_run_message = NULL
    WHERE id = 1;

/* 审计：文档 / 检索 / RAG / 图谱实例维护 / 同步运行（不删 admin.api_key、用户密码等其它管理操作） */
DELETE FROM dbo.audit_logs
WHERE action LIKE N'doc.%'
   OR action LIKE N'search.%'
   OR action LIKE N'kg.%'
   OR action = N'admin.folder_sync_run'
   OR action = N'admin.sync_settings_update';

COMMIT TRANSACTION;
