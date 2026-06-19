const fs = require('fs');
const content = fs.readFileSync('app/(tabs)/attendance.tsx', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('present out of') || line.includes('collapsed') || line.includes('unassigned') || line.includes('expand') || line.includes('Company') || line.includes('activeTab') || line.includes('no_activity')) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
