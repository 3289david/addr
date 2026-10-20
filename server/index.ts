import { config } from "./config.ts";
import { createServer } from "./http.ts";
import { registerRoutes } from "./routes.ts";
import { startIndexer } from "./indexer.ts";
import { startWebhookWorker } from "./webhooks.ts";
import { startPaymentsWorker } from "./payments.ts";
import { startMailWorker } from "./mail.ts";
import { deployment, operatorAddress } from "./chain.ts";

registerRoutes();
const server = createServer();
server.listen(config.port, config.host, () => {
  console.log(`ADDR API listening on http://${config.host}:${config.port}`);
  console.log(`chain ${deployment.chainId} registry ${deployment.registry}`);
  console.log(`relayer/operator: ${operatorAddress ?? "none (issuance + paid registrations disabled)"}`);
  console.log(`payable networks: ${Object.keys(config.treasuries).join(", ") || "none (set TREASURY_<NETWORK>)"}`);
});
startIndexer();
startWebhookWorker();
startPaymentsWorker();
startMailWorker();

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => process.exit(0)));
