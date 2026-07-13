import "dotenv/config";
import { getConfig } from "./config.js";
import { createControlApp } from "./control-app.js";

const config = getConfig();
const app = createControlApp(config);

try {
  await app.listen({ host: config.controlHost, port: config.controlPort });
  app.log.info({ host: config.controlHost, port: config.controlPort }, "Camera control server started");
} catch (error) {
  app.log.error({ err: error }, "Failed to start camera control server");
  process.exit(1);
}
