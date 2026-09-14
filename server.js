import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

/* =========================
   FIREBASE
========================= */

const privateKey = process.env.FIREBASE_PRIVATE_KEY
  ?.replace(/\\n/g, "\n");

if (
  !process.env.FIREBASE_PROJECT_ID ||
  !process.env.FIREBASE_CLIENT_EMAIL ||
  !privateKey ||
  !process.env.OWNER_UID
) {
  console.error("Variáveis do Firebase não configuradas.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey
  })
});

const db = admin.firestore();
const OWNER_UID = process.env.OWNER_UID;

/* =========================
   TESTE
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Silva Prime",
    firebase: true
  });
});

/* =========================
   CONFIGURAÇÃO PÚBLICA
========================= */

app.get("/api/config", async (req, res) => {
  try {
    const servicesSnap = await db
      .collection("users")
      .doc(OWNER_UID)
      .collection("services")
      .get();

    const services = [];

    servicesSnap.forEach(doc => {
      const data = doc.data();

      services.push({
        id: doc.id,
        name: data.name || data.nome || "Serviço",
        price: Number(data.price ?? data.valor ?? 0),
        duration: Number(data.duration ?? data.duracao ?? 30)
      });
    });

    res.json({
      professional: "Barbeiro Silva",
      depositPercent: 50,
      refundHours: 24,
      services
    });

  } catch (error) {
    console.error("Erro ao carregar configuração:", error);
    res.status(500).json({
      error: "Não foi possível carregar os serviços."
    });
  }
});

/* =========================
   HORÁRIOS OCUPADOS
========================= */

app.get("/api/availability", async (req, res) => {
  try {
    const date = String(req.query.date || "");

    if (!date) {
      return res.status(400).json({
        error: "Data não informada."
      });
    }

    const snap = await db
      .collection("users")
      .doc(OWNER_UID)
      .collection("appointments")
      .where("date", "==", date)
      .get();

    const busy = [];

    snap.forEach(doc => {
      const a = doc.data();

      if (
        a.status !== "CANCELLED" &&
        a.status !== "NO_SHOW"
      ) {
        busy.push({
          time: a.time || "",
          duration: Number(a.duration || 30)
        });
      }
    });

    res.json({ busy });

  } catch (error) {
    console.error("Erro ao consultar agenda:", error);

    res.status(500).json({
      error: "Não foi possível consultar a agenda."
    });
  }
});

/* =========================
   NOVO AGENDAMENTO
========================= */

app.post("/api/appointments", async (req, res) => {
  try {
    const {
      serviceId,
      serviceName,
      price,
      duration,
      date,
      time,
      clientName,
      whatsapp
    } = req.body;

    if (
      !serviceName ||
      !date ||
      !time ||
      !clientName ||
      !whatsapp
    ) {
      return res.status(400).json({
        error: "Preencha todos os dados obrigatórios."
      });
    }

    const total = Number(price || 0);
    const deposit = Number((total * 0.5).toFixed(2));
    const remaining = Number((total - deposit).toFixed(2));

    /* Verifica se o horário já foi ocupado */

    const existing = await db
      .collection("users")
      .doc(OWNER_UID)
      .collection("appointments")
      .where("date", "==", date)
      .where("time", "==", time)
      .get();

    const hasActive = existing.docs.some(doc => {
      const a = doc.data();

      return (
        a.status !== "CANCELLED" &&
        a.status !== "NO_SHOW"
      );
    });

    if (hasActive) {
      return res.status(409).json({
        error: "Esse horário acabou de ser reservado."
      });
    }

    /* Cria o agendamento */

    const appointment = {
      serviceId: serviceId || "",
      serviceName,
      price: total,
      duration: Number(duration || 30),

      date,
      time,

      clientName,
      whatsapp,

      depositPercent: 50,
      depositAmount: deposit,
      remainingAmount: remaining,

      depositStatus: "PENDING",

      status: "PENDING_PAYMENT",

      source: "online",

      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db
      .collection("users")
      .doc(OWNER_UID)
      .collection("appointments")
      .add(appointment);

    res.json({
      ok: true,
      id: ref.id,
      appointment: {
        ...appointment,
        depositAmount: deposit,
        remainingAmount: remaining
      }
    });

  } catch (error) {
    console.error("Erro ao criar agendamento:", error);

    res.status(500).json({
      error: "Não foi possível criar o agendamento."
    });
  }
});

/* =========================
   PÁGINA DE AGENDAMENTO
========================= */

app.get("/agendar", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* =========================
   APLICATIVO SILVA PRIME
========================= */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "app.html"));
});

/* =========================
   ERRO 404
   Compatível com Express 5
========================= */

app.use((req, res) => {
  res.status(404).send("Página não encontrada.");
});

/* =========================
   SERVIDOR
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Silva Prime rodando na porta ${PORT}`);
});
