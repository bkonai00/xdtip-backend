require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();

/* =======================
   CONFIG
======================= */
const JWT_SECRET = process.env.JWT_SECRET;

/* =======================
   CORS
======================= */
app.use(
  cors({
    origin: [
      "https://bkonai00.github.io",
      "http://localhost:5500"
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);
app.options("*", cors());

app.use(express.json());

/* =======================
   SUPABASE
======================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =======================
   HTTP + SOCKET.IO
======================= */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  socket.on("join_creator", (slug) => {
    socket.join(slug);
  });
});

/* =======================
   AUTH MIDDLEWARE
======================= */
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Not logged in" });

  const token = header.split(" ")[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

/* =======================
   HEALTH
======================= */
app.get("/", (_, res) => res.send("xdtip backend running"));

/* =======================
   REGISTER
======================= */
app.post("/register", async (req, res) => {
  const { email, username, password, role } = req.body;

  if (!email || !username || !password) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const password_hash = await bcrypt.hash(password, 10);

  const { data: user, error } = await supabase
    .from("users")
    .insert([
      {
        email,
        username,
        password_hash,
        role: role || "viewer",
        token_balance: 0
      }
    ])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  if (user.role === "creator") {
    await supabase.from("creators").insert([
      {
        user_id: user.id,
        slug: username,
        payout_balance: 0,
        overlay_key: crypto.randomBytes(16).toString("hex")
      }
    ]);
  }

  res.json({ success: true });
});

/* =======================
   LOGIN
======================= */
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("email", email)
    .single();

  if (!user) return res.status(401).json({ error: "Invalid login" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid login" });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token, user });
});

/* =======================
   DASHBOARD
======================= */
app.get("/me", auth, async (req, res) => {
  const { data: user } = await supabase
    .from("users")
    .select("id, username, role, token_balance")
    .eq("id", req.user.id)
    .single();

  res.json({ user });
});

/* =======================
   SEND TIP
======================= */
app.post("/tip", auth, async (req, res) => {
  const { to_creator, amount, message } = req.body;

  if (!to_creator || amount < 10) {
    return res.status(400).json({ error: "Invalid tip" });
  }

  const { data: viewer } = await supabase
    .from("users")
    .select("id, token_balance")
    .eq("id", req.user.id)
    .single();

  if (viewer.token_balance < amount) {
    return res.status(400).json({ error: "Not enough tokens" });
  }

  const { data: creator } = await supabase
    .from("creators")
    .select("id, payout_balance")
    .eq("slug", to_creator)
    .single();

  const creatorShare = Math.floor(amount * 0.92);

  await supabase
    .from("users")
    .update({ token_balance: viewer.token_balance - amount })
    .eq("id", viewer.id);

  await supabase
    .from("creators")
    .update({ payout_balance: creator.payout_balance + creatorShare })
    .eq("id", creator.id);

  await supabase.from("tips").insert([
    {
      viewer_id: viewer.id,
      creator_id: creator.id,
      amount,
      message
    }
  ]);

  io.to(to_creator).emit("new-tip", {
    from: req.user.username,
    amount,
    message
  });

  res.json({ success: true });
});

/* =======================
   START
======================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log("Server running on", PORT)
);
