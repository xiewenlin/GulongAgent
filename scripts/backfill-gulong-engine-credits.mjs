import dns from "node:dns";
import { reconcileApprovedGulongEngineOrders } from "../server/gulong-engine-billing.js";

if (process.env.GULONG_MAINTENANCE_DNS) dns.setServers([process.env.GULONG_MAINTENANCE_DNS]);
const apply = process.argv.includes("--apply");
const summary = await reconcileApprovedGulongEngineOrders({ apply });
process.stdout.write(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...summary }) + "\n");
process.exit(summary.invalid ? 1 : 0);
