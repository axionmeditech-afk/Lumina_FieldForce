const fs = require('fs');
const content = fs.readFileSync('app/login.tsx', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('register') || line.includes('access') || line.includes('signup') || line.includes('check')) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
