import "dotenv/config";
import { getConfig } from "./config.js";
import { createApp } from "./app.js";

const config = getConfig();
const app = createApp(config);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ host: config.host, port: config.port }, "Camera edge API started");
} catch (error) {
  app.log.error({ err: error }, "Failed to start camera edge API");
  process.exit(1);
}
