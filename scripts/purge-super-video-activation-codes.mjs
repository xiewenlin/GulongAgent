import dns from "node:dns";
import { inspectRetiredActivationCodes, purgeRetiredActivationCodes } from "../server/activation-retirement.js";

if (process.env.GULONG_MAINTENANCE_DNS) dns.setServers([process.env.GULONG_MAINTENANCE_DNS]);
const apply = process.argv.includes("--apply");
const expectedArgument = process.argv.find((argument) => argument.startsWith("--expected-count="));
const expectedCount = expectedArgument ? Number(expectedArgument.slice("--expected-count=".length)) : NaN;
const current = await inspectRetiredActivationCodes();
process.stdout.write(JSON.stringify({ mode: apply ? "apply-preflight" : "dry-run", count: current.count, statuses: current.statuses, activeBindings: current.activeBindings, inFlightTasks: current.inFlightTasks }) + "\n");
if (apply) {
  const result = await purgeRetiredActivationCodes({ expectedCount });
  const after = await inspectRetiredActivationCodes();
  process.stdout.write(JSON.stringify({ mode: "verified", ...result, remaining: after.count }) + "\n");
  if (after.count) process.exitCode = 1;
}
process.exit(process.exitCode || 0);
