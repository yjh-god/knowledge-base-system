const express = require("express");



const { runQueryScalarInt, runQueryTsv } = require("../lib/sqlcmd");
const { resolveStorageKeyToAbsolute } = require("../lib/storagePaths");



const indexJobsRouter = express.Router();



indexJobsRouter.get("/", async (req, res) => {

    const page = req.query?.page ? Number(req.query.page) : 1;

    const pageSize = req.query?.pageSize ? Number(req.query.pageSize) : 20;

    const safePageSize = Math.max(1, Math.min(100, pageSize));

    const offset = Math.max(0, (page - 1) * safePageSize);



    try {

        const total = await runQueryScalarInt(`SELECT COUNT(*) FROM dbo.index_jobs;`);

        const rows = await runQueryTsv(`

            SELECT

                CONVERT(VARCHAR(36), j.id),

                CONVERT(VARCHAR(36), j.document_id),

                ISNULL(j.job_type, N''),

                ISNULL(j.status, N''),

                CAST(j.attempt_count AS VARCHAR(10)),

                CAST(j.max_attempts AS VARCHAR(10)),

                ISNULL(REPLACE(REPLACE(CAST(j.error_code AS NVARCHAR(128)), CHAR(9), N' '), CHAR(10), N' '), N''),

                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(CAST(j.error_message AS NVARCHAR(2000)), 1900), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),

                CONVERT(VARCHAR(40), j.created_at, 126),

                ISNULL(CONVERT(VARCHAR(40), j.finished_at, 126), N''),

                REPLACE(REPLACE(REPLACE(ISNULL(d.title, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),

                REPLACE(REPLACE(REPLACE(ISNULL(d.storage_key, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')

            FROM dbo.index_jobs j

            LEFT JOIN dbo.documents d ON d.id = j.document_id

            ORDER BY j.created_at DESC

            OFFSET ${offset} ROWS FETCH NEXT ${safePageSize} ROWS ONLY

        `, { variableLengthY: 8000 });

        const items = rows.map((c) => {

            const storageKey = (c[11] || "").trim() || null;

            return {

                id: c[0] || "",

                documentId: c[1] || "",

                jobType: c[2] || "",

                status: c[3] || "",

                attemptCount: Number(c[4]) || 0,

                maxAttempts: Number(c[5]) || 0,

                errorCode: c[6] || "",

                errorMessage: c[7] || "",

                createdAt: c[8] || "",

                finishedAt: c[9] || "",

                documentTitle: (c[10] || "").trim() || "",

                storageKey,

                absolutePath: storageKey ? resolveStorageKeyToAbsolute(storageKey) : null

            };

        });



        return res.status(200).json({

            code: 200,

            msg: "ok",

            data: {

                page,

                pageSize: safePageSize,

                total,

                items

            }

        });

    } catch (e) {

        // eslint-disable-next-line no-console

        console.error("index-jobs:", e);

        return res.status(500).json({ code: 500, msg: "读取任务失败", data: {} });

    }

});



module.exports = { indexJobsRouter };


