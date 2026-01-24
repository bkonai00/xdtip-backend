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
// SOCKET CONNECTION (The Bridge)
// ------------------------------------------
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // 1. Dashboard/Frontend Join (Standard)
    socket.on('join', (room) => {
        if (room) {
            socket.join(room.toLowerCase());
            console.log(`User joined room: ${room.toLowerCase()}`);
        }
    });

    // 2. Overlay Join (The Fix)
    socket.on('join-overlay', async (token) => {
        if (!token) return;

        try {
            // Ask Database: "Who owns this token?"
            const { data: user } = await supabase
                .from('users')
                .select('username') 
                .eq('obs_token', token) 
                .single();

            if (user && user.username) {
                const roomName = user.username.toLowerCase();
                socket.join(roomName); // ✅ Join the USERNAME room
                console.log(`✅ Overlay (Token: ${token.slice(0,5)}...) bridged to Room: ${roomName}`);
            } else {
                console.log(`❌ Invalid Overlay Token: ${token}`);
            }
        } catch (err) {
            console.error("Overlay Join Error:", err.message);
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

// F. Send Tip (FIXED: Sends to BOTH Username and UUID)
app.post('/tip', authenticateToken, async (req, res) => {
    const { receiverUsername, amount, message } = req.body;
    const senderId = req.user.id;

    if (amount < 10) return res.status(400).json({ error: "Min tip is 10" });

    try {
        // Fetch Receiver with ID (so we can alert their UUID room)
        const { data: receiver } = await supabase.from('users').select('id, balance').eq('username', receiverUsername).single();
        if (!receiver) return res.status(404).json({ error: "Creator not found" });

        const { data: sender } = await supabase.from('users').select('balance').eq('id', senderId).single();
        if (sender.balance < amount) return res.status(400).json({ error: "Insufficient balance" });

        const platformFee = amount * 0.05;
        const creatorShare = amount - platformFee;

        await supabase.rpc('decrement_balance', { user_id: senderId, amount: amount });
        await supabase.rpc('increment_balance', { user_id: receiver.id, amount: creatorShare });
        
        // Save Tip (Make sure your 'tips' table has a 'sender_name' column if you want stats to work perfectly!)
        await supabase.from('tips').insert([{ 
            sender_id: senderId, 
            receiver_id: receiver.id, 
            amount, 
            message,
            sender_name: req.user.username // Optional: if you added this column
        }]);

        // -----------------------------------------------------
        // ⚠️ FIXED ALERT LOGIC
        // -----------------------------------------------------
        const alertData = {
            tipper: req.user.username, // Real Sender Name
            amount: amount,
            message: message
        };

        // 1. Send to Username Room (For Dashboard)
        if (receiverUsername) {
            io.to(receiverUsername.toLowerCase()).emit('new-tip', alertData);
        }

        // 2. Send to User ID Room (For Overlay Link)
        if (receiver && receiver.id) {
            console.log(`Sending alert to UUID room: ${receiver.id}`);
            io.to(receiver.id).emit('new-tip', alertData);
        }

        res.json({ success: true, message: `Sent ${amount} tokens!` });
    } catch (err) {
        console.error("Tip Error:", err);
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

// H. Upload Logo (Supabase Storage)
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

        const { data: publicData } = supabase.storage
            .from('logos')
            .getPublicUrl(filename);

        const fullUrl = publicData.publicUrl;
        await supabase.from('users').update({ logo_url: fullUrl }).eq('id', req.user.id);

        res.json({ success: true, url: fullUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// I. SERVE OVERLAY (Dynamic Theme Selector)
// ==========================================
app.get('/overlay/:token', async (req, res) => {
    const { token } = req.params;
    
    // 1. Check which theme the user selected in DB
    const { data: user } = await supabase
        .from('users')
        .select('overlay_theme')
        .eq('obs_token', token)
        .single();

    // Default to 'overlay.html' (Classic)
    let fileToSend = 'overlay.html'; 

    if (user) {
        if (user.overlay_theme === 'neon') fileToSend = 'overlay_neon.html';
        if (user.overlay_theme === 'minimal') fileToSend = 'overlay_minimal.html';
        if (user.overlay_theme === 'vip') fileToSend = 'overlay_vip.html';
    }

    // 2. Serve the correct file
    res.sendFile(path.join(__dirname, fileToSend));
});

// ==========================================
// M. TEST ALERT (New Feature)
// ==========================================
app.post('/test-alert', authenticateToken, (req, res) => {
    const username = req.user.username;

    // Create a Fake Tip Object
    const fakeTip = {
        tipper: "Test Bot",
        amount: 69,
        message: "This is a test alert!, यह एक परीक्षण चेतावनी है!, 🤣😁😅🥲❤️‍🔥!. 🔥"
    };

    console.log(`🚀 Sending Test Alert to room: ${username}`);
    
    // Send to the User's Room (The Overlay listens to this)
    io.to(username.toLowerCase()).emit('new-tip', fakeTip);

    res.json({ success: true, message: "Test Alert Sent!" });
});

// J. Request Withdrawal
app.post('/withdraw', authenticateToken, async (req, res) => {
    const { amount, upiId } = req.body;
    const userId = req.user.id;

    if (amount < 0) return res.status(400).json({ error: "THANK YOU FOR USING XDTIP" });

    try {
        const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();
        
        if (user.balance < amount) return res.status(400).json({ error: "Insufficient balance" });

        // Deduct Balance
        const { error: balError } = await supabase.rpc('decrement_balance', { user_id: userId, amount: amount });
        if (balError) throw balError;

        // Create Request (Linked to public.users)
        const { error: reqError } = await supabase
            .from('withdrawals')
            .insert([{ user_id: userId, amount, upi_id: upiId }]);

        if (reqError) throw reqError;

        res.json({ success: true, message: "Withdrawal Requested! Admin will process it." });
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

// L. WEBHOOK PAYMENT (Razorpay)
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
            const amount = payment.amount / 100;
            const paymentId = payment.id;
            
            // LOOK FOR USERNAME IN NOTES
            let targetUser = payment.notes.username || payment.notes.Username;

            if (!targetUser) {
                console.log("❌ No username found in notes!");
                return res.json({ status: 'ignored' });
            }

            try {
                const { data: user } = await supabase
                    .from('users').select('id').eq('username', targetUser).single();

                if (user) {
                    // A. Add Balance
                    const { error: rpcError } = await supabase.rpc('increment_balance', { user_id: user.id, amount: amount });
                    if (rpcError) {
                        console.error("❌ Balance Update Failed:", rpcError.message);
                    } else {
                        console.log(`✅ Balance updated for ${targetUser}`);
                    }
                    
                    // B. Save Transaction
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
        res.json({ status: 'ok' });
    } else {
        res.status(400).send('Invalid signature');
    }
});

// ==========================================
// H. STATS API (Calculates Top 3 & Latest)
// ==========================================
app.get('/stats/:token', async (req, res) => {
    const { token } = req.params;

    try {
        // 1. Get User ID from Token
        const { data: user } = await supabase
            .from('users')
            .select('id')
            .eq('obs_token', token)
            .single();

        if (!user) return res.status(404).json({ error: "User not found" });

        // 2. Get Latest 3 Tips (For the list)
        const { data: latest } = await supabase
            .from('tips')
            .select('sender_name, amount') // Ensure your column is named 'sender_name'
            .eq('receiver_id', user.id)
            .order('created_at', { ascending: false })
            .limit(3);

        // 3. Get Top 3 Tippers (For the Rotator)
        const { data: top } = await supabase
            .from('tips')
            .select('sender_name, amount')
            .eq('receiver_id', user.id)
            .order('amount', { ascending: false })
            .limit(3);

        res.json({
            top: top || [], 
            latest: latest || []
        });

    } catch (err) {
        console.error("Stats Error:", err);
        res.status(500).json({ error: "Stats failed" });
    }
});

// ==========================================
// S. SERVE STATS OVERLAY (Dynamic Theme)
// ==========================================
app.get('/stats-overlay/:token', async (req, res) => {
    const { token } = req.params;

    // 1. Check which theme the user selected in DB
    const { data: user } = await supabase
        .from('users')
        .select('overlay_theme')
        .eq('obs_token', token)
        .single();

    // Default to 'overlay_stats.html' (Classic/Gold)
    let fileToSend = 'overlay_stats.html'; 

    if (user) {
        if (user.overlay_theme === 'neon') fileToSend = 'overlay_stats_neon.html';
        if (user.overlay_theme === 'minimal') fileToSend = 'overlay_stats_minimal.html';
        // VIP Theme uses the Gold/Classic stats because it matches perfectly
        if (user.overlay_theme === 'vip') fileToSend = 'overlay_stats_vip.html';
    }

    // 2. Serve the correct file
    res.sendFile(path.join(__dirname, fileToSend));
});

// ==========================================
// Z. ADMIN PANEL ROUTES
// ==========================================

// Middleware: Check if user is Admin
// Middleware: Check if user is Admin (Database Verified)
const requireAdmin = async (req, res, next) => {
    try {
        // 1. Fetch the user's LATEST role from the database
        const { data: user, error } = await supabase
            .from('users')
            .select('role')
            .eq('id', req.user.id)
            .single();

        // 2. Check if valid
        if (error || !user) {
            console.log("Admin Check Error:", error);
            return res.status(403).json({ error: "User verify failed" });
        }

        // 3. Verify 'admin' status
        if (user.role !== 'admin') {
            console.log(`User ${req.user.id} tried to access admin but is role: ${user.role}`);
            return res.status(403).json({ error: "Access Denied: Admins Only" });
        }

        next(); // Success! Let them pass.

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server Error" });
    }
};

// 1. Get All Withdrawals (Updated for User Details)
app.get('/admin/withdrawals', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { data: requests, error } = await supabase
            .from('withdrawals')
            // 👇 KEY CHANGE: Added 'email' and 'balance' here!
            .select('id, t_id, amount, upi_id, status, created_at, users:user_id (username, email, balance)')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, requests });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// 2. Process Payout (Approve/Reject)
app.post('/admin/payout', authenticateToken, requireAdmin, async (req, res) => {
    // 👇 We receive 'manual_t_id' from the frontend now
    const { withdrawal_id, status, manual_t_id } = req.body; 

    try {
        // Prepare the update data
        let updateData = { status: status };
        
        // If the admin typed a Transaction ID, save it to 't_id'
        if (manual_t_id) {
            updateData.t_id = manual_t_id;
        }

        // A. Update the withdrawal in Database
        const { data: withdrawal, error } = await supabase
            .from('withdrawals')
            .update(updateData)
            .eq('id', withdrawal_id) // ⚠️ MATCH BY 'id' (Row ID), NOT 't_id'
            .select()
            .single();

        if (error) throw error;

        // B. If Rejected, REFUND the money
        if (status === 'rejected') {
            await supabase.rpc('increment_balance', { 
                user_id: withdrawal.user_id, 
                amount: withdrawal.amount 
            });
            console.log(`Refunded ${withdrawal.amount} to user ${withdrawal.user_id}`);
        }

        res.json({ success: true, message: `Request marked as ${status}` });

    } catch (err) {
        console.error("Payout Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Get Specific User Details (Read-Only)
app.get('/admin/user/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Fetch User Profile
        const { data: user, error } = await supabase
            .from('users')
            .select('id, username, email, role, balance, created_at, overlay_theme')
            .eq('id', id)
            .single();

        if (error) throw error;

        // Optional: Calculate Total Tips Received
        const { count } = await supabase
            .from('tips')
            .select('*', { count: 'exact', head: true })
            .eq('receiver_id', id);

        // Send combined data
        res.json({ 
            success: true, 
            user: { ...user, total_tips_received: count } 
        });
        // ---------------------------------------------------------
// 4. Get ALL Users List (For Admin Panel Table)
// ---------------------------------------------------------
app.get('/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // Fetch specific fields for all users
        const { data: users, error } = await supabase
            .from('users')
            .select('id, username, email, balance, role, created_at')
            .order('created_at', { ascending: false }); // Show newest users first

        if (error) throw error;

        // Send the list to the frontend
        res.json({ success: true, users });
        
    } catch (err) {
        console.error("Error fetching users:", err);
        res.status(500).json({ error: err.message });
    }
});

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// START SERVER
// ------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});











