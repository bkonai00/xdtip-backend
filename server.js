// ==========================================
// XDTIP BACKEND SERVER (Master Version)
// ==========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs'); 
const crypto = require('crypto'); // <--- Required for Razorpay Webhook

// 1. INITIALIZE APP & SERVER
const app = express();
const server = http.createServer(app);

// 2. SETUP SOCKET.IO (Real-time Alerts)
const io = new Server(server, {
    cors: { origin: "*" }
});

// 3. SETUP SUPABASE DATABASE
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 4. MIDDLEWARE
app.use(cors());
app.use(express.json());

// 5. SERVE STATIC FILES (Images & Overlay)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ------------------------------------------
// AUTHENTICATION CHECKER
// ------------------------------------------
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: "Access denied" });

    jwt.verify(token, process.env.SUPABASE_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid token" });
        req.user = user;
        next();
    });
};

// ------------------------------------------
// SOCKET CONNECTION
// ------------------------------------------
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // Join Overlay Room (Secure)
    socket.on('join-overlay', async (token) => {
        const { data: user } = await supabase
            .from('users').select('username').eq('obs_token', token).single();

        if (user) {
            socket.join(user.username);
            console.log(`Overlay joined room: ${user.username}`);
        }
    });
});

// ------------------------------------------
// API ROUTES
// ------------------------------------------

// A. Home Check
app.get('/', (req, res) => {
    res.send('xdtip Backend is Running! 🚀');
});

// B. Register User
app.post('/register', async (req, res) => {
    const { username, email, password, role } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: "Fill all fields" });

    try {
        const { data: existingUser } = await supabase
            .from('users').select('*').or(`email.eq.${email},username.eq.${username}`).single();

        if (existingUser) return res.status(400).json({ error: "User already exists" });

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const { data, error } = await supabase
            .from('users')
            .insert([{ username, email, password_hash: passwordHash, role: role || 'viewer' }])
            .select();

        if (error) throw error;
        res.json({ success: true, message: "Registered!", user: data[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// C. Login User
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
        if (!user) return res.status(400).json({ error: "User not found" });

        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(400).json({ error: "Invalid password" });

        const token = jwt.sign({ id: user.id, username: user.username }, process.env.SUPABASE_KEY, { expiresIn: '24h' });

        res.json({ success: true, token, user: { id: user.id, username: user.username, balance: user.balance } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// D. Get User Details
app.get('/me', authenticateToken, async (req, res) => {
    try {
        const { data: user } = await supabase
            .from('users')
            .select('id, username, role, balance, obs_token, logo_url')
            .eq('id', req.user.id).single();
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// E. Get Public Profile (For Tip Page)
app.get('/profile/:username', async (req, res) => {
    const { username } = req.params;
    const { data: user } = await supabase
        .from('users').select('username, logo_url').eq('username', username).single();

    if (user) res.json({ success: true, user });
    else res.json({ success: false });
});

// F. Send Tip
app.post('/tip', authenticateToken, async (req, res) => {
    const { receiverUsername, amount, message } = req.body;
    const senderId = req.user.id;

    if (amount < 10) return res.status(400).json({ error: "Min tip is 10" });

    try {
        const { data: receiver } = await supabase.from('users').select('id, balance').eq('username', receiverUsername).single();
        if (!receiver) return res.status(404).json({ error: "Creator not found" });

        const { data: sender } = await supabase.from('users').select('balance').eq('id', senderId).single();
        if (sender.balance < amount) return res.status(400).json({ error: "Insufficient balance" });

        const platformFee = amount * 0.08;
        const creatorShare = amount - platformFee;

        await supabase.rpc('decrement_balance', { user_id: senderId, amount: amount });
        await supabase.rpc('increment_balance', { user_id: receiver.id, amount: creatorShare });
        await supabase.from('tips').insert([{ sender_id: senderId, receiver_id: receiver.id, amount, message }]);

        // ALERT THE CREATOR
        io.to(receiverUsername).emit('new-tip', {
            sender: req.user.username,
            amount: amount,
            message: message
        });

        res.json({ success: true, message: `Sent ${amount} tokens!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// G. Get History
app.get('/history', authenticateToken, async (req, res) => {
    try {
        const { data: tips, error } = await supabase
            .from('tips')
            .select('sender_id, amount, message, created_at, users:sender_id (username)')
            .eq('receiver_id', req.user.id)
            .order('created_at', { ascending: false }).limit(10);

        if (error) throw error;
        const history = tips.map(t => ({
            sender: t.users.username,
            amount: t.amount,
            message: t.message,
            date: new Date(t.created_at).toLocaleDateString()
        }));
        res.json({ success: true, history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// H. Upload Logo
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, 'uploads/'); },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `user_${req.user.id}_${Date.now()}${ext}`);
    }
});
const upload = multer({ storage: storage });

app.post('/upload-logo', authenticateToken, upload.single('logo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        // ✅ FORCE HTTPS
const fullUrl = `https://${req.get('host')}/uploads/${req.file.filename}`;
        await supabase.from('users').update({ logo_url: fullUrl }).eq('id', req.user.id);
        res.json({ success: true, url: fullUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// I. Serve Overlay HTML
app.get('/overlay/:token', async (req, res) => {
    const { token } = req.params;
    const { data: user } = await supabase.from('users').select('username').eq('obs_token', token).single();
    if (!user) return res.status(404).send("Invalid Overlay Link");
    res.sendFile(path.join(__dirname, 'overlay.html'));
});

// ==========================================
// K. WEBHOOK PAYMENT (Username Edition)
// ==========================================
app.post('/webhook', async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // 1. Validate Signature
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest === req.headers['x-razorpay-signature']) {
        console.log("✅ Valid Webhook received");
        const event = req.body.event;

        if (event === 'payment.captured') {
            const payment = req.body.payload.payment.entity;
            const amount = payment.amount / 100; // Convert Paise -> Rupee
            
            // LOOK FOR USERNAME IN NOTES
            // 'username' must match the field name you created in Razorpay Dashboard
            let targetUser = payment.notes.username || payment.notes.Username;

            console.log(`💰 Payment: ${amount} tokens. Target User: ${targetUser}`);

            if (!targetUser) {
                console.log("❌ No username found in payment notes!");
                return res.json({ status: 'ignored_no_username' });
            }

            try {
                // Find User by USERNAME
                const { data: user } = await supabase
                    .from('users').select('id').eq('username', targetUser).single();

                if (user) {
                    await supabase.rpc('increment_balance', { user_id: user.id, amount: amount });
                    console.log(`✅ Success! Added ${amount} tokens to ${targetUser}`);
                } else {
                    console.log(`❌ User '${targetUser}' does not exist.`);
                }
            } catch (err) { console.error("Database Error:", err); }
        }
        res.json({ status: 'ok' });
    } else {
        res.status(400).send('Invalid signature');
    }
});

// ------------------------------------------
// START SERVER
// ------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

});
