/* Reconciler — completeness guarantee: sweep open PRs, enqueue missing SHAs. M7. */
import { NotImplementedError } from "../../core";

function main(): void {
  console.error(new NotImplementedError("reconciler sweep (M7)").message);
  process.exitCode = 1;
}

main();
