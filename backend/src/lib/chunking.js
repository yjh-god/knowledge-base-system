const chunkText = (text, { chunkSize, chunkOverlap }) => {
    const cleaned = text.replace(/\r\n/g, "\n");
    const overlap = Math.max(0, Math.min(chunkOverlap, chunkSize - 1));
    const step = chunkSize - overlap;
    const chunks = [];

    let index = 0;
    for (let start = 0; start < cleaned.length; start += step) {
        const end = Math.min(start + chunkSize, cleaned.length);
        const slice = cleaned.slice(start, end);
        chunks.push({
            chunkIndex: index,
            text: slice,
            charStart: start,
            charEnd: end
        });
        index += 1;
        if (end >= cleaned.length) break;
    }

    return chunks;
};

const defaultChunking = {
    chunkSize: 1000,
    chunkOverlap: 200
};

module.exports = { chunkText, defaultChunking };

