const fs = require('fs');
const path = "lib/attendance-api.ts";
let content = fs.readFileSync(path, "utf8");

const newEndpoints = `
// --- Users ---
export async function getUsersRemote(): Promise<{ id: string, name: string, email: string }[]> {
  const data = await fetchJson("/users", { method: "GET" });
  return data.items || [];
}

// --- Collective Leaves ---
export async function createCollectiveLeaveRemote(data: any): Promise<any> {
  return fetchJson("/collective-leaves", {
    method: "POST",
    body: JSON.stringify(data),
  });
}
`;

if (!content.includes("getUsersRemote")) {
  content += "\n" + newEndpoints;
  fs.writeFileSync(path, content, "utf8");
  console.log("attendance-api.ts patched");
} else {
  console.log("Already patched");
}
