require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors());
app.use(
  "/webhook/razorpay",
  express.raw({ type: "application/json" })
);
app.use(express.json());

app.get("/", (req, res) => {
  res.send("xdtip backend is running");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

app.get("/test-db", async (req, res) => {
  const { data, error } = await supabase.from("users").select("*").limit(1);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

app.post("/register", async (req, res) => {
  const { email, username, role } = req.body;

  if (!email || !username || !role) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!["viewer", "creator"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  // Check if username already exists
  const { data: existingUser } = await supabase
    .from("users")
    .select("id")
    .eq("username", username)
    .single();

  if (existingUser) {
    return res.status(409).json({ error: "Username already taken" });
  }

  // Insert user
  const { data, error } = await supabase.from("users").insert([
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

const crypto = require("crypto");

app.post("/become-creator", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  // Find user
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, role")
    .eq("username", username)
    .single();

  if (userError || !user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (user.role === "creator") {
    return res.status(400).json({ error: "User is already a creator" });
  }

  // Generate overlay key
  const overlayKey = crypto.randomBytes(16).toString("hex");

  // Create creator profile
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

  // Update user role
  await supabase
    .from("users")
    .update({ role: "creator" })
    .eq("id", user.id);

  res.json({
    success: true,
    message: "User is now a creator",
    creator_url: `tip.xdfun/${username}`
  });
});

app.post("/tip", async (req, res) => {
  const { from_username, to_creator, amount, message } = req.body;

  if (!from_username || !to_creator || !amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (amount < 10) {
    return res.status(400).json({ error: "Minimum tip is 10 tokens" });
  }

  // Get viewer
  const { data: viewer } = await supabase
    .from("users")
    .select("id, token_balance")
    .eq("username", from_username)
    .single();

  if (!viewer) {
    return res.status(404).json({ error: "Viewer not found" });
  }

  if (viewer.token_balance < amount) {
    return res.status(400).json({ error: "Insufficient tokens" });
  }

  // Get creator
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

  // Deduct viewer tokens
  await supabase
    .from("users")
    .update({ token_balance: viewer.token_balance - amount })
    .eq("id", viewer.id);

  // Add to creator balance
  await supabase
    .from("creators")
    .update({ payout_balance: creator.payout_balance + creatorShare })
    .eq("id", creator.id);

  // Add to platform wallet
  const { data: wallet } = await supabase
    .from("platform_wallet")
    .select("balance")
    .eq("id", 1)
    .single();

  await supabase
    .from("platform_wallet")
    .update({ balance: wallet.balance + platformShare })
    .eq("id", 1);

  // Save tip
  await supabase.from("tips").insert([
    {
      viewer_id: viewer.id,
      creator_id: creator.id,
      amount,
      message
    }
  ]);

  // Log transactions
  await supabase.from("transactions").insert([
    { user_id: viewer.id, type: "tip_sent", amount },
    { user_id: creator.id, type: "tip_received", amount: creatorShare },
    { type: "platform_fee", amount: platformShare }
  ]);

  res.json({
    success: true,
    message: "Tip sent successfully",
    creator_received: creatorShare
  });
});

const crypto = require("crypto");

app.post("/webhook/razorpay", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  const signature = req.headers["x-razorpay-signature"];
  const body = req.body;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  if (signature !== expectedSignature) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(body.toString());

  if (event.event !== "payment.captured") {
    return res.json({ status: "ignored" });
  }

  const payment = event.payload.payment.entity;

  const amountInRupees = payment.amount / 100;
  const username = payment.notes?.username;

  if (!username) {
    return res.status(400).json({ error: "Username missing in payment" });
  }

  // Find user
  const { data: user } = await supabase
    .from("users")
    .select("id, token_balance")
    .eq("username", username)
    .single();

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  // Add tokens
  await supabase
    .from("users")
    .update({
      token_balance: user.token_balance + amountInRupees
    })
    .eq("id", user.id);

  // Log transaction
  await supabase.from("transactions").insert([
    {
      user_id: user.id,
      type: "purchase",
      amount: amountInRupees,
      reference_id: payment.id
    }
  ]);

  res.json({ success: true });
});



