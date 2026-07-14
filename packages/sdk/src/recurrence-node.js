import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class JsonFileRecurringApprovalStore {
  constructor(path) {
    if (!path) throw new Error("JsonFileRecurringApprovalStore requires a path");
    this.path = resolve(path);
    this.mutations = Promise.resolve();
  }

  async list() {
    return structuredClone(await this.#read());
  }

  async get(id) {
    const approval = (await this.#read()).find((item) => item.id === id);
    return approval ? structuredClone(approval) : undefined;
  }

  async put(approval) {
    const mutation = this.mutations.then(async () => {
      const approvals = await this.#read();
      const index = approvals.findIndex((item) => item.id === approval.id);
      if (index < 0) approvals.push(structuredClone(approval));
      else approvals[index] = structuredClone(approval);
      await this.#write(approvals);
      return structuredClone(approval);
    });
    this.mutations = mutation.catch(() => {});
    return mutation;
  }

  async #read() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(value)) throw new Error("recurring approval file is invalid");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async #write(approvals) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(approvals, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}
