/**
 * 将 LLM 抽取结果写入 dbo.kg_entities / dbo.kg_edges；按文档清理旧实例。
 */

const crypto = require("crypto");
const { runQuery, runQueryTsv, runQueryScalarInt } = require("./sqlcmd");
const { extractKgFromChunkLlm, isKgExtractEnabled } = require("./kgExtractLlm");

const escapeSql = (s) => String(s ?? "").replace(/'/g, "''");

const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const sqlSafeUuid = (id) => String(id || "").replace(/'/g, "''");

const migration503 = (msg) => /Invalid object name|kg_entities|kg_edges/i.test(String(msg || ""));

const maxChunksPerDoc = () => {
    const n = Number(process.env.INGEST_KG_EXTRACT_MAX_CHUNKS);
    if (Number.isFinite(n) && n >= 1) return Math.min(200, Math.floor(n));
    return 60;
};

/**
 * 删除该文档在图库中的实例（与重索引删向量时机一致调用）。
 */
const deleteKgDataForDocId = async (docId) => {
    if (!UUID_RE.test(String(docId || ""))) return;
    const sid = sqlSafeUuid(docId);
    await runQuery(`
        DELETE FROM dbo.kg_edges WHERE source_doc_id = CAST('${sid}' AS UNIQUEIDENTIFIER);
        DELETE FROM dbo.kg_entities WHERE source_doc_id = CAST('${sid}' AS UNIQUEIDENTIFIER);
    `);
};

const normalizeName = (s) => String(s ?? "").trim().slice(0, 512);

const stringifyProps = (props) => {
    if (props == null) return null;
    if (typeof props === "string") {
        const t = props.trim();
        if (!t) return null;
        try {
            JSON.parse(t);
            return t.slice(0, 120_000);
        } catch {
            return null;
        }
    }
    if (typeof props === "object") {
        try {
            return JSON.stringify(props).slice(0, 120_000);
        } catch {
            return null;
        }
    }
    return null;
};

const loadValidEntityCodes = async () => {
    const rows = await runQueryTsv(`
        SELECT REPLACE(REPLACE(REPLACE(ISNULL(code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
        FROM dbo.kg_entity_types WHERE is_active = 1;
    `);
    const set = new Set();
    for (const r of rows || []) {
        const c = String(r[0] || "").trim();
        if (c) set.add(c);
    }
    return set;
};

const loadRelationConstraints = async () => {
    const rows = await runQueryTsv(`
        SELECT
            REPLACE(REPLACE(REPLACE(ISNULL(code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
            REPLACE(REPLACE(REPLACE(ISNULL(domain_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
            REPLACE(REPLACE(REPLACE(ISNULL(range_type_code, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
        FROM dbo.kg_relation_types WHERE is_active = 1;
    `);
    const map = new Map();
    for (const r of rows || []) {
        if (!r || r.length < 3) continue;
        const code = String(r[0] || "").trim();
        if (!code) continue;
        map.set(code, {
            domain: String(r[1] || "").trim() || null,
            range: String(r[2] || "").trim() || null
        });
    }
    return map;
};

const lookupEntityIdInDoc = async (docId, typeCode, name) => {
    const n = normalizeName(name);
    const t = String(typeCode || "").trim();
    if (!t || !n) return null;
    const sid = sqlSafeUuid(docId);
    const rows = await runQueryTsv(
        `
        SELECT CONVERT(VARCHAR(36), id)
        FROM dbo.kg_entities
        WHERE source_doc_id = CAST('${sid}' AS UNIQUEIDENTIFIER)
          AND entity_type_code = N'${escapeSql(t)}'
          AND name = N'${escapeSql(n)}';
        `,
        { variableLengthY: 4000 }
    );
    if (!rows || !rows[0] || !rows[0][0]) return null;
    return String(rows[0][0]).trim();
};

const findOrCreateEntity = async ({ docId, chunkIndex, typeCode, name, propsJson }) => {
    const sid = sqlSafeUuid(docId);
    const t = escapeSql(typeCode);
    const n = escapeSql(name);
    const existing = await runQueryTsv(
        `
        SELECT CONVERT(VARCHAR(36), id)
        FROM dbo.kg_entities
        WHERE source_doc_id = CAST('${sid}' AS UNIQUEIDENTIFIER)
          AND entity_type_code = N'${t}'
          AND name = N'${n}';
        `,
        { variableLengthY: 4000 }
    );
    if (existing && existing[0] && existing[0][0]) {
        return String(existing[0][0]).trim();
    }
    const id = crypto.randomUUID();
    const propsSql = propsJson ? `N'${escapeSql(propsJson)}'` : "NULL";
    const chunkSql = Number.isFinite(chunkIndex) && chunkIndex >= 0 ? String(Math.floor(chunkIndex)) : "NULL";
    await runQuery(`
        INSERT INTO dbo.kg_entities (
            id, entity_type_code, name, properties_json, source_doc_id, source_chunk_index
        )
        VALUES (
            CAST('${sqlSafeUuid(id)}' AS UNIQUEIDENTIFIER),
            N'${t}',
            N'${n}',
            ${propsSql},
            CAST('${sid}' AS UNIQUEIDENTIFIER),
            ${chunkSql}
        );
    `);
    return id;
};

const edgeExists = async (fromId, toId, relCode) => {
    const n = await runQueryScalarInt(`
        SELECT COUNT(*) FROM dbo.kg_edges
        WHERE from_entity_id = CAST('${sqlSafeUuid(fromId)}' AS UNIQUEIDENTIFIER)
          AND to_entity_id = CAST('${sqlSafeUuid(toId)}' AS UNIQUEIDENTIFIER)
          AND relation_type_code = N'${escapeSql(relCode)}';
    `);
    return Number(n) > 0;
};

const insertEdge = async ({ docId, relationTypeCode, fromId, toId, confidence, propsJson }) => {
    if (fromId === toId) return false;
    if (await edgeExists(fromId, toId, relationTypeCode)) return false;
    const id = crypto.randomUUID();
    const sid = sqlSafeUuid(docId);
    const propsSql = propsJson ? `N'${escapeSql(propsJson)}'` : "NULL";
    const confRaw = confidence;
    const conf =
        confRaw == null || confRaw === ""
            ? null
            : Number(confRaw);
    const confSql =
        conf != null && Number.isFinite(conf) && conf >= 0 && conf <= 1 ? String(conf) : "NULL";
    await runQuery(`
        INSERT INTO dbo.kg_edges (
            id, relation_type_code, from_entity_id, to_entity_id,
            properties_json, source_doc_id, confidence
        )
        VALUES (
            CAST('${sqlSafeUuid(id)}' AS UNIQUEIDENTIFIER),
            N'${escapeSql(relationTypeCode)}',
            CAST('${sqlSafeUuid(fromId)}' AS UNIQUEIDENTIFIER),
            CAST('${sqlSafeUuid(toId)}' AS UNIQUEIDENTIFIER),
            ${propsSql},
            CAST('${sid}' AS UNIQUEIDENTIFIER),
            ${confSql}
        );
    `);
    return true;
};

const entityKey = (typeCode, name) => `${String(typeCode).trim()}\n${normalizeName(name)}`;

const validateEdgeTypes = (relMap, relCode, fromType, toType) => {
    const rule = relMap.get(relCode);
    if (!rule) return false;
    if (rule.domain && fromType !== rule.domain) return false;
    if (rule.range && toType !== rule.range) return false;
    return true;
};

/**
 * @param {object} p
 * @param {string} p.docId
 * @param {Array<{ text: string, section_heading?: string }>} p.chunks
 * @param {object} [p.graphDocMeta]
 */
const extractAndPersistKgForIngest = async ({ docId, chunks, graphDocMeta = {} }) => {
    if (!isKgExtractEnabled()) {
        return { skipped: true, reason: "INGEST_KG_EXTRACT off" };
    }
    if (!process.env.VLLM_BASE_URL) {
        return { skipped: true, reason: "VLLM_BASE_URL missing" };
    }
    if (!UUID_RE.test(String(docId || ""))) {
        return { skipped: true, reason: "invalid docId" };
    }
    if (!Array.isArray(chunks) || chunks.length === 0) {
        return { skipped: true, reason: "no chunks" };
    }

    let validEntityCodes;
    let relMap;
    try {
        validEntityCodes = await loadValidEntityCodes();
        relMap = await loadRelationConstraints();
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (migration503(msg)) {
            return { skipped: true, reason: "kg tables missing (run 011 migration)" };
        }
        throw e;
    }

    const limit = Math.min(chunks.length, maxChunksPerDoc());
    let chunksProcessed = 0;
    let entitiesTouched = 0;
    let edgesInserted = 0;
    const errors = [];

    for (let i = 0; i < limit; i++) {
        const c = chunks[i] || {};
        const chunkText = String(c.text || "");
        const sectionHeading = c.section_heading ? String(c.section_heading) : "";
        const meta = {
            ...graphDocMeta,
            sectionHeading: sectionHeading || graphDocMeta.sectionHeading
        };
        try {
            const { entities, edges } = await extractKgFromChunkLlm({
                chunkText,
                chunkIndex: i,
                graphDocMeta: meta
            });
            const idByKey = new Map();
            const chunkLabel = `文档块#${i}`;
            const chunkPropsJson = sectionHeading
                ? JSON.stringify({ section: sectionHeading.slice(0, 500) })
                : null;
            try {
                const chunkEntId = await findOrCreateEntity({
                    docId,
                    chunkIndex: i,
                    typeCode: "DocumentChunk",
                    name: chunkLabel,
                    propsJson: chunkPropsJson
                });
                idByKey.set(entityKey("DocumentChunk", chunkLabel), chunkEntId);
                entitiesTouched += 1;
            } catch (err) {
                errors.push(`chunk ${i} DocumentChunk anchor: ${(err && err.message) || err}`);
            }

            for (const ent of entities) {
                const typeCode = String(ent.entityTypeCode || ent.entity_type_code || "").trim();
                const name = normalizeName(ent.name || ent.entity_name);
                if (!typeCode || !name) continue;
                if (!validEntityCodes.has(typeCode)) continue;
                const propsJson = stringifyProps(ent.properties ?? ent.properties_json);
                try {
                    const id = await findOrCreateEntity({
                        docId,
                        chunkIndex: i,
                        typeCode,
                        name,
                        propsJson
                    });
                    idByKey.set(entityKey(typeCode, name), id);
                    entitiesTouched += 1;
                } catch (err) {
                    errors.push(`chunk ${i} entity ${typeCode}/${name}: ${(err && err.message) || err}`);
                }
            }

            for (const ed of edges) {
                const relCode = String(ed.relationTypeCode || ed.relation_type_code || "").trim();
                const fromType = String(ed.fromTypeCode || ed.from_type_code || "").trim();
                const toType = String(ed.toTypeCode || ed.to_type_code || "").trim();
                const fromName = normalizeName(ed.fromName || ed.from_name);
                const toName = normalizeName(ed.toName || ed.to_name);
                if (!relMap.has(relCode)) continue;
                if (!validateEdgeTypes(relMap, relCode, fromType, toType)) continue;
                let fromId = idByKey.get(entityKey(fromType, fromName));
                let toId = idByKey.get(entityKey(toType, toName));
                if (!fromId) {
                    // eslint-disable-next-line no-await-in-loop
                    fromId = await lookupEntityIdInDoc(docId, fromType, fromName);
                }
                if (!toId) {
                    // eslint-disable-next-line no-await-in-loop
                    toId = await lookupEntityIdInDoc(docId, toType, toName);
                }
                if (!fromId || !toId) continue;
                try {
                    const ok = await insertEdge({
                        docId,
                        relationTypeCode: relCode,
                        fromId,
                        toId,
                        confidence: ed.confidence,
                        propsJson: stringifyProps(ed.properties ?? ed.properties_json)
                    });
                    if (ok) edgesInserted += 1;
                } catch (err) {
                    errors.push(`chunk ${i} edge ${relCode}: ${(err && err.message) || err}`);
                }
            }
            chunksProcessed += 1;
        } catch (e) {
            errors.push(`chunk ${i}: ${(e && e.message) || e}`);
        }
    }

    return {
        skipped: false,
        chunksProcessed,
        chunksTotal: chunks.length,
        chunksCapped: limit,
        entitiesTouched,
        edgesInserted,
        errors: errors.slice(0, 30)
    };
};

module.exports = {
    isKgExtractEnabled,
    deleteKgDataForDocId,
    extractAndPersistKgForIngest
};
