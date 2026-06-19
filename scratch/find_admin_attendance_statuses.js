const fs = require('fs');
const content = fs.readFileSync('app/(tabs)/attendance.tsx', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('adminAttendanceStatuses')) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
