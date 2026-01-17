require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();

/* =======================
   CORS
======================= */
app.use(
  cors({
    origin: [
      "https://bkonai00.github.io",
      "http://localhost:3000",
      "http://localhost:5500"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-user"]
  })
);

app.options("*", cors());

/* =======================
   BODY PARSERS
======================= */
app.use(express.json());

app.use(
  "/webhook/razorpay",
  express.raw({ type: "application/json" })
);

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

const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  socket.on("join_creator", (creatorSlug) => {
    if (creatorSlug) {
      socket.join(creatorSlug);
      console.log("🎥 Joined creator room:", creatorSlug);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);
  });
});

/* =======================
   START SERVER
======================= */
const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});

/* =======================
   ROUTES
======================= */

app.get("/", (req, res) => {
  res.send("xdtip backend is running");
});

/* =======================
   REGISTER
======================= */
app.post("/register", async (req, res) => {
  const { email, username, role } = req.body;

  if (!email || !username || !role) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!["viewer", "creator"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  const { data: existing } = await supabase
    .from("users")
    .select("id")
    .eq("username", username)
    .single();

  if (existing) {
    return res.status(409).json({ error: "Username already taken" });
  }

  const { data: user, error } = await supabase
    .from("users")
    .insert([
      { email, username, role, token_balance: 0 }
    ])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  if (role === "creator") {
    const overlayKey = crypto.randomBytes(16).toString("hex");

    await supabase.from("creators").insert([
      {
        user_id: user.id,
        slug: username,
        payout_balance: 0,
        overlay_key: overlayKey
      }
    ]);
  }

  res.json({ success: true });
});

/* =======================
   LOGIN (MVP)
======================= */
app.post("/login", async (req, res) => {
  const { email, username } = req.body;

  if (!email || !username) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const { data: user } = await supabase
    .from("users")
    .select("id, email, username, role, token_balance")
    .eq("email", email)
    .eq("username", username)
    .single();

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.json({ success: true, user });
});

/* =======================
   SEND TIP (LOGIN REQUIRED)
======================= */
app.post("/tip", async (req, res) => {
  const viewerUsername = req.headers["x-user"];
  const { to_creator, amount, message } = req.body;

  if (!viewerUsername) {
    return res.status(401).json({ error: "Please login first" });
  }

  if (!to_creator || !amount || amount < 10) {
    return res.status(400).json({ error: "Invalid tip" });
  }

  const { data: viewer } = await supabase
    .from("users")
    .select("id, token_balance")
    .eq("username", viewerUsername)
    .single();

  if (!viewer || viewer.token_balance < amount) {
    return res.status(400).json({ error: "Insufficient tokens" });
  }

  const { data: creator } = await supabase
    .from("creators")
    .select("id, payout_balance")
    .eq("slug", to_creator)
    .single();

  if (!creator) {
    return res.status(404).json({ error: "Creator not found" });
  }

  const creatorShare = Math.floor(amount * 0.92);
  const platformShare = amount - creatorShare;

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
    from: viewerUsername,
    amount,
    message
  });

  res.json({ success: true });
});

/* =======================
   CREATOR TIP HISTORY
======================= */
app.get("/creator-tips/:username", async (req, res) => {
  const { username } = req.params;

  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("slug", username)
    .single();

  if (!creator) {
    return res.status(404).json({ error: "Creator not found" });
  }

  const { data: tips } = await supabase
    .from("tips")
    .select("amount, message, created_at")
    .eq("creator_id", creator.id)
    .order("created_at", { ascending: false });

  res.json({ success: true, tips });
});

/* =======================
   RAZORPAY WEBHOOK
======================= */
app.post("/webhook/razorpay", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];

  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.body)
    .digest("hex");

  if (signature !== expected) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(req.body.toString());

  if (event.event !== "payment.captured") {
    return res.json({ status: "ignored" });
  }

  const payment = event.payload.payment.entity;
  const amount = payment.amount / 100;
  const username = payment.notes?.username;

  if (!username) {
    return res.json({ success: true });
  }

  const { data: user } = await supabase
    .from("users")
    .select("id, token_balance")
    .eq("username", username)
    .single();

  if (!user) {
    return res.json({ success: true });
  }

  await supabase
    .from("users")
    .update({ token_balance: user.token_balance + amount })
    .eq("id", user.id);

  res.json({ success: true });
});
