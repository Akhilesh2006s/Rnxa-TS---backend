import { createApp } from "./app.js";
import { config } from "./config.js";
import { startReminderScheduler } from "./services/reminders.js";

createApp().listen(config.port, () => {
  console.log(`RNXA Timesheet API listening on http://localhost:${config.port}`);
  startReminderScheduler();
  if (!config.rewrite.apiKey) console.warn("ANTHROPIC_API_KEY is not set: 'Rewrite professionally' will report unavailable.");
});
