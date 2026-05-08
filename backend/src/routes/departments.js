const express = require("express");

const { runQueryTsv, runQueryScalarInt } = require("../lib/sqlcmd");

const departmentsRouter = express.Router();

const mockDepartments = [
    {
        id: "101",
        name: "品质中心",
        depth: 1,
        children: [
            {
                id: "201",
                name: "IQC",
                depth: 2,
                children: [
                    {
                        id: "301",
                        name: "IQC-A",
                        depth: 3,
                        children: [
                            {
                                id: "401",
                                name: "IQC-A1",
                                depth: 4,
                                children: [{ id: "501", name: "IQC-A1-1", depth: 5, children: [] }]
                            }
                        ]
                    }
                ]
            },
            {
                id: "202",
                name: "QA",
                depth: 2,
                children: [
                    {
                        id: "302",
                        name: "QA-B",
                        depth: 3,
                        children: [
                            {
                                id: "402",
                                name: "QA-B1",
                                depth: 4,
                                children: [{ id: "502", name: "QA-B1-1", depth: 5, children: [] }]
                            }
                        ]
                    }
                ]
            }
        ]
    }
];

const buildTreeFromFlat = (flat) => {
    const byEhr = new Map();
    const nodes = flat.map((r) => {
        const n = {
            id: r.id,
            ehrDeptId: r.ehrDeptId,
            parentEhrDeptId: r.parentEhrDeptId,
            name: r.name,
            depth: r.depth,
            children: []
        };
        byEhr.set(r.ehrDeptId, n);
        return n;
    });

    const roots = [];
    for (const n of nodes) {
        if (!n.parentEhrDeptId) {
            roots.push(n);
            continue;
        }
        const p = byEhr.get(n.parentEhrDeptId);
        if (p) p.children.push(n);
        else roots.push(n);
    }

    const strip = (n) => ({
        id: n.id,
        name: n.name,
        depth: n.depth,
        children: n.children.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN")).map(strip)
    });

    return roots.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN")).map(strip);
};

const loadDepartmentsFromDb = async () => {
    const rows = await runQueryTsv(`
        SELECT
            CONVERT(VARCHAR(36), id),
            REPLACE(REPLACE(REPLACE(ISNULL(CAST(ehr_dept_id AS NVARCHAR(200)), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
            REPLACE(REPLACE(REPLACE(ISNULL(CAST(parent_ehr_dept_id AS NVARCHAR(200)), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
            CAST(depth AS VARCHAR(10)),
            REPLACE(REPLACE(REPLACE(ISNULL(name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
        FROM dbo.departments
        WHERE is_deleted = 0
        ORDER BY depth, name;
    `);

    const flat = [];
    for (const c of rows) {
        if (!c || c.length < 5) continue;
        const id = (c[0] || "").trim();
        const ehrDeptId = (c[1] || "").trim();
        if (!id || !ehrDeptId) continue;
        flat.push({
            id,
            ehrDeptId,
            parentEhrDeptId: (c[2] || "").trim() || null,
            depth: Math.min(5, Math.max(1, Number(c[3]) || 1)),
            name: (c[4] || "").trim() || ehrDeptId
        });
    }

    return buildTreeFromFlat(flat);
};

departmentsRouter.get("/", async (req, res) => {
    try {
        const cnt = await runQueryScalarInt(`
            SELECT COUNT(*) FROM dbo.departments WHERE is_deleted = 0;
        `);
        if (cnt > 0) {
            const tree = await loadDepartmentsFromDb();
            return res.status(200).json({
                code: 200,
                msg: "ok",
                data: { departments: tree }
            });
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("departments: DB 读取失败，回退 Mock", e?.message || e);
    }

    return res.status(200).json({
        code: 200,
        msg: "ok",
        data: { departments: mockDepartments }
    });
});

module.exports = { departmentsRouter, mockDepartments };
