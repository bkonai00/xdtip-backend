const loginUser = async () => {
  const response = await fetch('http://localhost:3000/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: "test@example.com",     // Must match what you used in signup
      password: "mypassword123"      // Must match what you used in signup
    })
  });

  const data = await response.json();
  console.log(data);
};

loginUser();