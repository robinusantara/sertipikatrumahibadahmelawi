import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://jflqadlasztjrhxpivot.supabase.co').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const API_INGEST_KEY = process.env.API_INGEST_KEY || '';

interface RumahIbadahPayload {
  nama: string;
  jenis: string;
  longitude: number;
  latitude: number;
  alamat: string | null;
  keterangan: string | null;
}

function normJenis(v: unknown): string | null {
  const s = String(v ?? '').toLowerCase().trim();
  if (!s) return null;
  if (s.includes('masjid')) return 'Masjid';
  if (/mushol|musol|surau|langgar/.test(s)) return 'Mushola';
  if (/katolik|katholik|katedral/.test(s)) return 'Gereja Katolik';
  if (/protestan|kristen|gereja|gki|gkkb|gpdi|hkbp|gbi|bethel/.test(s)) return 'Gereja Protestan';
  if (s.includes('pura')) return 'Pura';
  if (/vihara|wihara/.test(s)) return 'Vihara';
  if (/klenteng|kelenteng|tridharma|kong hu cu|konghucu/.test(s)) return 'Klenteng';
  return null;
}

function toNumber(v: unknown): number {
  return parseFloat(String(v ?? '').trim().replace(',', '.'));
}

function pickField(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return obj[k];
    }
  }
  return undefined;
}

function normalizeRecord(raw: unknown): { ok: true; data: RumahIbadahPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Item harus berupa objek JSON' };
  }

  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    lower[k.trim().toLowerCase()] = v;
  }

  const namaRaw = pickField(lower, ['nama', 'nama_rumah_ibadah', 'name', 'nama_tempat']);
  const jenisRaw = pickField(lower, ['jenis', 'tipe', 'type', 'kategori', 'category']);
  const lngRaw = pickField(lower, ['longitude', 'lng', 'lon', 'long', 'bujur', 'x']);
  const latRaw = pickField(lower, ['latitude', 'lat', 'lintang', 'y']);
  const alamatRaw = pickField(lower, ['alamat', 'address', 'lokasi']);
  const ketRaw = pickField(lower, ['keterangan', 'ket', 'catatan', 'note', 'notes', 'deskripsi']);

  const nama = String(namaRaw ?? '').trim();
  const jenis = normJenis(jenisRaw);
  const longitude = toNumber(lngRaw);
  const latitude = toNumber(latRaw);

  if (!nama) {
    return { ok: false, error: 'Field "nama" wajib diisi' };
  }
  if (!jenis) {
    return { ok: false, error: `Field "jenis" ("${String(jenisRaw ?? '')}") tidak dikenali` };
  }
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    return { ok: false, error: 'Field "latitude" tidak valid (-90 s.d. 90)' };
  }
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    return { ok: false, error: 'Field "longitude" tidak valid (-180 s.d. 180)' };
  }

  return {
    ok: true,
    data: {
      nama,
      jenis,
      longitude: Math.round(longitude * 1e6) / 1e6,
      latitude: Math.round(latitude * 1e6) / 1e6,
      alamat: alamatRaw !== undefined ? String(alamatRaw).trim() : null,
      keterangan: ketRaw !== undefined ? String(ketRaw).trim() : null,
    },
  };
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_INGEST_KEY) {
    return next();
  }
  const headerKey = req.header('x-api-key');
  const authHeader = req.header('authorization') || '';
  const bearerKey = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (headerKey === API_INGEST_KEY || bearerKey === API_INGEST_KEY) {
    return next();
  }
  res.status(401).json({ ok: false, error: 'Unauthorized: API key tidak valid atau tidak disertakan' });
}

function supabaseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function startServer() {
  const app = express();

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use('/api', express.json({ limit: '5mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'WebGIS Rumah Ibadah API',
      supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_KEY),
      apiKeyProtected: Boolean(API_INGEST_KEY),
    });
  });

  // READ: Ambil daftar rumah ibadah dari Supabase
  app.get('/api/rumah-ibadah', async (req: Request, res: Response) => {
    if (!SUPABASE_KEY) {
      res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi di server' });
      return;
    }

    try {
      const params = new URLSearchParams({ select: '*', order: 'id.asc' });
      const jenisFilter = typeof req.query.jenis === 'string' ? normJenis(req.query.jenis) : null;
      if (jenisFilter) {
        params.set('jenis', `eq.${jenisFilter}`);
      }
      const limit = Number(req.query.limit);
      if (Number.isFinite(limit) && limit > 0) {
        params.set('limit', String(Math.min(limit, 1000)));
      }
      const offset = Number(req.query.offset);
      if (Number.isFinite(offset) && offset >= 0) {
        params.set('offset', String(offset));
      }

      const r = await fetch(`${SUPABASE_URL}/rest/v1/rumah_ibadah?${params.toString()}`, {
        headers: supabaseHeaders(),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        res.status(r.status).json({ ok: false, error: body?.message || 'Gagal membaca data dari Supabase', details: body });
        return;
      }

      res.json({ ok: true, count: Array.isArray(body) ? body.length : 0, data: body });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Gagal menghubungi Supabase' });
    }
  });

  // CREATE / UPSERT: Terima 1 objek atau array data dari database/sistem lain
  app.post('/api/rumah-ibadah', requireApiKey, async (req: Request, res: Response) => {
    if (!SUPABASE_KEY) {
      res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi di server' });
      return;
    }

    const rawBody = req.body;
    const rawItems: unknown[] = Array.isArray(rawBody)
      ? rawBody
      : rawBody && typeof rawBody === 'object' && Array.isArray((rawBody as { items?: unknown }).items)
        ? (rawBody as { items: unknown[] }).items
        : [rawBody];

    if (!rawItems.length) {
      res.status(400).json({ ok: false, error: 'Payload kosong' });
      return;
    }

    const valid: RumahIbadahPayload[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    rawItems.forEach((item, idx) => {
      const check = normalizeRecord(item);
      if (check.ok) {
        valid.push(check.data);
      } else {
        errors.push({ index: idx, error: check.error });
      }
    });

    if (!valid.length) {
      res.status(400).json({ ok: false, error: 'Semua data tidak valid', errors });
      return;
    }

    const shouldUpdate = req.query.upsert === 'true' || req.query.mode === 'merge';
    const resolution = shouldUpdate ? 'merge-duplicates' : 'ignore-duplicates';

    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rumah_ibadah?on_conflict=nama,latitude,longitude`, {
        method: 'POST',
        headers: supabaseHeaders({
          Prefer: `resolution=${resolution},return=representation`,
        }),
        body: JSON.stringify(valid),
      });

      const body = await r.json().catch(() => null);
      if (!r.ok) {
        res.status(r.status).json({
          ok: false,
          error: body?.message || 'Gagal menyimpan ke Supabase',
          details: body,
        });
        return;
      }

      const saved = Array.isArray(body) ? body : [];
      res.status(201).json({
        ok: true,
        received: rawItems.length,
        valid: valid.length,
        saved: saved.length,
        rejected: errors.length,
        errors: errors.length ? errors : undefined,
        data: saved,
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Gagal menghubungi Supabase' });
    }
  });

  // UPDATE by ID
  app.put('/api/rumah-ibadah/:id', requireApiKey, async (req: Request, res: Response) => {
    if (!SUPABASE_KEY) {
      res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi di server' });
      return;
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ ok: false, error: 'ID tidak valid' });
      return;
    }

    const check = normalizeRecord(req.body);
    if (!check.ok) {
      res.status(400).json({ ok: false, error: check.error });
      return;
    }

    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rumah_ibadah?id=eq.${id}`, {
        method: 'PATCH',
        headers: supabaseHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify(check.data),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        res.status(r.status).json({ ok: false, error: body?.message || 'Gagal memperbarui data', details: body });
        return;
      }
      if (!Array.isArray(body) || !body.length) {
        res.status(404).json({ ok: false, error: 'Data tidak ditemukan' });
        return;
      }
      res.json({ ok: true, data: body[0] });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Gagal menghubungi Supabase' });
    }
  });

  // DELETE by ID
  app.delete('/api/rumah-ibadah/:id', requireApiKey, async (req: Request, res: Response) => {
    if (!SUPABASE_KEY) {
      res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi di server' });
      return;
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ ok: false, error: 'ID tidak valid' });
      return;
    }

    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rumah_ibadah?id=eq.${id}`, {
        method: 'DELETE',
        headers: supabaseHeaders({ Prefer: 'return=representation' }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        res.status(r.status).json({ ok: false, error: body?.message || 'Gagal menghapus data', details: body });
        return;
      }
      if (!Array.isArray(body) || !body.length) {
        res.status(404).json({ ok: false, error: 'Data tidak ditemukan' });
        return;
      }
      res.json({ ok: true, deleted: body[0] });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Gagal menghubungi Supabase' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build not found');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`WebGIS server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
