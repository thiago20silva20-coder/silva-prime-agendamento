import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import admin from 'firebase-admin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'barbearia-silva-prime';
const OWNER_UID = process.env.OWNER_UID || '';

let db = null;

try {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (clientEmail && privateKey) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: PROJECT_ID,
          clientEmail,
          privateKey
        })
      });
    }
    db = admin.firestore();
    console.log('Firebase Admin conectado.');
  } else {
    console.log('Firebase Admin aguardando variáveis de ambiente.');
  }
} catch (error) {
  console.error('Falha ao iniciar Firebase Admin:', error.message);
}

const fallbackServices = [
  { id: 1, name: 'Corte Degradê', price: 30, duration: 30 },
  { id: 2, name: 'Corte Social', price: 30, duration: 30 },
  { id: 3, name: 'Corte + Barba', price: 50, duration: 45 },
  { id: 4, name: 'Barba', price: 25, duration: 30 },
  { id: 5, name: 'Corte + Sobrancelha', price: 35, duration: 30 },
  { id: 6, name: 'Corte + Barba + Sobrancelha', price: 55, duration: 60 }
];

const defaultConfig = {
  depositPct: 50,
  refundHours: 24,
  slotMinutes: 30,
  days: {
    0: { on: false, start: '08:00', end: '18:00' },
    1: { on: true, start: '08:00', end: '18:00' },
    2: { on: true, start: '08:00', end: '18:00' },
    3: { on: true, start: '08:00', end: '18:00' },
    4: { on: true, start: '08:00', end: '18:00' },
    5: { on: true, start: '08:00', end: '18:00' },
    6: { on: true, start: '08:00', end: '18:00' }
  }
};

function minutes(value) {
  const [h, m] = String(value || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
}

async function getConfig() {
  const result = { ...defaultConfig, services: fallbackServices };
  if (!db || !OWNER_UID) return result;

  try {
    const userRef = db.collection('users').doc(OWNER_UID);
    const [servicesSnap, configSnap] = await Promise.all([
      userRef.collection('services').get(),
      userRef.collection('publicConfig').doc('config').get()
    ]);

    if (!servicesSnap.empty) {
      result.services = servicesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    if (configSnap.exists) {
      Object.assign(result, configSnap.data());
    }
  } catch (error) {
    console.error('Erro ao ler configuração:', error.message);
  }

  return result;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    firebase: Boolean(db),
    ownerConfigured: Boolean(OWNER_UID)
  });
});

app.get('/api/config', async (_req, res) => {
  try {
    res.json(await getConfig());
  } catch (error) {
    res.status(500).json({ error: 'Não foi possível carregar a configuração.' });
  }
});

app.get('/api/appointments', async (req, res) => {
  const date = String(req.query.date || '').trim();

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Data inválida.' });
  }

  if (!db || !OWNER_UID) {
    return res.json({ ok: true, appointments: [] });
  }

  try {
    const ref = db.collection('users').doc(OWNER_UID).collection('appointments');
    const snap = date
      ? await ref.where('date', '==', date).get()
      : await ref.get();

    const appointments = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));

    res.json({ ok: true, appointments });
  } catch (error) {
    console.error('Erro ao consultar agendamentos:', error);
    res.status(500).json({ error: 'Não foi possível carregar os agendamentos.' });
  }
});

app.get('/api/availability', async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Data inválida.' });
  }

  if (!db || !OWNER_UID) return res.json({ busy: [] });

  try {
    const snap = await db.collection('users').doc(OWNER_UID)
      .collection('appointments')
      .where('date', '==', date)
      .get();

    const busy = snap.docs
      .map(doc => doc.data())
      .filter(a => !['CANCELLED', 'NO_SHOW'].includes(a.status))
      .map(a => ({
        start: minutes(a.time),
        end: minutes(a.time) + Number(a.duration || 30)
      }))
      .filter(a => Number.isFinite(a.start));

    res.json({ busy });
  } catch (error) {
    console.error('Erro ao consultar agenda:', error.message);
    res.status(500).json({ error: 'Não foi possível consultar a agenda.' });
  }
});

app.post('/api/appointments', async (req, res) => {
  if (!db || !OWNER_UID) {
    return res.status(503).json({ error: 'A conexão com a agenda ainda não está configurada.' });
  }

  const { serviceId, date, time, name, phone } = req.body || {};
  if (!serviceId || !date || !time || !name || !phone) {
    return res.status(400).json({ error: 'Preencha todos os dados.' });
  }

  try {
    const config = await getConfig();
    const service = config.services.find(s => String(s.id) === String(serviceId));
    if (!service) return res.status(400).json({ error: 'Serviço não encontrado.' });

    const dayIndex = new Date(`${date}T12:00:00`).getDay();
    const day = config.days?.[dayIndex];
    if (!day?.on) return res.status(400).json({ error: 'A barbearia não atende nesse dia.' });

    const start = minutes(time);
    const duration = Number(service.duration || 30);
    if (!Number.isFinite(start)) return res.status(400).json({ error: 'Horário inválido.' });

    const snap = await db.collection('users').doc(OWNER_UID)
      .collection('appointments')
      .where('date', '==', date)
      .get();

    const conflict = snap.docs
      .map(doc => doc.data())
      .filter(a => !['CANCELLED', 'NO_SHOW'].includes(a.status))
      .some(a => {
        const otherStart = minutes(a.time);
        const otherEnd = otherStart + Number(a.duration || 30);
        return start < otherEnd && start + duration > otherStart;
      });

    if (conflict) {
      return res.status(409).json({ error: 'Esse horário acabou de ser ocupado. Escolha outro.' });
    }

    const total = Number(service.price || 0);
    const depositPct = Number(config.depositPct ?? 50);
    const deposit = Math.round(total * depositPct) / 100;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const appointment = {
      id,
      date,
      time,
      serviceId: service.id,
      service: service.name,
      duration,
      clientName: String(name).trim(),
      phone: String(phone).trim(),
      total,
      deposit,
      remaining: Math.max(0, total - deposit),
      depositPct,
      depositStatus: deposit > 0 ? 'PENDING' : 'NOT_REQUIRED',
      status: deposit > 0 ? 'PENDING_PAYMENT' : 'CONFIRMED',
      source: 'online',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await db.collection('users').doc(OWNER_UID)
      .collection('appointments').doc(String(id)).set(appointment);

    res.status(201).json({
      ok: true,
      code: `SP-${String(id).replace(/\D/g, '').slice(-6)}`,
      appointment
    });
  } catch (error) {
    console.error('Erro ao criar agendamento:', error);
    res.status(500).json({ error: 'Não foi possível criar o agendamento.' });
  }
});

// Rotas da aplicação. Não usamos rota coringa (*) para manter compatibilidade com Express 5.
app.get('/agendar', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/app', (_req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

app.use(express.static(__dirname));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Silva Prime online na porta ${PORT}`);
});
