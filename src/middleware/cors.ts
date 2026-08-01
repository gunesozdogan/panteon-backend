import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

/**
 * Minimal CORS middleware — no dependency, just the headers a browser needs to
 * let the separate frontend origin read our JSON. Allowed origins come from
 * `CORS_ORIGINS` (env); `*` allows any (dev convenience only). Echoing the exact
 * request origin (rather than `*`) keeps `Vary: Origin` caches correct and stays
 * compatible if credentials are ever added.
 *
 * Simple GETs only need `Access-Control-Allow-Origin` on the response; the JSON
 * `POST /events/earn` triggers a preflight, so we also answer `OPTIONS` here.
 */
const allowed = new Set(env.CORS_ORIGINS);
const allowAny = allowed.has('*');

export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  if (origin && (allowAny || allowed.has(origin))) {
    res.setHeader('Access-Control-Allow-Origin', allowAny ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
}
