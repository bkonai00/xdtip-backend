require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 10000;

/* =======================
   SUPABASE
======================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =======================
   EXPRESS APP
======================= */
const app = express();

app.use(cors());

// Razorpay webhook needs RAW body
app.use(
  "/webhook/razorpay",
  express.raw({ type: "application/json" })
);

// Normal JSON for rest APIs
app.use(express.json());

/* =======================
   HTTP + SOCKET.IO
======================= */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

io.on("connection", (socket) => {
  console.log("🔌 Overlay connected");

  socket.on("join_creator", (creatorSlug) => {
    socket.join(creatorSlug);
    console.log(`🎥 Joined creator room: ${creatorSlug}`);
  });
});

/* =======================
   SERVER START
======================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});

/* =======================
   ROUTES
======================= */

app.get("/", (req, res) => {
  res.send("xdtip backend is running");
});

app.get("/test-db", async (req, res) => {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .limit(1);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

/* =======================
   REGISTER USER
======================= */
app.post("/register", async (req, res) => {
  const { email, username, role } = req.body;

  if (!email || !username || !role) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!["viewer", "creator"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  const { data: existingUser } = await supabase
    .from("users")
    .select("id")
    .eq("username", username)
    .single();

  if (existingUser) {
    return res.status(409).json({ error: "Username already taken" });
  }

  const { error } = await supabase.from("users").insert([
    {
      email,
      username,
      role,
      token_balance: 0
    }
  ]);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, message: "User registered" });
});

/* =======================
          LOGIN
======================= */

app.post("/login", async (req, res) => {
  const { email, username } = req.body;

  if (!email || !username) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const { data: user, error } = await supabase
    .from("users")
    .select("id, email, username, role, token_balance")
    .eq("email", email)
    .eq("username", username)
    .single();

  if (error || !user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.json({
    success: true,
    user
  });
});



/* =======================
   BECOME CREATOR
======================= */
app.post("/become-creator", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  const { data: user } = await supabase
    .from("users")
    .select("id, role")
    .eq("username", username)
    .single();

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (user.role === "creator") {
    return res.status(400).json({ error: "User is already a creator" });
  }

  const overlayKey = crypto.randomBytes(16).toString("hex");

  const { error: creatorError } = await supabase.from("creators").insert([
    {
      user_id: user.id,
      slug: username,
      payout_balance: 0,
      overlay_key: overlayKey
    }
  ]);

  if (creatorError) {
    return res.status(500).json({ error: creatorError.message });
  }

  await supabase
    .from("users")
    .update({ role: "creator" })
    .eq("id", user.id);

  res.json({
    success: true,
    creator_url: `tip.xdfun/${username}`,
    overlay_key: overlayKey
  });
});

/* =======================
   SEND TIP
======================= */
app.post("/tip", async (req, res) => {
  const { from_username, to_creator, amount, message } = req.body;

  if (!from_username || !to_creator || !amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (amount < 10) {
    return res.status(400).json({ error: "Minimum tip is 10 tokens" });
  }

  const { data: viewer } = await supabase
    .from("users")
    .select("id, token_balance")
    .eq("username", from_username)
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

  const { data: wallet } = await supabase
    .from("platform_wallet")
    .select("balance")
    .eq("id", 1)
    .single();

  await supabase
    .from("platform_wallet")
    .update({ balance: wallet.balance + platformShare })
    .eq("id", 1);

  await supabase.from("tips").insert([
    {
      viewer_id: viewer.id,
      creator_id: creator.id,
      amount,
      message
    }
  ]);

  await supabase.from("transactions").insert([
    { user_id: viewer.id, type: "tip_sent", amount },
    { user_id: creator.id, type: "tip_received", amount: creatorShare },
    { type: "platform_fee", amount: platformShare }
  ]);

  /* 🔥 REAL-TIME EVENT */
  io.to(to_creator).emit("new_tip", {
    username: from_username,
    amount,
    message
  });

  res.json({
    success: true,
    creator_received: creatorShare
  });
});

/* =======================
   RAZORPAY WEBHOOK
======================= */
app.post("/webhook/razorpay", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(req.body)
    .digest("hex");

  if (signature !== expectedSignature) {
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
    return res.status(400).json({ error: "Username missing" });
  }

  const { data: user } = await supabase
    .from("users")
    .select("id, token_balance")
    .eq("username", username)
    .single();

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  await supabase
    .from("users")
    .update({ token_balance: user.token_balance + amount })
    .eq("id", user.id);

  await supabase.from("transactions").insert([
    {
      user_id: user.id,
      type: "purchase",
      amount,
      reference_id: payment.id
    }
  ]);

  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { email, username } = req.body;

  if (!email || !username) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const { data: user } = await supabase
    .from("users")
    .select("id, username, role, token_balance")
    .eq("email", email)
    .eq("username", username)
    .single();

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.json({
    success: true,
    user
  });
});
