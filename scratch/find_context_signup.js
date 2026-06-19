const fs = require('fs');
const content = fs.readFileSync('contexts/AuthContext.tsx', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('signup') || line.includes('register')) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
