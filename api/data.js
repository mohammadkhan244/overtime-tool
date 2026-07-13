const { kv } = require('@vercel/kv');

const KEY = 'ot-tracker';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // GET — return stored data (or null if nothing saved yet)
  if (req.method === 'GET') {
    try {
      const data = await kv.get(KEY);
      return res.status(200).json(data ?? null);
    } catch (err) {
      console.error('[api/data] GET error:', err);
      return res.status(500).json({ error: 'Failed to load data' });
    }
  }

  // POST — overwrite stored data with request body
  if (req.method === 'POST') {
    try {
      // Vercel auto-parses JSON bodies; handle both object and raw string
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || !Array.isArray(body.shifts)) {
        return res.status(400).json({ error: 'Invalid payload: missing shifts array' });
      }
      // Store only the four known keys — no passthrough of unknown fields
      await kv.set(KEY, {
        shifts:   body.shifts,
        salary:   body.salary   ?? { gross: 0, net: 0 },
        ptoBank:  body.ptoBank  ?? { initialBalance: 0, taken: [] },
        settings: body.settings ?? { ptoRatio: 1, otMultipliers: [1.5, 2], weekendBonusFlat: 0 },
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[api/data] POST error:', err);
      return res.status(500).json({ error: 'Failed to save data' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
