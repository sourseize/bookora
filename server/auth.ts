import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { db } from "./db.js";

const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;
export const SESSION_COOKIE = "bookora_session";
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export type UserRole = "owner" | "staff" | "customer";

export interface AuthUser {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: UserRole;
  business_id: string | null;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  businessId: string | null;
  businessName: string | null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: MAX_MEMORY,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("hex"),
    key.toString("hex"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [, cost, blockSize, parallelization, saltHex, keyHex] =
    encoded.split("$");
  if (
    cost !== String(SCRYPT_COST) ||
    blockSize !== String(SCRYPT_BLOCK_SIZE) ||
    parallelization !== String(SCRYPT_PARALLELIZATION) ||
    !/^[a-f0-9]{32}$/i.test(saltHex ?? "") ||
    !/^[a-f0-9]{128}$/i.test(keyHex ?? "")
  ) {
    return false;
  }

  const expected = Buffer.from(keyHex, "hex");
  const actual = await deriveKey(password, Buffer.from(saltHex, "hex"));
  return timingSafeEqual(actual, expected);
}

export async function verifyUnknownAccountPassword(
  password: string,
): Promise<void> {
  await deriveKey(password, Buffer.from("bookora-login-dummy-salt"));
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createSession(userId: string): {
  id: string;
  token: string;
  expiresAt: string;
} {
  const id = randomUUID();
  const token = createOpaqueToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, userId, hashToken(token), expiresAt, now.toISOString());
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(
    now.toISOString(),
  );
  return { id, token, expiresAt };
}

export function findPublicUser(user: AuthUser): PublicUser {
  const business = user.business_id
    ? db
        .prepare("SELECT id, name FROM businesses WHERE id = ?")
        .get(user.business_id) as { id: string; name: string } | undefined
    : undefined;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    businessId: user.business_id,
    businessName: business?.name ?? null,
  };
}

export function setSessionCookie(
  res: import("express").Response,
  token: string,
): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_DURATION_MS,
  });
}

export function clearSessionCookie(res: import("express").Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  });
}
