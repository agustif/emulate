import { DEVICE_REGISTRY, SERVICE_REGISTRY } from "../registry.js";

export function listCommand(): void {
  console.log("\nAvailable services:\n");
  for (const [name, entry] of Object.entries(SERVICE_REGISTRY)) {
    console.log(`  ${name.padEnd(10)}${entry.label}`);
    console.log(`            Endpoints: ${entry.endpoints}`);
    console.log();
  }

  console.log("Available devices:\n");
  for (const [name, entry] of Object.entries(DEVICE_REGISTRY)) {
    console.log(`  ${name.padEnd(10)}${entry.label}`);
  }
  console.log();
}
