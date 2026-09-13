import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'silva-prime-agendamento'
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    salonName: 'Barbeiro Silva Prime',
    depositPercent: 50,
    cancelRefundHours: 24,
    paymentReady: false
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Silva Prime rodando na porta ${PORT}`);
});
