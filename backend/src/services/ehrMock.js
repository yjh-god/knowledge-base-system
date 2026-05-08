// M3: Mock EHR snapshot (用于开发联调；真实对接后替换该数据源与映射逻辑即可)
const ehrMockSnapshot = () => {
    // Internal mapping uses generated UUIDs derived from these EHR IDs.
    const dept = [
        {
            ehr_dept_id: "ehr-dept-quality",
            parent_ehr_dept_id: null,
            depth: 1,
            name: "品质中心",
            path_display: "品质中心"
        },
        {
            ehr_dept_id: "ehr-dept-iqc",
            parent_ehr_dept_id: "ehr-dept-quality",
            depth: 2,
            name: "IQC",
            path_display: "品质中心 / IQC"
        },
        {
            ehr_dept_id: "ehr-dept-iqc-a",
            parent_ehr_dept_id: "ehr-dept-iqc",
            depth: 3,
            name: "IQC-A",
            path_display: "品质中心 / IQC / IQC-A"
        },
        {
            ehr_dept_id: "ehr-dept-qa",
            parent_ehr_dept_id: "ehr-dept-quality",
            depth: 2,
            name: "QA",
            path_display: "品质中心 / QA"
        }
    ];

    const users = [
        {
            ehr_user_id: "ehr-user-001",
            login_id: "10001",
            primary_ehr_dept_id: "ehr-dept-iqc",
            dept_ehr_ids: ["ehr-dept-iqc", "ehr-dept-iqc-a"],
            display_name: "Mock 用户甲",
            ehr_emp_id: "E001",
            ehr_emp_type: "正式",
            ehr_deptname: "IQC",
            ehr_staname: "深圳",
            ehr_jobname: "质检员",
            ehr_mobile: "13800000001"
        },
        {
            ehr_user_id: "ehr-user-002",
            login_id: "10002",
            primary_ehr_dept_id: "ehr-dept-qa",
            dept_ehr_ids: ["ehr-dept-qa"],
            display_name: "Mock 用户乙",
            ehr_emp_id: "E002",
            ehr_emp_type: "正式",
            ehr_deptname: "QA",
            ehr_staname: "深圳",
            ehr_jobname: "质量工程师",
            ehr_mobile: "13800000002"
        }
    ];

    return { departments: dept, users };
};

module.exports = { ehrMockSnapshot };

