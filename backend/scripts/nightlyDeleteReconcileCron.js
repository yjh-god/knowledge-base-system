/* Daily 01:00 nightly delete reconciliation (PRD §5.5 / G3)
   Run: node backend/scripts/nightlyDeleteReconcileCron.js
*/

const { spawn } = require("child_process");

const getNextRunTime = (hour = 1, minute = 0) => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
};

const main = async () => {
    // eslint-disable-next-line no-console
    console.log("Nightly delete reconcile scheduler started.");

    const tick = async () => {
        // nightlyDeleteReconcile.js is a self-executing script; use spawn to avoid module cache issues.
        // eslint-disable-next-line no-console
        console.log("Running reconcile tick (ensure env vars set).");
        const child = spawn(
            "node",
            ["backend/scripts/nightlyDeleteReconcile.js"],
            {
                cwd: process.cwd(),
                stdio: "inherit",
                shell: false
            }
        );

        await new Promise((resolve) => {
            child.on("exit", () => resolve());
        });
    };

    const scheduleNext = () => {
        const next = getNextRunTime(1, 0);
        const delay = next.getTime() - Date.now();
        // eslint-disable-next-line no-console
        console.log("Next reconcile at:", next.toISOString());
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

