const io = require("socket.io-client");

// Connect to your server
const socket = io("http://localhost:3000");

const creatorUsername = "creator1"; // The creator listening for tips

socket.on("connect", () => {
  console.log("Connected to Server! ID:", socket.id);
  
  // Join the creator's room
  socket.emit("join-room", creatorUsername);
  console.log(`Listening for tips for: ${creatorUsername}...`);
});

// When a tip comes in, print it!
socket.on("new-tip", (data) => {
  console.log("\n🚨 NEW TIP ALERT! 🚨");
  console.log(`From: ${data.sender}`);
  console.log(`Amount: ${data.amount}`);
  console.log(`Message: ${data.message}`);
});