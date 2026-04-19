import { CredentialRecord, ICredentialStore } from "../types.js";

/**
 * Single-process credential store. Swap for a DB-backed ICredentialStore
 * in production — this implementation loses every record on restart.
 */
export class InMemoryCredentialStore implements ICredentialStore {
  private _byId: Map<string, CredentialRecord> = new Map();

  async put(record: CredentialRecord): Promise<void> {
    this._byId.set(record.credentialId, { ...record });
  }

  async getById(credentialId: string): Promise<CredentialRecord | null> {
    const r = this._byId.get(credentialId);
    return r ? { ...r } : null;
  }

  async listByUser(userId: string): Promise<CredentialRecord[]> {
    const out: CredentialRecord[] = [];
    for (const r of this._byId.values()) {
      if (r.userId === userId) out.push({ ...r });
    }
    return out;
  }

  async updateCounter(credentialId: string, counter: number): Promise<void> {
    const r = this._byId.get(credentialId);
    if (r) r.counter = counter;
  }
}
