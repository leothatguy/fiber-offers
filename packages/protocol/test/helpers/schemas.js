// Loads the published JSON Schemas (docs/schemas/v1) into a validator, for the
// tests that hold the schemas, the conformance vectors and the reference
// resolver to one another.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

export const SCHEMA_DIRECTORY = fileURLToPath(new URL("../../../../docs/schemas/v1/", import.meta.url));

export function readSchemaFiles() {
  return Object.fromEntries(
    readdirSync(SCHEMA_DIRECTORY)
      .filter((name) => name.endsWith(".schema.json"))
      .sort()
      .map((name) => [name, JSON.parse(readFileSync(`${SCHEMA_DIRECTORY}${name}`, "utf8"))])
  );
}

// `strict` makes the validator refuse a schema with a keyword it does not
// know, a misspelt one among them, instead of ignoring it. One strict rule is
// off: it wants every name under `required` declared in that same subschema,
// which the usual `if: { required: [...] }` condition does not do.
export function loadSchemas() {
  const files = readSchemaFiles();
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const schema of Object.values(files)) ajv.addSchema(schema);
  const validators = new Map();

  // `reference` is a file name, optionally with a JSON pointer:
  // "offer.schema.json" or "common.schema.json#/$defs/amount".
  function validatorFor(reference) {
    if (!validators.has(reference)) {
      const [name, pointer = ""] = reference.split("#");
      const file = files[name];
      if (!file) throw new Error(`no schema file named ${name}`);
      const validate = ajv.getSchema(`${file.$id}${pointer ? `#${pointer}` : ""}`);
      if (!validate) throw new Error(`nothing at ${reference}`);
      validators.set(reference, validate);
    }
    return validators.get(reference);
  }

  // Returns undefined when the value fits, or a readable list of what does not.
  function problems(reference, value) {
    const validate = validatorFor(reference);
    if (validate(value)) return undefined;
    return validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  }

  // The same for a schema written inside another document (an OpenAPI
  // description) whose references are relative to the schema files.
  const base = Object.values(files)[0].$id.replace(/[^/]+$/, "");
  let inlineCount = 0;
  const inlineValidators = new Map();
  function problemsWith(schema, value) {
    if (typeof schema?.$ref === "string" && Object.keys(schema).length === 1 && !schema.$ref.startsWith("#")) {
      return problems(schema.$ref, value);
    }
    if (!inlineValidators.has(schema)) {
      inlineCount += 1;
      inlineValidators.set(schema, ajv.compile({ $id: `${base}inline-${inlineCount}`, ...schema }));
    }
    const validate = inlineValidators.get(schema);
    if (validate(value)) return undefined;
    return validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  }

  return { ajv, files, validatorFor, problems, problemsWith };
}
