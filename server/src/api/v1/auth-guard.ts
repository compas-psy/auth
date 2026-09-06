import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyAccessToken } from "../../services/tokens.js";
import { sha256 } from "../../lib/hash.js";

export interface Caller {
  accountId: string;
  sessionId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    caller?: Caller;
  }
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !value) return null;
  return value.trim();
}

/**
 * Единая проверка доступа к публичному API v1.
 *
 * Токен принимается двух видов, и оба ведут в одну и ту же личность:
 *  - наш access первичного токен-API (мобильные приложения);
 *  - access, выпущенный по OIDC (веб-продукты и портал).
 *
 * Второй проверяется средствами самой библиотеки, а не разбором строки
 * руками: своей проверки токенов мы не пишем.
 */
export function requireCaller(app: FastifyInstance) {
  return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = bearer(req);
    if (!token) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const own = await verifyAccessToken(token);
    if (own) {
      req.caller = own;
      return;
    }

    try {
      const at = await app.oidc.AccessToken.find(token);
      if (at && at.accountId && !at.isExpired) {
        req.caller = { accountId: at.accountId, sessionId: null };
        return;
      }
    } catch {
      // Непроходящий токен — это 401, а не 500.
    }

    await reply.code(401).send({ error: "unauthorized" });
  };
}

/** Огрублённые сведения о запросе. IP и полный user-agent не сохраняются. */
export function requestContext(req: FastifyRequest): {
  ipHash?: string;
  uaHash?: string;
} {
  const ip = req.ip;
  const ua = req.headers["user-agent"];
  return {
    ipHash: ip ? sha256(ip) : undefined,
    uaHash: typeof ua === "string" ? sha256(ua) : undefined,
  };
}
