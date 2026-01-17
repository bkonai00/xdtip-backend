const API_URL = "http://localhost:3000";

// 1. LOGIN DETAILS (SENDER)
// We log in as testuser1 to send the money
const loginData = {
    email: "test@example.com",  // Ensure this user exists!
    password: "mypassword123"
};

// 2. TIP DETAILS (RECEIVER)
// Who gets the money? (Your Creator Account)
const tipData = {
    receiverUsername: "StreamerTest", // <--- Make sure this matches your Dashboard username
    amount: 100,
    message: "Wow! testuser1 just dropped 500 tokens! HYPE!"
};

async function runTest() {
    console.log(`🔄 Attempting login for ${loginData.email}...`);

    try {
        // STEP 1: LOGIN
        const loginRes = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(loginData)
        });
        const loginJson = await loginRes.json();
        
        if (!loginJson.success) {
            console.error("❌ Login failed:", loginJson.error);
            console.log("💡 HINT: Did you register 'testuser1@example.com' via register.html yet?");
            return;
        }

        const token = loginJson.token;
        console.log("✅ Login Successful! Sending tip...");

        // STEP 2: SEND TIP
        const tipRes = await fetch(`${API_URL}/tip`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` // Attach the sender's token
            },
            body: JSON.stringify(tipData)
        });

        const tipJson = await tipRes.json();
        
        if (tipJson.success) {
            console.log("🚀 TIP SENT!");
            console.log(tipJson);
        } else {
            console.error("❌ Tip Failed:", tipJson.error);
        }

    } catch (err) {
        console.error("Error:", err);
    }
}

runTest();