/* M1: Core tables for Knowledge Base (PRD §7.2~§7.4)
   Notes:
   - SQL Server has no native JSONB/ENUM/UUID: PRD types are mapped:
     JSONB -> NVARCHAR(MAX), ENUM -> NVARCHAR with CHECK, UUID -> UNIQUEIDENTIFIER
   - This script is intended for initial development environment.
*/

IF OBJECT_ID('dbo.documents', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.documents (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        storage_key VARCHAR(512) NOT NULL,
        mime_type VARCHAR(127) NOT NULL,
        size_bytes BIGINT NOT NULL,
        content_hash VARCHAR(64) NOT NULL,
        indexed_content_hash VARCHAR(64) NULL,
        status NVARCHAR(32) NOT NULL,
        owner_user_id UNIQUEIDENTIFIER NOT NULL,
        dept_scope_json NVARCHAR(MAX) NULL,
        acl_json NVARCHAR(MAX) NULL,
        created_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_documents_created_at DEFAULT SYSDATETIMEOFFSET(),
        updated_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_documents_updated_at DEFAULT SYSDATETIMEOFFSET(),
        last_opened_at DATETIMEOFFSET NULL,
        night_batch_flag BIT NOT NULL CONSTRAINT DF_documents_night_batch_flag DEFAULT (1),
        deleted_at DATETIMEOFFSET NULL,
        CONSTRAINT CK_documents_status CHECK (
            status IN (N'draft', N'pending_index', N'indexed', N'failed', N'disabled', N'deleted')
        )
    );

    CREATE INDEX IX_documents_status ON dbo.documents(status);
    CREATE INDEX IX_documents_content_hash ON dbo.documents(content_hash);
    CREATE INDEX IX_documents_updated_at ON dbo.documents(updated_at);
    CREATE INDEX IX_documents_status_deleted_at ON dbo.documents(status, deleted_at);
END

IF OBJECT_ID('dbo.index_jobs', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.index_jobs (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        document_id UNIQUEIDENTIFIER NOT NULL,
        job_type NVARCHAR(64) NOT NULL,
        priority SMALLINT NOT NULL CONSTRAINT DF_index_jobs_priority DEFAULT (0),
        status NVARCHAR(32) NOT NULL,
        attempt_count INT NOT NULL CONSTRAINT DF_index_jobs_attempt_count DEFAULT (0),
        max_attempts INT NOT NULL CONSTRAINT DF_index_jobs_max_attempts DEFAULT (3),
        error_code VARCHAR(64) NULL,
        error_message NVARCHAR(MAX) NULL,
        payload_json NVARCHAR(MAX) NULL,
        started_at DATETIMEOFFSET NULL,
        finished_at DATETIMEOFFSET NULL,
        created_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_index_jobs_created_at DEFAULT SYSDATETIMEOFFSET(),
        created_by UNIQUEIDENTIFIER NULL,
        worker_id NVARCHAR(128) NULL,
        CONSTRAINT CK_index_jobs_job_type CHECK (
            job_type IN (
                N'immediate_upload',
                N'manual_reindex',
                N'scheduled_batch',
                N'delete_vectors',
                N'nightly_reconcile_delete'
            )
        ),
        CONSTRAINT CK_index_jobs_status CHECK (
            status IN (N'queued', N'running', N'success', N'failed', N'cancelled')
        )
    );

    CREATE INDEX IX_index_jobs_status_priority_created_at
        ON dbo.index_jobs(status, priority DESC, created_at);
    CREATE INDEX IX_index_jobs_document_id ON dbo.index_jobs(document_id);
    CREATE INDEX IX_index_jobs_status_job_type ON dbo.index_jobs(status, job_type);
END

IF OBJECT_ID('dbo.audit_logs', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.audit_logs (
        id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        actor_user_id UNIQUEIDENTIFIER NULL,
        actor_login_id NVARCHAR(128) NULL,
        action NVARCHAR(64) NOT NULL,
        target_type NVARCHAR(32) NULL,
        target_id UNIQUEIDENTIFIER NULL,
        summary NVARCHAR(512) NULL,
        metadata_json NVARCHAR(MAX) NULL,
        created_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_audit_logs_created_at DEFAULT SYSDATETIMEOFFSET()
    );

    CREATE INDEX IX_audit_logs_created_at_desc ON dbo.audit_logs(created_at DESC);
    CREATE INDEX IX_audit_logs_actor_user_created_at ON dbo.audit_logs(actor_user_id, created_at DESC);
    CREATE INDEX IX_audit_logs_action_created_at ON dbo.audit_logs(action, created_at DESC);
END

/* Optional but convenient columns:
   - dbo.documents.updated_at should be maintained by application/trigger.
   - We'll keep it simple for M1 and avoid triggers in initial script.
*/

