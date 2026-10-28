// Drives the real key screen with a stub check, for the terminal test.
import { CnError } from "../../dist/lib/errors.js";
import { keyEntry } from "../../dist/lib/ui/onboarding.js";

const result = await keyEntry({
  verify: async (key) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (key.includes("bad"))
      throw new CnError("Concentrate AI rejected this API key (HTTP 401)");
  },
});
process.stdout.write("\nRESULT " + JSON.stringify(result) + "\n");
