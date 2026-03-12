import { runPreflightCheck, formatPreflightReport } from "../src/cdp/CdpPreflightCheck";

async function main(): Promise<void> {
  console.log("Running CDP preflight check...\n");
  const report = await runPreflightCheck();
  console.log(formatPreflightReport(report));

  if (!report.connectivity.reachable) {
    process.exit(1);
  }

  const hasBrokenSelectors =
    report.selectors.chatInput.matches === 0 ||
    !report.selectors.chatInput.hasVisible;

  if (hasBrokenSelectors) {
    console.log("\n*** SELECTOR ISSUES DETECTED ***");
    console.log("The bridge may not function correctly until selectors are updated.");
    console.log("Copy suggested selectors into your .env file to fix.\n");
    process.exit(2);
  }
}

main().catch((error) => {
  console.error("Preflight check failed:", error);
  process.exit(1);
});
