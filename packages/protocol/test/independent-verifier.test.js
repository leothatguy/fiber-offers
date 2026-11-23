// Runs the Python verifier in docs/test-vectors against the published vectors.
// It is a second implementation of the format that shares no code with this
// package. Skipped where Python or its "cryptography" package is not installed.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const verifier = fileURLToPath(new URL("../../../docs/test-vectors/verify.py", import.meta.url));

function pythonCanVerify() {
  try {
    execFileSync("python3", ["-c", "import cryptography"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test(
  "an independent implementation agrees on every conformance vector",
  { skip: pythonCanVerify() ? false : "python3 with the cryptography package is not available" },
  async () => {
    const { stdout } = await promisify(execFile)("python3", [verifier]).catch((error) => {
      assert.fail(`the independent verifier disagrees:\n${error.stdout ?? error.message}`);
    });
    assert.match(stdout, /^\d+ checks passed, 0 failed/m);
  }
);
