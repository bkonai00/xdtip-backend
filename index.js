require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const JWT_SECRET = "dev_secret";

/* HEALTH */
app.get("/", (req, res) => {
  res.send("API OK");
});

/* REGISTER */
app.post("/register", async (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password)
    return res.status(400).json({ error: "Missing fields" });

  const hash = await bcrypt.hash(password, 10);

  const { error } = await supabase.from("users").insert([
    {
      email,
      username,
      password_hash: hash,
      token_balance: 100
    }
  ]);

  if (error) return res.status(400).json({ error: error.message });

  res.json({ success: true });
});

/* LOGIN */
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
    { id: user.id, username: user.username },
    JWT_SECRET
  );

  res.json({ token, user });
});

/* AUTH */
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: "No token" });

  try {
    req.user = jwt.verify(h.split(" ")[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Bad token" });
  }
}

/* TIP */
app.post("/tip", auth, async (req, res) => {
  const { to, amount } = req.body;

  if (!to || amount < 10)
    return res.status(400).json({ error: "Bad tip" });

  res.json({
    success: true,
    from: req.user.username,
    to,
    amount
  });
});

app.listen(10000, () => {
  console.log("Backend running on 10000");
});
