// Runs the Python verifier in docs/test-vectors. It is a second implementation
// of the format that shares no code with this package. Skipped where Python or
// its "cryptography" package is not installed.
//
// Two checks. The first runs it over the published vectors. The second gives
// both implementations thousands of offers the vectors do not contain and
// requires the same verdict on every one, so that a rule the specification
// leaves open shows up as a disagreement instead of going unnoticed.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { assertValidOffer, createSignedOffer, verifyOffer } from "../src/index.js";
import { mutations, randomOfferInput, sequence } from "./helpers/offer-corpus.js";

const verifier = fileURLToPath(new URL("../../../docs/test-vectors/verify.py", import.meta.url));
const vectors = JSON.parse(await readFile(new URL("../../../docs/test-vectors/v1.json", import.meta.url), "utf8"));

function pythonCanVerify() {
  try {
    execFileSync("python3", ["-c", "import cryptography"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const skip = pythonCanVerify() ? false : "python3 with the cryptography package is not available";

test("an independent implementation agrees on every conformance vector", { skip }, async () => {
  const { stdout } = await promisify(execFile)("python3", ["-B", verifier]).catch((error) => {
    assert.fail(`the independent verifier disagrees:\n${error.stdout ?? error.message}`);
  });
  assert.match(stdout, /^\d+ checks passed, 0 failed/m);
});

test("both implementations give the same verdict on offers changed in one place", { skip }, async () => {
  // Each valid offer of the vectors, changed in one place, as the JSON text
  // both sides read.
  const cases = [];
  for (const vector of vectors.valid_offers) {
    for (const [label, offer] of mutations(vector.offer)) {
      cases.push({ label: `${vector.name}: ${label}`, json: JSON.stringify(offer) });
    }
  }
  assert.ok(cases.length > 10_000, `only ${cases.length} offers were produced`);

  const theirs = await judge("--offers", cases.map((entry) => entry.json));
  const disagreements = [];
  let accepted = 0;
  for (const [index, entry] of cases.entries()) {
    const mine = formVerdict(JSON.parse(entry.json));
    const [verdict, reason = ""] = theirs[index].split("\t");
    if (verdict === "accept") accepted += 1;
    if ((mine === undefined) !== (verdict === "accept")) {
      disagreements.push(`${entry.label}\n    this package: ${mine ?? "accept"}\n    the verifier: ${verdict} ${reason}`);
    }
  }

  assert.equal(disagreements.length, 0, `${disagreements.length} disagreements, the first of them:\n${disagreements.slice(0, 8).join("\n")}`);
  // The comparison is only worth something if both verdicts occur often.
  assert.ok(accepted > 1000, `only ${accepted} offers were accepted`);
  assert.ok(cases.length - accepted > 5000, `only ${cases.length - accepted} offers were refused`);
});

test("the independent implementation verifies offers this package signs, and refuses them altered", { skip }, async () => {
  const random = sequence(20261123);
  const key = vectors.keys.offer;
  const offers = [];
  while (offers.length < 150) {
    try {
      offers.push(createSignedOffer(randomOfferInput(random, key.public_key_pem, vectors.now), key.private_key_pem, { now: vectors.now }));
    } catch (error) {
      // The generator sometimes asks for terms the format rules out.
      assert.ok(error.code, error.stack);
    }
  }
  // Still well formed, so only the ID or the signature can give each away.
  const altered = offers.flatMap((offer) => [
    { ...offer, single_use: !offer.single_use && !offer.recurrence, description: "Altered" },
    { ...offer, offer_id: `0x${"0".repeat(64)}` },
    { ...offer, signature: { scheme: "ed25519", value: offers[(offers.indexOf(offer) + 1) % offers.length].signature.value } }
  ]);

  const genuine = await judge("--signed-offers", offers.map((offer) => JSON.stringify(offer)));
  const forged = await judge("--signed-offers", altered.map((offer) => JSON.stringify(offer)));

  for (const [index, verdict] of genuine.entries()) {
    assert.equal(verdict, "accept", JSON.stringify(offers[index]));
    assert.equal(verifyOffer(offers[index]).ok, true);
  }
  for (const [index, verdict] of forged.entries()) {
    assert.match(verdict, /^refuse\t/, JSON.stringify(altered[index]));
    assert.equal(verifyOffer(altered[index]).ok, false);
  }
});

// This package's verdict on an offer's form: undefined when it accepts, or
// the error code. The ID and the signature are not checked, as with --offers.
function formVerdict(offer) {
  try {
    assertValidOffer(offer, { requireSignature: true });
    return undefined;
  } catch (error) {
    return error.code ?? `threw ${error.message}`;
  }
}

// Sends one JSON text per line to the verifier and returns its verdict lines.
function judge(mode, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-B", verifier, mode], { stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const verdicts = Buffer.concat(output).toString("utf8").split("\n").slice(0, -1);
      if (code !== 0 || verdicts.length !== lines.length) {
        reject(
          new Error(
            `the verifier stopped with code ${code} after ${verdicts.length} of ${lines.length} offers:\n` +
              `${Buffer.concat(errors).toString("utf8").slice(-2000)}\nlast offer judged: ${lines[verdicts.length - 1]}\nnext: ${lines[verdicts.length]}`
          )
        );
        return;
      }
      resolve(verdicts);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`${lines.join("\n")}\n`);
  });
}
