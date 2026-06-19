const fs = require('fs');
const content = fs.readFileSync('server/routes.ts', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('/api/auth') || line.includes('/register') || line.includes('/signup') || line.includes('access-requests')) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
