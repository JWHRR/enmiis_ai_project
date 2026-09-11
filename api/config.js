import { describeConfig } from '../server/config.js';

/**
 * GET /api/config — Vercel serverless entry point.
 *
 * Reports presence of credentials and the runtime mode. It never returns a
 * token value: `describeConfig()` exposes booleans only.
 */
export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(describeConfig());
}
