/* Webhook ingress — thin, always-on-able receiver. Implemented in M6. */
import { NotImplementedError } from "../../core";

function main(): void {
  console.error(new NotImplementedError("ingress HTTP server (M6)").message);
  process.exitCode = 1;
}

main();
