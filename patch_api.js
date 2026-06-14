const fs = require('fs');
const path = "lib/attendance-api.ts";
let content = fs.readFileSync(path, "utf8");

const newApiFunctions = `
// --- Calendar Admin Endpoints ---
export async function addPublicHolidayRemote(data: { day: number, month: number, year?: number, code?: string, dayRule?: string }): Promise<any> {
  return fetchJson("/public-holidays", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deletePublicHolidayRemote(id: string): Promise<any> {
  return fetchJson(\`/public-holidays/\${id}\`, {
    method: "DELETE",
  });
}

export async function getWeekendConfigRemote(): Promise<{ weekendDays: number[] }> {
  return fetchJson("/weekend-config", { method: "GET" });
}

export async function saveWeekendConfigRemote(weekendDays: number[]): Promise<any> {
  return fetchJson("/weekend-config", {
    method: "POST",
    body: JSON.stringify({ weekendDays }),
  });
}
`;

if (!content.includes("addPublicHolidayRemote")) {
  content += "\n" + newApiFunctions;
  fs.writeFileSync(path, content, "utf8");
  console.log("Appended new api functions to lib/attendance-api.ts");
} else {
  console.log("API functions already exist");
}
