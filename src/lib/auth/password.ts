import bcrypt from "bcryptjs";

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  // bcryptjs is constant-time internally; a malformed stored hash throws
  // rather than returning, so guard it to keep login timing uniform.
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

/** Minimum policy for accounts that may hold approve or send rights. */
export function checkPasswordStrength(plain: string): PasswordCheck {
  const problems: string[] = [];
  if (plain.length < 12) problems.push("Must be at least 12 characters.");
  if (!/[a-z]/.test(plain)) problems.push("Must include a lowercase letter.");
  if (!/[A-Z]/.test(plain)) problems.push("Must include an uppercase letter.");
  if (!/[0-9]/.test(plain)) problems.push("Must include a digit.");
  return { ok: problems.length === 0, problems };
}
