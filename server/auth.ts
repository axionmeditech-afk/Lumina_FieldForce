import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

type JwtPayload = {
  sub: string;
  role: "admin" | "hr" | "manager" | "salesperson";
  email: string;
  iat: number;
  exp: number;
};

function base64UrlEncode(input: Buffer | string): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  let payload = input.replace(/-/g, "+").replace(/_/g, "/");
  while (payload.length % 4 !== 0) payload += "=";
  return Buffer.from(payload, "base64");
}

function getJwtSecret(): string {
  return process.env.JWT_SECRET || "trackforce_dev_secret_change_me";
}

export function signJwt(payload: Omit<JwtPayload, "iat" | "exp">, expiresInSec = 60 * 60 * 24 * 7): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSec,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", getJwtSecret()).update(data).digest();
  return `${data}.${base64UrlEncode(signature)}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const data = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac("sha256", getJwtSecret()).update(data).digest();
  const actual = base64UrlDecode(encodedSignature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as JwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

declare global {
  namespace Express {
    interface Request {
      auth?: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.header("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearer) {
    res.status(401).json({ message: "Missing Authorization bearer token" });
    return;
  }
  const payload = verifyJwt(bearer);
  if (!payload) {
    res.status(401).json({ message: "Invalid or expired token" });
    return;
  }
  req.auth = payload;
  next();
}

export function requireRoles(...roles: Array<JwtPayload["role"]>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.auth?.role;
    if (!role || !roles.includes(role)) {
      res.status(403).json({ message: "Insufficient permissions" });
      return;
    }
    next();
  };
}
