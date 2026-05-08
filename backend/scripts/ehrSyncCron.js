/* Daily EHR sync at 02:00 (default, PRD §12.3)
   Run manually or via scheduler:
   node backend/scripts/ehrSyncCron.js
*/

const { syncEhrToSql } = require("../src/services/ehrSync");

const getNextRunTime = (hour = 2, minute = 0) => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) {
        next.setDate(next.getDate() + 1);
    }
    return next;
};

const main = async () => {
    const source = process.env.EHR_SYNC_SOURCE || "mock";
    // eslint-disable-next-line no-console
    console.log(`EHR sync scheduler started. Source=${source}`);

    const tick = async () => {
        try {
            // eslint-disable-next-line no-console
            console.log("Running EHR sync...");
            await syncEhrToSql({ source });
            // eslint-disable-next-line no-console
            console.log("EHR sync finished.");
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error("EHR sync failed:", e);
        }
    };

    const scheduleNext = () => {
        const next = getNextRunTime(2, 0);
        const delay = next.getTime() - Date.now();
        // eslint-disable-next-line no-console
        console.log("Next EHR sync at:", next.toISOString());
        setTimeout(async () => {
            await tick();
            scheduleNext();
        }, delay);
    };

    await tick();
    scheduleNext();
};

main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error("Fatal:", e);
    process.exit(1);
});

