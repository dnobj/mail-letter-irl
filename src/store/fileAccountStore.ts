import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { UserAccount } from "../contracts/types.js";

interface FileStoreOptions {
  filePath?: string;
  initialCredits?: number;
}

export class FileAccountStore {
  private accounts = new Map<string, UserAccount>();
  private readonly filePath: string;
  private readonly initialCredits: number;
  private writeInFlight: Promise<void> | null = null;

  constructor(options: FileStoreOptions = {}) {
    this.filePath = resolve(process.cwd(), options.filePath ?? "data/accounts.json");
    this.initialCredits = options.initialCredits ?? 5;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.accounts.size > 0 || this.writeInFlight !== null) {
      return;
    }

    try {
      const contents = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(contents) as Record<string, UserAccount>;
      for (const [userId, account] of Object.entries(parsed)) {
        this.accounts.set(userId, account);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.persistAll();
        return;
      }
      throw error;
    }
  }

  private async persistAll(): Promise<void> {
    const payload: Record<string, UserAccount> = {};
    for (const [userId, account] of this.accounts) {
      payload[userId] = account;
    }

    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(payload, null, 2);
    await fs.writeFile(this.filePath, json, "utf-8");
  }

  private schedulePersist(): Promise<void> {
    if (!this.writeInFlight) {
      this.writeInFlight = (async () => {
        try {
          await this.persistAll();
        } finally {
          this.writeInFlight = null;
        }
      })();
    }
    return this.writeInFlight;
  }

  async getOrCreate(userId: string): Promise<UserAccount> {
    await this.ensureLoaded();
    const existing = this.accounts.get(userId);
    if (existing) {
      return existing;
    }

    const account: UserAccount = {
      userId,
      creditsRemaining: this.initialCredits,
      orders: []
    };

    this.accounts.set(userId, account);
    await this.schedulePersist();
    return account;
  }

  async persist(account: UserAccount): Promise<void> {
    this.accounts.set(account.userId, account);
    await this.schedulePersist();
  }
}
