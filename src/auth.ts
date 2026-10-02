import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { dataDir } from "./bot-store";
import type { IRequest, IResponse } from "./server-common";

export function loadOrCreateToken(): string {
  const environmentToken = process.env.GITBOT_TOKEN?.trim();
  if (environmentToken) return environmentToken;

  const directory = dataDir();
  const tokenPath = join(directory, "token");
  if (existsSync(tokenPath)) {
    const storedToken = readFileSync(tokenPath, "utf-8").trim();
    if (storedToken) return storedToken;
  }

  mkdirSync(directory, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, token, { encoding: "utf-8", mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return token;
}

function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (!candidate || !token) return false;
  const candidateBuffer = Buffer.from(candidate);
  const tokenBuffer = Buffer.from(token);
  if (candidateBuffer.length !== tokenBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, tokenBuffer);
}

export function authCookieName(token: string): string {
  return `gitbot_token_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
}

export function isAuthorized(req: IRequest, token: string): boolean {
  const authorization = req.headers.authorization;
  const authorizationHeader = Array.isArray(authorization) ? authorization[0] : authorization;
  const bearerToken = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (tokenMatches(bearerToken, token)) return true;

  const cookieHeader = req.headers.cookie;
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader) ?? "";
  const cookieName = authCookieName(token);
  const cookieToken = cookie.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return tokenMatches(cookieToken, token);
}

export function handleTokenBootstrap(req: IRequest, res: IResponse, token: string): boolean {
  if (req.method !== "GET") return false;

  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.searchParams.has("token")) return false;
  if (!tokenMatches(url.searchParams.get("token") ?? undefined, token)) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Invalid GitBot token");
    return true;
  }

  url.searchParams.delete("token");
  res.writeHead(302, {
    Location: `${url.pathname}${url.search}`,
    "Set-Cookie": `${authCookieName(token)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
  });
  res.end();
  return true;
}
