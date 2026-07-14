export * from "./index.js";

import type { RecurringApproval, RecurringApprovalStore } from "./index.js";

export class JsonFileRecurringApprovalStore implements RecurringApprovalStore {
  constructor(path: string);
  list(): Promise<RecurringApproval[]>;
  get(id: string): Promise<RecurringApproval | undefined>;
  put(approval: RecurringApproval): Promise<RecurringApproval>;
}
