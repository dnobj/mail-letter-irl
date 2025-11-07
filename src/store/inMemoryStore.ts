import { UserAccount } from "../contracts/types.js";

export class InMemoryAccountStore {
  private accounts = new Map<string, UserAccount>();

  getOrCreate(userId: string): UserAccount {
    const existing = this.accounts.get(userId);
    if (existing) {
      return existing;
    }

    const account: UserAccount = {
      userId,
      creditsRemaining: 5,
      orders: []
    };

    this.accounts.set(userId, account);
    return account;
  }

  async persist(account: UserAccount): Promise<void> {
    this.accounts.set(account.userId, account);
  }
}
