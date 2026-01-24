// ==========================================
// XDTIP BACKEND SERVER (Final Master Version)
// ==========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

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

// ------------------------------------------
// AUTHENTICATION CHECKER (Middleware)
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
// ADMIN CHECKER (Middleware)
// ------------------------------------------
const requireAdmin = async (req, res, next) => {
    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('role')
            .eq('id', req.user.id)
            .single();

        if (error || !user) return res.status(403).json({ error: "User verify failed" });

        if (user.role !== 'admin') {
            return res.status(403).json({ error: "Access Denied: Admins Only" });
        }

        next();
    } catch (err) {
        return res.status(500).json({ error: "Server Error" });
    }
};

// ------------------------------------------
// SOCKET CONNECTION (The Bridge)
// ------------------------------------------
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // 1. Dashboard/Frontend Join
    socket.on('join', (room) => {
        if (room) {
            socket.join(room.toLowerCase());
            console.log(`User joined room: ${room.toLowerCase()}`);
        }
    });

    // 2. Overlay Join
    socket.on('join-overlay', async (token) => {
        if (!token) return;
        try {
            const { data: user } = await supabase
                .from('users')
                .select('username') 
                .eq('obs_token', token) 
                .single();

            if (user && user.username) {
                const roomName = user.username.toLowerCase();
                socket.join(roomName); 
                console.log(`✅ Overlay bridged to Room: ${roomName}`);
            }
        } catch (err) {
            console.error("Overlay Join Error:", err.message);
        }
    });
});

// ------------------------------------------
// API ROUTES
// ------------------------------------------

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
            .select('id, username, role, balance, obs_token, logo_url, overlay_theme') 
            .eq('id', req.user.id).single();
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Overlay Theme
app.post('/update-theme', authenticateToken, async (req, res) => {
    const { theme } = req.body;
    try {
        await supabase.from('users').update({ overlay_theme: theme }).eq('id', req.user.id);
        res.json({ success: true, message: "Theme Updated!" });
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

        const platformFee = amount * 0.05;
        const creatorShare = amount - platformFee;

        await supabase.rpc('decrement_balance', { user_id: senderId, amount: amount });
        await supabase.rpc('increment_balance', { user_id: receiver.id, amount: creatorShare });
        
        await supabase.from('tips').insert([{ 
            sender_id: senderId, 
            receiver_id: receiver.id, 
            amount, 
            message,
            sender_name: req.user.username 
        }]);

        const alertData = {
            tipper: req.user.username,
            amount: amount,
            message: message
        };

        if (receiverUsername) io.to(receiverUsername.toLowerCase()).emit('new-tip', alertData);
        if (receiver && receiver.id) io.to(receiver.id).emit('new-tip', alertData);

        res.json({ success: true, message: `Sent ${amount} tokens!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// G. Get Tip History
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
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/upload-logo', authenticateToken, upload.single('logo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const cleanName = req.file.originalname.replace(/[^a-zA-Z0-9.]/g, '');
        const filename = `user_${req.user.id}_${Date.now()}_${cleanName}`;

        const { error } = await supabase.storage
            .from('logos')
            .upload(filename, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true
            });

        if (error) throw error;

        const { data: publicData } = supabase.storage.from('logos').getPublicUrl(filename);
        const fullUrl = publicData.publicUrl;
        await supabase.from('users').update({ logo_url: fullUrl }).eq('id', req.user.id);

        res.json({ success: true, url: fullUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// I. SERVE OVERLAY
app.get('/overlay/:token', async (req, res) => {
    const { token } = req.params;
    const { data: user } = await supabase.from('users').select('overlay_theme').eq('obs_token', token).single();

    let fileToSend = 'overlay.html'; 
    if (user) {
        if (user.overlay_theme === 'neon') fileToSend = 'overlay_neon.html';
        if (user.overlay_theme === 'minimal') fileToSend = 'overlay_minimal.html';
        if (user.overlay_theme === 'vip') fileToSend = 'overlay_vip.html';
    }
    res.sendFile(path.join(__dirname, fileToSend));
});

// M. TEST ALERT
app.post('/test-alert', authenticateToken, (req, res) => {
    const username = req.user.username;
    const fakeTip = {
        tipper: "Test Bot",
        amount: 69,
        message: "This is a test alert! 🔥"
    };
    io.to(username.toLowerCase()).emit('new-tip', fakeTip);
    res.json({ success: true, message: "Test Alert Sent!" });
});

// J. Request Withdrawal
app.post('/withdraw', authenticateToken, async (req, res) => {
    const { amount, upiId } = req.body;
    const userId = req.user.id;

    if (amount < 0) return res.status(400).json({ error: "Invalid amount" });

    try {
        const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();
        if (user.balance < amount) return res.status(400).json({ error: "Insufficient balance" });

        const { error: balError } = await supabase.rpc('decrement_balance', { user_id: userId, amount: amount });
        if (balError) throw balError;

        const { error: reqError } = await supabase
            .from('withdrawals')
            .insert([{ user_id: userId, amount, upi_id: upiId }]);

        if (reqError) throw reqError;

        res.json({ success: true, message: "Withdrawal Requested!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// K. Get Withdrawal History
app.get('/withdrawals', authenticateToken, async (req, res) => {
    try {
        const { data: withdrawals, error } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        const history = withdrawals.map(w => ({
            t_id: w.t_id,
            amount: w.amount,
            status: w.status,
            date: new Date(w.created_at).toLocaleDateString()
        }));
        res.json({ success: true, history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// L. WEBHOOK PAYMENT
app.post('/webhook', async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest === req.headers['x-razorpay-signature']) {
        const event = req.body.event;
        if (event === 'payment.captured') {
            const payment = req.body.payload.payment.entity;
            const amount = payment.amount / 100;
            const paymentId = payment.id;
            let targetUser = payment.notes.username || payment.notes.Username;

            if (targetUser) {
                try {
                    const { data: user } = await supabase.from('users').select('id').eq('username', targetUser).single();
                    if (user) {
                        await supabase.rpc('increment_balance', { user_id: user.id, amount: amount });
                        await supabase.from('transactions').insert([{
                            user_id: user.id,
                            amount: amount,
                            razorpay_payment_id: paymentId,
                            type: 'deposit',
                            status: 'success'
                        }]);
                    }
                } catch (err) { console.error("Database Error:", err); }
            }
        }
        res.json({ status: 'ok' });
    } else {
        res.status(400).send('Invalid signature');
    }
});

// H. STATS API
app.get('/stats/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const { data: user } = await supabase.from('users').select('id').eq('obs_token', token).single();
        if (!user) return res.status(404).json({ error: "User not found" });

        const { data: latest } = await supabase
            .from('tips').select('sender_name, amount')
            .eq('receiver_id', user.id).order('created_at', { ascending: false }).limit(3);

        const { data: top } = await supabase
            .from('tips').select('sender_name, amount')
            .eq('receiver_id', user.id).order('amount', { ascending: false }).limit(3);

        res.json({ top: top || [], latest: latest || [] });
    } catch (err) {
        res.status(500).json({ error: "Stats failed" });
    }
});

// S. SERVE STATS OVERLAY
app.get('/stats-overlay/:token', async (req, res) => {
    const { token } = req.params;
    const { data: user } = await supabase.from('users').select('overlay_theme').eq('obs_token', token).single();

    let fileToSend = 'overlay_stats.html'; 
    if (user) {
        if (user.overlay_theme === 'neon') fileToSend = 'overlay_stats_neon.html';
        if (user.overlay_theme === 'minimal') fileToSend = 'overlay_stats_minimal.html';
        if (user.overlay_theme === 'vip') fileToSend = 'overlay_stats_vip.html';
    }
    res.sendFile(path.join(__dirname, fileToSend));
});

// ==========================================
// Z. ADMIN PANEL ROUTES
// ==========================================

// 1. Get All Withdrawals
app.get('/admin/withdrawals', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { data: requests, error } = await supabase
            .from('withdrawals')
            .select('id, t_id, amount, upi_id, status, created_at, users:user_id (username, email, balance)')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, requests });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Process Payout
app.post('/admin/payout', authenticateToken, requireAdmin, async (req, res) => {
    const { withdrawal_id, status, manual_t_id } = req.body; 
    try {
        let updateData = { status: status };
        if (manual_t_id) updateData.t_id = manual_t_id;

        const { data: withdrawal, error } = await supabase
            .from('withdrawals')
            .update(updateData)
            .eq('id', withdrawal_id)
            .select().single();

        if (error) throw error;

        if (status === 'rejected') {
            await supabase.rpc('increment_balance', { 
                user_id: withdrawal.user_id, 
                amount: withdrawal.amount 
            });
        }
        res.json({ success: true, message: `Request marked as ${status}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Get Specific User Details
app.get('/admin/user/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { data: user, error } = await supabase
            .from('users')
            .select('id, username, email, role, balance, created_at, overlay_theme')
            .eq('id', id)
            .single();

        if (error) throw error;

        const { count } = await supabase
            .from('tips')
            .select('*', { count: 'exact', head: true })
            .eq('receiver_id', id);

        res.json({ success: true, user: { ...user, total_tips_received: count } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Get ALL Users (For Admin Panel)
app.get('/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, username, email, balance, role, created_at, overlay_theme')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
