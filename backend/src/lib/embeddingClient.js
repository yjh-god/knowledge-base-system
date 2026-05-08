const crypto = require("crypto");
const { formatFetchError } = require("./fetchErrorDetail");

const normalizeBaseUrl = (baseUrl) => {
    if (!baseUrl) return baseUrl;
    return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
};

const withTimeout = async (promise, timeoutSeconds, abortController) => {
    const timeoutMs = Math.max(1, Number(timeoutSeconds) * 1000);
    const timeout = new Promise((_, reject) => {
        setTimeout(() => {
            abortController.abort();
            reject(new Error("Embedding request timeout"));
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]);
};

const embedTextsOpenAICompatible = async ({
    baseUrl,
    apiKey,
    model,
    texts
}) => {
    const url = `${normalizeBaseUrl(baseUrl)}/embeddings`;
    const abortController = new AbortController();

    const headers = {
        "Content-Type": "application/json"
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const body = {
        input: texts
    };
    if (model) body.model = model;

    const timeoutSeconds = process.env.EMBEDDING_TIMEOUT_SECONDS
        ? Number(process.env.EMBEDDING_TIMEOUT_SECONDS)
        : 60;

    let res;
    try {
        res = await withTimeout(
            fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: abortController.signal
            }),
            timeoutSeconds,
            abortController
        );
    } catch (err) {
        if (err && err.message === "Embedding request timeout") throw err;
        throw new Error(`Embedding ${formatFetchError(url, err)}`);
    }

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Embedding API error: ${res.status} ${text}`.slice(0, 500));
    }

    const json = await res.json();

    // OpenAI-compatible: { data: [ { embedding: [...] }, ... ] }
    const data = json?.data;
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error("Embedding API response format not recognized (missing data[].embedding)");
    }
    const embeddings = data.map((d) => d.embedding);

    if (!embeddings.every((e) => Array.isArray(e))) {
        throw new Error("Embedding API response embedding field not recognized");
    }

    return embeddings;
};

const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

const batchEmbed = async ({ baseUrl, apiKey, model, texts, batchSize }) => {
    const embeddings = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        // eslint-disable-next-line no-await-in-loop
        const batchEmbeddings = await embedTextsOpenAICompatible({
            baseUrl,
            apiKey,
            model,
            texts: batch
        });
        embeddings.push(...batchEmbeddings);
    }
    return embeddings;
};

const embedTexts = async (texts) => {
    const baseUrl = process.env.EMBEDDING_API_BASE_URL;
    if (!baseUrl) throw new Error("Missing EMBEDDING_API_BASE_URL");

    const apiKey = process.env.EMBEDDING_API_KEY || "";
    const model = process.env.EMBEDDING_MODEL || "";
    const batchSize = process.env.EMBEDDING_BATCH_SIZE ? Number(process.env.EMBEDDING_BATCH_SIZE) : 16;

    const t = texts.map((x) => (typeof x === "string" ? x : String(x)));
    // eslint-disable-next-line no-unused-vars
    const _hash = sha256Hex(t.join("\n\n"));

    return batchEmbed({ baseUrl, apiKey, model, texts: t, batchSize });
};

module.exports = { embedTexts };

