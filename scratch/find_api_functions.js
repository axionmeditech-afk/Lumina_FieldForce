const fs = require('fs');
const content = fs.readFileSync('lib/attendance-api.ts', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('export async function') && line.includes('attendance')) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
