// A light "parent PIN" layer. Hearth can't rely on voice ID yet, so a short PIN stands in for it —
// but only for parent-level things (another person's private view, a child's progress, deleting).
// Everyday journaling never asks for it, and the dashboard asks once per browser session.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { findMember, memberById, type Member } from "./db.js";

const SECRET = process.env.HEARTH_SECRET ?? randomBytes(32).toString("hex"); // random = sessions end on restart
const SESSION_HOURS = 12;

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function pinMatches(member: Member, pin: string | undefined | null): boolean {
  if (!member.pin_hash) return true; // this person chose not to use a PIN
  if (!pin) return false;
  const [salt, hash] = member.pin_hash.split(":");
  const got = scryptSync(String(pin), salt, 32);
  return timingSafeEqual(got, Buffer.from(hash, "hex"));
}

export const hasPin = (m: Member) => !!m.pin_hash;

/** A signed session token: "memberId.expiry.signature". */
export function issueSession(member: Member): { token: string; expires: string } {
  const exp = Date.now() + SESSION_HOURS * 3_600_000;
  const body = `${member.id}.${exp}`;
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return { token: `${body}.${sig}`, expires: new Date(exp).toISOString() };
}

export function readSession(token: string | undefined): Member | null {
  if (!token) return null;
  const [id, exp, sig] = token.split(".");
  if (!id || !exp || !sig) return null;
  const want = createHmac("sha256", SECRET).update(`${id}.${exp}`).digest("base64url");
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  if (Number(exp) < Date.now()) return null;
  return memberById(Number(id)) ?? null;
}

/** Signs a viewer in: checks the PIN (if they set one) and returns a session token. */
export function signIn(name: string, pin: string | undefined): { token: string; expires: string; viewer: string } | null {
  const m = findMember(name);
  if (!m || m.role === "child") return null;
  if (!pinMatches(m, pin)) return null;
  return { ...issueSession(m), viewer: m.name };
}
