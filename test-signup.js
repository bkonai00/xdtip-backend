// This script simulates a user trying to sign up
const registerUser = async () => {
  const response = await fetch('http://localhost:3000/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: "StreamerTest",
      email: "streamer@test.com",
      password: "password123",
      role: "creator"
    })
  });

  const data = await response.json();
  console.log(data);
};

registerUser();