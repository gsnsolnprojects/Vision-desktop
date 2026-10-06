/**
 * Accounts that signed in on this station, for one-click account selection on the sign-in screen.
 * Only identity details are stored — never passwords or tokens.
 */
export interface RememberedAccount {
  email: string;
  name: string | null;
  role: string | null;
  company: string | null;
  lastUsedAt: string;
}

const KEY = "station.rememberedAccounts.v1";
const MAX_ACCOUNTS = 8;

export function listRememberedAccounts(): RememberedAccount[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RememberedAccount[]) : [];
    return Array.isArray(list) ? list.filter((a) => a && typeof a.email === "string").sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)) : [];
  } catch {
    return [];
  }
}

function write(list: RememberedAccount[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* convenience only */
  }
}

export function rememberAccount(account: Omit<RememberedAccount, "lastUsedAt">): void {
  const email = account.email.trim().toLowerCase();
  const others = listRememberedAccounts().filter((a) => a.email.toLowerCase() !== email);
  write([{ ...account, email, lastUsedAt: new Date().toISOString() }, ...others].slice(0, MAX_ACCOUNTS));
}

export function forgetAccount(email: string): void {
  write(listRememberedAccounts().filter((a) => a.email.toLowerCase() !== email.toLowerCase()));
}
