import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const OWNER_UID = process.env.OWNER_UID;

function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function firebaseToken() {
  if (!PROJECT_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
    throw new Error("Credenciais do Firebase não configuradas no Railway.");
  }

  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({
    alg: "RS256",
    typ: "JWT"
  }));

  const payload = base64url(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));

  const unsigned = `${header}.${payload}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();

  const signature = signer.sign(PRIVATE_KEY, "base64url");
  const assertion = `${unsigned}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (!response.ok) {
    throw new Error(`Erro ao autenticar Firebase: ${await response.text()}`);
  }

  const data = await response.json();
  return data.access_token;
}

function firestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }

  if (typeof value === "boolean") {
    return { booleanValue: value };
  }

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }

  return { stringValue: String(value) };
}

function firestoreFields(obj) {
  const fields = {};

  for (const [key, value] of Object.entries(obj)) {
    fields[key] = firestoreValue(value);
  }

  return fields;
}

function fromFirestoreValue(v) {
  if (!v) return null;

  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;

  return null;
}

function fromFirestoreDocument(doc) {
  const result = {
    id: doc.name?.split("/").pop()
  };

  for (const [key, value] of Object.entries(doc.fields || {})) {
    result[key] = fromFirestoreValue(value);
  }

  return result;
}

function firestoreBase() {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
}

async function firestoreRequest(url, options = {}) {
  const token = await firebaseToken();

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firestore ${response.status}: ${text}`);
  }

  if (response.status === 204) return null;

  return response.json();
}

function userCollection(collection) {
  if (!OWNER_UID) {
    throw new Error("OWNER_UID não configurado no Railway.");
  }

  return `${firestoreBase()}/users/${OWNER_UID}/${collection}`;
}

/* -------------------------
   CONFIGURAÇÃO
------------------------- */

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "silva-prime-agendamento"
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    salonName: "Barbeiro Silva Prime",
    depositPercent: 50,
    cancelRefundHours: 24,
    paymentReady: false
  });
});

/* -------------------------
   SERVIÇOS
------------------------- */

app.get("/api/services", async (_req, res) => {
  try {
    const data = await firestoreRequest(
      `${userCollection("services")}?pageSize=100`
    );

    const services = (data.documents || [])
      .map(fromFirestoreDocument)
      .filter(s => s.active !== false)
      .map(s => ({
        id: s.id,
        name: s.name || s.service || "Serviço",
        price: Number(s.price || 0),
        duration: Number(s.duration || 30)
      }));

    res.json({ services });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Não foi possível carregar os serviços."
    });
  }
});

/* -------------------------
   AGENDAMENTOS
------------------------- */

app.get("/api/appointments", async (req, res) => {
  try {
    const date = String(req.query.date || "");

    const data = await firestoreRequest(
      `${userCollection("appointments")}?pageSize=1000`
    );

    let appointments = (data.documents || [])
      .map(fromFirestoreDocument);

    if (date) {
      appointments = appointments.filter(a => a.date === date);
    }

    res.json({ appointments });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Não foi possível carregar os agendamentos."
    });
  }
});

app.post("/api/appointments", async (req, res) => {
  try {
    const {
      serviceId,
      service,
      date,
      time,
      duration,
      clientName,
      phone,
      total
    } = req.body || {};

    if (!serviceId || !date || !time || !clientName || !phone) {
      return res.status(400).json({
        error: "Preencha serviço, data, horário, nome e WhatsApp."
      });
    }

    const existingData = await firestoreRequest(
      `${userCollection("appointments")}?pageSize=1000`
    );

    const existing = (existingData.documents || [])
      .map(fromFirestoreDocument);

    const requestedStart = Number(time.replace(":", "."));

    const occupied = existing.some(a => {
      if (a.date !== date) return false;

      if (
        a.status === "CANCELLED" ||
        a.status === "NO_SHOW"
      ) {
        return false;
      }

      const start = Number(String(a.time || "0").replace(":", "."));
      const dur = Number(a.duration || 30);

      const startMinutes =
        Number(time.split(":")[0]) * 60 +
        Number(time.split(":")[1]);

      const oldMinutes =
        Number(String(a.time).split(":")[0]) * 60 +
        Number(String(a.time).split(":")[1]);

      return (
        startMinutes < oldMinutes + dur &&
        oldMinutes < startMinutes + Number(duration || 30)
      );
    });

    if (occupied) {
      return res.status(409).json({
        error: "Esse horário já foi reservado."
      });
    }

    const id = `online_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const now = Date.now();

    const appointment = {
      id,
      date,
      time,
      serviceId,
      service: service || "Serviço",
      duration: Number(duration || 30),
      clientName: String(clientName).trim(),
      phone: String(phone).trim(),
      total: Number(total || 0),
      deposit: Number(total || 0) * 0.5,
      depositStatus: "PENDING",
      status: "PENDING_PAYMENT",
      source: "online",
      createdAt: now,
      updatedAt: now
    };

    const url =
      `${userCollection("appointments")}?documentId=${encodeURIComponent(id)}`;

    await firestoreRequest(url, {
      method: "POST",
      body: JSON.stringify({
        fields: firestoreFields(appointment)
      })
    });

    res.status(201).json({
      ok: true,
      appointment
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Não foi possível criar o agendamento.",
      detail: error.message
    });
  }
});

/* -------------------------
   CANCELAMENTO
------------------------- */

app.post("/api/appointments/:id/cancel", async (req, res) => {
  try {
    const id = req.params.id;

    const data = await firestoreRequest(
      `${userCollection("appointments")}?pageSize=1000`
    );

    const appointment = (data.documents || [])
      .map(fromFirestoreDocument)
      .find(a => a.id === id);

    if (!appointment) {
      return res.status(404).json({
        error: "Agendamento não encontrado."
      });
    }

    const appointmentDate = new Date(
      `${appointment.date}T${appointment.time}:00-03:00`
    );

    const hours =
      (appointmentDate.getTime() - Date.now()) / 3600000;

    const refundEligible =
      appointment.depositStatus === "PAID" &&
      hours >= 24;

    const updated = {
      ...appointment,
      status: "CANCELLED",
      depositStatus: refundEligible ? "REFUND_PENDING" : "KEPT",
      refundEligible,
      updatedAt: Date.now()
    };

    const url =
      `${userCollection("appointments")}/${encodeURIComponent(id)}`;

    await firestoreRequest(url, {
      method: "PATCH",
      body: JSON.stringify({
        fields: firestoreFields(updated)
      })
    });

    res.json({
      ok: true,
      refundEligible
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Não foi possível cancelar o agendamento."
    });
  }
});

/* -------------------------
   SERVIDOR
------------------------- */

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Silva Prime rodando na porta ${PORT}`);
});
